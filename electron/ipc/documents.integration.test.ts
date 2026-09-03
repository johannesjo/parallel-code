import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BrowserWindow } from 'electron';
import {
  acceptDocumentCandidate,
  dispatchDocumentRun,
  getDocumentAtCommit,
  getDocumentDiff,
  getDocumentHistory,
  listDocumentFiles,
  listDocumentRuns,
  readDocumentSnapshot,
  rejectDocumentRun,
} from './documents.js';
import type { DocumentRunEvent, DocumentRunRecord } from './shared-types.js';

/**
 * Exercises the whole proposal lifecycle against a real temporary repository
 * with a fake "claude" script standing in for the CLI: it rewrites the scoped
 * passage, touches a file outside scope, and prints a stream-json result.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const DOC = [
  '# Spec',
  '',
  'Intro paragraph.',
  '',
  '## Goals',
  '',
  'Old goals text.',
  '',
  '## Later',
  '',
  'Untouched.',
  '',
].join('\n');

let root: string;
let fakeAgent: string;
const events: DocumentRunEvent[] = [];
const win = {
  isDestroyed: () => false,
  webContents: { send: (_ch: string, payload: DocumentRunEvent) => events.push(payload) },
} as unknown as BrowserWindow;

function waitForRunFinish(runId: string): Promise<DocumentRunRecord> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const done = events.find(
        (e): e is Extract<DocumentRunEvent, { type: 'run' }> =>
          e.type === 'run' && e.run.id === runId && e.run.status !== 'running',
      );
      if (done) return resolve(done.run);
      if (Date.now() - started > 20_000) return reject(new Error('run did not finish'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
  process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-docws-'));
  git(root, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'spec.md'), DOC);
  fs.writeFileSync(path.join(root, 'README.md'), '# Readme\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'initial');

  // The fake CLI lives outside the repo so it never shows up as a change.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-docws-bin-'));
  fakeAgent = path.join(binDir, 'fake-claude.sh');
  fs.writeFileSync(
    fakeAgent,
    [
      '#!/bin/sh',
      'sed -i.bak "s/Old goals text./New goals text, sharper./" docs/spec.md && rm -f docs/spec.md.bak',
      'echo "stray" > STRAY.txt',
      'printf \'%s\\n\' \'{"type":"system","subtype":"init","session_id":"sess-1"}\'',
      'printf \'%s\\n\' \'{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"docs/spec.md"}}]}}\'',
      'printf \'%s\\n\' \'{"type":"result","subtype":"success","session_id":"sess-1","result":"Done.\\n```json\\n{\\"summary\\":\\"Sharpened the goals\\",\\"changes\\":[\\"rewrote goals\\"],\\"questions\\":[\\"ok?\\"]}\\n```"}\'',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('document workspace lifecycle', () => {
  it('lists tracked markdown files', async () => {
    expect(await listDocumentFiles(root)).toEqual(['README.md', 'docs/spec.md']);
  });

  it('reads a snapshot', async () => {
    const snap = await readDocumentSnapshot(root, 'docs/spec.md');
    expect(snap.content).toBe(DOC);
    expect(snap.branch).toBe('main');
    expect(snap.dirty).toBe(false);
    expect(snap.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('commits pending edits, runs a candidate in a worktree, strips out-of-scope files and commits a proposal', async () => {
    // A pending manual edit must become the base.
    fs.appendFileSync(path.join(root, 'README.md'), 'manual\n');
    const run = await dispatchDocumentRun(win, {
      projectRoot: root,
      documentPath: 'docs/spec.md',
      instruction: 'Sharpen the goals.',
      scope: {
        wholeDocument: false,
        startLine: 5,
        endLine: 7,
        quote: '## Goals\n\nOld goals text.',
        heading: 'Goals',
      },
      candidates: [
        {
          id: 'c1',
          label: 'A',
          agentId: 'claude-code',
          agentName: 'Fake Claude',
          command: fakeAgent,
          isMain: true,
        },
      ],
    });
    expect(run.status).toBe('running');
    expect(git(root, 'log', '--format=%s', '-n', '1').trim()).toBe('Manual edits');
    expect(run.baseSha).toBe(git(root, 'rev-parse', 'HEAD').trim());

    const finished = await waitForRunFinish(run.id);
    const c = finished.candidates[0];
    const proposalSha = String(c.commitSha);
    expect(c.status).toBe('done');
    expect(c.sessionId).toBe('sess-1');
    expect(c.rationale?.summary).toBe('Sharpened the goals');
    expect(c.rationale?.questions).toEqual(['ok?']);
    expect(c.outOfScopeFiles).toEqual(['STRAY.txt']);
    expect(c.outOfScopeHunks).toBeUndefined();
    expect(c.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(c.worktreePath).toBe(path.join(root, '.worktrees', 'parallel-doc-main'));
    expect(events.some((e) => e.type === 'log' && e.text.includes('Edit docs/spec.md'))).toBe(true);

    // The proposal commit carries only the document and readable trailers.
    const files = git(root, 'show', '--format=', '--name-only', proposalSha).trim();
    expect(files).toBe('docs/spec.md');
    const message = git(root, 'show', '-s', '--format=%B', proposalSha);
    expect(message).toContain('Sharpened the goals');
    expect(message).toContain('Parallel-Agent: Fake Claude');
    expect(message).toContain('Parallel-Scope: docs/spec.md#L5-L7');
    expect(message).toContain(`Parallel-Base: ${run.baseSha}`);

    // The canonical document is untouched until acceptance.
    expect(fs.readFileSync(path.join(root, 'docs', 'spec.md'), 'utf8')).toBe(DOC);
    expect(await getDocumentAtCommit(root, proposalSha, 'docs/spec.md')).toContain(
      'New goals text',
    );
    expect(await getDocumentDiff(root, run.baseSha, proposalSha, 'docs/spec.md')).toContain(
      '+New goals text',
    );

    // Records are persisted and reloadable.
    const listed = listDocumentRuns(root);
    expect(listed.map((r) => r.id)).toEqual([run.id]);
    expect(listed[0].status).toBe('finished');

    // Accept: one squashed integration commit with the run record.
    const { sha } = await acceptDocumentCandidate(root, run.id, 'c1');
    expect(sha).toBe(git(root, 'rev-parse', 'HEAD').trim());
    expect(fs.readFileSync(path.join(root, 'docs', 'spec.md'), 'utf8')).toContain('New goals text');
    const accepted = git(root, 'show', '--format=%B', '--name-only', sha);
    expect(accepted).toContain('Parallel-Run: ' + run.id);
    expect(accepted).toContain('Parallel-Candidate: A');
    expect(accepted).toContain('docs/spec.md');
    expect(accepted).toContain(`.parallel/runs/${run.id}.json`);
    expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('3');
    expect(listDocumentRuns(root)[0].status).toBe('accepted');
    await expect(acceptDocumentCandidate(root, run.id, 'c1')).rejects.toThrow(/already accepted/);

    // History for the document parses trailers and marks manual commits.
    const history = await getDocumentHistory(root, 'docs/spec.md', false);
    expect(history.map((h) => h.manual)).toEqual([false, true]);
    expect(history[0].trailers.Agent).toBe('Fake Claude');
    expect(history[0].body).not.toContain('Parallel-');
    const whole = await getDocumentHistory(root, 'docs/spec.md', true);
    expect(whole).toHaveLength(3);
  });

  it('marks a proposal stale when the base moved and it conflicts, and rejects cleanly otherwise', async () => {
    const run = await dispatchDocumentRun(win, {
      projectRoot: root,
      documentPath: 'docs/spec.md',
      instruction: 'Again.',
      scope: { wholeDocument: true, startLine: 1, endLine: 1, quote: '' },
      candidates: [
        {
          id: 'c1',
          label: 'A',
          agentId: 'claude-code',
          agentName: 'Fake Claude',
          command: fakeAgent,
          isMain: false,
        },
      ],
    });
    const finished = await waitForRunFinish(run.id);
    // The fake edit no longer matches (text already replaced) so nothing changes.
    expect(finished.candidates[0].noChanges).toBe(true);
    expect(finished.candidates[0].commitSha).toBeNull();
    await expect(acceptDocumentCandidate(root, run.id, 'c1')).rejects.toThrow(/no change/);
    const rejected = await rejectDocumentRun(root, run.id);
    expect(rejected.status).toBe('rejected');
    expect(fs.existsSync(finished.candidates[0].worktreePath)).toBe(false);
    expect(git(root, 'branch', '--list', finished.candidates[0].branch).trim()).toBe('');
    // The rejection is a metadata-only commit, invisible in the document history.
    expect(git(root, 'log', '--format=%s', '-n', '1').trim()).toBe('Reject proposals');
    const history = await getDocumentHistory(root, 'docs/spec.md', true);
    expect(history.map((h) => h.subject)).not.toContain('Reject proposals');
  });
});
