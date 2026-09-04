import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BrowserWindow } from 'electron';
import { acceptDocumentCandidate, dispatchDocumentRun } from './documents.js';
import { askAnnotation, readAnnotations, saveAnnotation } from './document-annotations.js';
import type {
  DocumentAnnotation,
  DocumentAnnotationEvent,
  DocumentRunEvent,
  DocumentRunRecord,
} from './shared-types.js';

/**
 * Drives the real `claude` CLI through one proposal and one resumed follow-up.
 * Costs a few API calls, so it only runs when explicitly asked for:
 *   RUN_REAL_CLAUDE_DOC_TEST=1 npx vitest run electron/ipc/documents.real-claude.integration.test.ts
 */
const RUN = process.env.RUN_REAL_CLAUDE_DOC_TEST === '1';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const DOC = [
  '# Notes',
  '',
  'Intro stays as it is.',
  '',
  '## Weather',
  '',
  'The weather is nice.',
  '',
  '## Closing',
  '',
  'Bye.',
  '',
].join('\n');

describe.skipIf(!RUN)('document workspace with the real claude CLI', () => {
  let root: string;
  const events: DocumentRunEvent[] = [];
  const annotationEvents: DocumentAnnotationEvent[] = [];
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (ch: string, payload: DocumentRunEvent | DocumentAnnotationEvent) => {
        if (ch === 'document_annotation_event')
          annotationEvents.push(payload as DocumentAnnotationEvent);
        else events.push(payload as DocumentRunEvent);
      },
    },
  } as unknown as BrowserWindow;

  function waitForRun(runId: string): Promise<DocumentRunRecord> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const done = events.find(
          (e): e is Extract<DocumentRunEvent, { type: 'run' }> =>
            e.type === 'run' && e.run.id === runId && e.run.status !== 'running',
        );
        if (done) return resolve(done.run);
        if (Date.now() - started > 240_000) return reject(new Error('run did not finish'));
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  beforeAll(() => {
    process.env.GIT_AUTHOR_NAME ??= 'Test';
    process.env.GIT_AUTHOR_EMAIL ??= 'test@example.com';
    process.env.GIT_COMMITTER_NAME ??= 'Test';
    process.env.GIT_COMMITTER_EMAIL ??= 'test@example.com';
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-docws-real-'));
    git(root, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(root, 'notes.md'), DOC);
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'initial');
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('proposes, accepts, then resumes the main session with the catch-up diff', async () => {
    const first = await dispatchDocumentRun(win, {
      projectRoot: root,
      documentPath: 'notes.md',
      instruction:
        'Replace the sentence in this section with exactly: "The weather is stormy today." Keep the heading.',
      scope: {
        wholeDocument: false,
        startLine: 5,
        endLine: 7,
        quote: '## Weather\n\nThe weather is nice.',
        heading: 'Weather',
      },
      candidates: [
        {
          id: 'c1',
          label: 'A',
          agentId: 'claude-code',
          agentName: 'Claude Code',
          command: 'claude',
          isMain: true,
        },
      ],
    });
    const done = await waitForRun(first.id);
    const c = done.candidates[0];
    expect(c.status, c.error).toBe('done');
    expect(c.sessionId).toBeTruthy();
    expect(c.commitSha).toBeTruthy();
    expect(c.outOfScopeFiles ?? []).toEqual([]);
    expect(c.rationale?.summary).toBeTruthy();
    const proposed = git(root, 'show', `${c.commitSha}:notes.md`);
    expect(proposed).toContain('stormy');
    expect(proposed).toContain('Intro stays as it is.');

    await acceptDocumentCandidate(root, first.id, 'c1');
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toContain('stormy');

    // Second turn resumes the same session; it must answer from memory of the
    // instruction it was given while seeing the accepted document.
    const second = await dispatchDocumentRun(win, {
      projectRoot: root,
      documentPath: 'notes.md',
      instruction:
        'In this section, add one more sentence after the existing one that repeats, in quotes, the exact sentence you were asked to insert in your previous turn.',
      scope: {
        wholeDocument: false,
        startLine: 5,
        endLine: 7,
        quote: '## Weather\n\nThe weather is stormy today.',
        heading: 'Weather',
      },
      candidates: [
        {
          id: 'c1',
          label: 'A',
          agentId: 'claude-code',
          agentName: 'Claude Code',
          command: 'claude',
          isMain: true,
          sessionId: c.sessionId,
          sessionLastSha: first.baseSha,
        },
      ],
    });
    const done2 = await waitForRun(second.id);
    const c2 = done2.candidates[0];
    expect(c2.status, c2.error).toBe('done');
    expect(c2.sessionId).toBe(c.sessionId);
    expect(c2.commitSha).toBeTruthy();
    const proposed2 = git(root, 'show', `${c2.commitSha}:notes.md`);
    expect(proposed2).toContain('The weather is stormy today.');
    expect(proposed2.match(/stormy/g)?.length).toBeGreaterThanOrEqual(2);
  }, 300_000);

  it('answers a question about a passage without touching the document', async () => {
    const before = fs.readFileSync(path.join(root, 'notes.md'), 'utf8');
    const head = git(root, 'rev-parse', 'HEAD').trim();
    await saveAnnotation(root, {
      id: 'q-real-1',
      kind: 'question',
      text: 'In one short sentence: what is the weather in this passage? Do not edit anything.',
      anchor: {
        path: 'notes.md',
        baseSha: head,
        startLine: 5,
        endLine: 7,
        quote: '## Weather\n\nThe weather is stormy today.',
        prefix: 'Intro stays as it is.',
        suffix: '## Closing',
        heading: 'Weather',
      },
      createdAt: new Date().toISOString(),
    });
    await askAnnotation(win, {
      projectRoot: root,
      documentPath: 'notes.md',
      annotationId: 'q-real-1',
      agentId: 'claude-code',
      agentName: 'Claude Code',
      command: 'claude',
    });
    const answered = await new Promise<DocumentAnnotation>((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const done = annotationEvents.find(
          (e) => e.annotation.id === 'q-real-1' && e.annotation.answerStatus !== 'pending',
        );
        if (done) return resolve(done.annotation);
        if (Date.now() - started > 240_000) return reject(new Error('no answer'));
        setTimeout(tick, 250);
      };
      tick();
    });
    expect(answered.answerStatus, answered.answerError).toBe('answered');
    expect(answered.answer?.text.toLowerCase()).toContain('storm');
    expect(readAnnotations(root).find((a) => a.id === 'q-real-1')?.answer?.text).toBeTruthy();
    // Read-only: no file changed, no commit made.
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe(before);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(git(root, 'status', '--porcelain', '--', 'notes.md').trim()).toBe('');
  }, 300_000);
});
