import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BrowserWindow } from 'electron';
import {
  annotationThread,
  askAnnotation,
  buildAnnotationPrompt,
  deleteAnnotation,
  readAnnotations,
  saveAnnotation,
  validateAnnotationInput,
} from './annotations.js';
import type { DocumentAnnotation, DocumentAnnotationEvent } from './types.js';

const anchor = {
  path: 'docs/spec.md',
  baseSha: 'abcdef1234567',
  startLine: 5,
  endLine: 7,
  quote: '## Goals\n\nOld goals text.',
  prefix: 'Intro paragraph.',
  suffix: '## Later',
  heading: 'Goals',
};

function note(id: string, extra: Partial<DocumentAnnotation> = {}): Record<string, unknown> {
  return {
    id,
    kind: 'note',
    anchor,
    text: `note ${id}`,
    createdAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

describe('validateAnnotationInput', () => {
  it('normalizes a note', () => {
    const a = validateAnnotationInput(note('n-1', { resolved: true }));
    expect(a.kind).toBe('note');
    expect(a.resolved).toBe(true);
    expect(a.anchor.heading).toBe('Goals');
    expect(a.answer).toBeUndefined();
  });
  it('rejects bad ids, kinds, anchors and shas', () => {
    expect(() => validateAnnotationInput(note('bad id!'))).toThrow(/id/);
    expect(() => validateAnnotationInput({ ...note('n-1'), kind: 'task' })).toThrow(/kind/);
    expect(() =>
      validateAnnotationInput({ ...note('n-1'), anchor: { ...anchor, startLine: 9, endLine: 2 } }),
    ).toThrow(/lines/);
    expect(() =>
      validateAnnotationInput({ ...note('n-1'), anchor: { ...anchor, baseSha: 'HEAD' } }),
    ).toThrow(/baseSha/);
    expect(() =>
      validateAnnotationInput({ ...note('n-1'), anchor: { ...anchor, path: '../x.md' } }),
    ).toThrow();
  });
  it('drops unknown statuses and run ids', () => {
    const a = validateAnnotationInput({ ...note('n-1'), answerStatus: 'weird', runId: 'bad id' });
    expect(a.answerStatus).toBeUndefined();
    expect(a.runId).toBeUndefined();
  });

  it('keeps a follow-up link but never one to itself', () => {
    expect(validateAnnotationInput({ ...note('q-2'), followUpOf: 'q-1' }).followUpOf).toBe('q-1');
    expect(
      validateAnnotationInput({ ...note('q-2'), followUpOf: 'q-2' }).followUpOf,
    ).toBeUndefined();
    expect(
      validateAnnotationInput({ ...note('q-2'), followUpOf: 'no way' }).followUpOf,
    ).toBeUndefined();
  });
});

function answered(
  id: string,
  text: string,
  answer: string,
  followUpOf?: string,
): DocumentAnnotation {
  return validateAnnotationInput({
    ...note(id),
    kind: 'question',
    text,
    followUpOf,
    answerStatus: 'answered',
    answer: { text: answer, agentId: 'claude-code', agentName: 'Claude', answeredAt: 'x' },
  });
}

describe('annotationThread', () => {
  it('walks the follow-up chain oldest first and survives a loop', () => {
    const first = answered('q-1', 'Why?', 'Because.');
    const second = answered('q-2', 'Why that?', 'Tradition.', 'q-1');
    const third = answered('q-3', 'Since when?', '', 'q-2');
    expect(annotationThread([third, first, second], third).map((a) => a.id)).toEqual([
      'q-1',
      'q-2',
    ]);
    const loopA = answered('l-a', 'a', 'a', 'l-b');
    const loopB = answered('l-b', 'b', 'b', 'l-a');
    expect(annotationThread([loopA, loopB], loopA).map((a) => a.id)).toEqual(['l-b']);
    expect(annotationThread([first], answered('q-9', 'x', 'y', 'gone'))).toEqual([]);
  });

  it('stops after eight exchanges, keeping the nearest ones', () => {
    const chain = Array.from({ length: 10 }, (_, i) =>
      answered(`q-${i}`, `q${i}`, `a${i}`, i > 0 ? `q-${i - 1}` : undefined),
    );
    const thread = annotationThread(chain, chain[9]);
    expect(thread.map((a) => a.id)).toEqual(chain.slice(1, 9).map((a) => a.id));
  });
});

describe('buildAnnotationPrompt', () => {
  it('quotes the passage and forbids edits', () => {
    const prompt = buildAnnotationPrompt(
      validateAnnotationInput({ ...note('q-1'), kind: 'question', text: 'Why?' }),
    );
    expect(prompt).toContain('Document: docs/spec.md');
    expect(prompt).toContain('lines 5-7 (under "Goals")');
    expect(prompt).toContain('> Old goals text.');
    expect(prompt).toContain('Question:\nWhy?');
    expect(prompt).toContain('Do not edit');
    expect(prompt).not.toContain('follow-up');
  });

  it('carries the earlier exchange into a follow-up', () => {
    const first = answered('q-1', 'Why is this here?', 'It anchors the section.');
    const followUp = answered('q-2', 'Could it move up?', '', 'q-1');
    const prompt = buildAnnotationPrompt(followUp, annotationThread([first, followUp], followUp));
    expect(prompt).toContain('This is a follow-up');
    expect(prompt).toContain('Question:\nWhy is this here?');
    expect(prompt).toContain('Answer (Claude):\nIt anchors the section.');
    expect(prompt).toContain('Follow-up question:\nCould it move up?');
    expect(prompt.indexOf('Why is this here?')).toBeLessThan(prompt.indexOf('Could it move up?'));
  });

  it('says so when an earlier question got no answer', () => {
    const unanswered = validateAnnotationInput({ ...note('q-1'), kind: 'question', text: 'Why?' });
    const followUp = answered('q-2', 'Still, why?', '', 'q-1');
    expect(buildAnnotationPrompt(followUp, [unanswered])).toContain(
      'Question:\nWhy?\n\nAnswer: none was given.',
    );
  });

  it('keeps a long thread under the Linux argument limit, cutting old answers not the question', () => {
    const chain = Array.from({ length: 9 }, (_, i) =>
      answered(`q-${i}`, 'q'.repeat(20_000), 'a'.repeat(50_000), i > 0 ? `q-${i - 1}` : undefined),
    );
    const earlier = annotationThread(chain, chain[8]);
    const prompt = buildAnnotationPrompt(chain[8], earlier);
    expect(earlier).toHaveLength(8);
    expect(Buffer.byteLength(prompt)).toBeLessThan(128 * 1024);
    // Eight answers share 40 000 bytes: 5 000 each, then the marker.
    expect(prompt.match(/a{5000}\n… \(truncated\)/g)).toHaveLength(8);
    expect(prompt).toContain('Follow-up question:\n' + 'q'.repeat(20_000));
  });
});

describe('annotations file and asking', () => {
  let root: string;
  let fakeAgent: string;
  const events: DocumentAnnotationEvent[] = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_ch: string, payload: DocumentAnnotationEvent) => events.push(payload) },
  } as unknown as BrowserWindow;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-docws-ann-'));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-docws-ann-bin-'));
    fakeAgent = path.join(binDir, 'fake-claude.sh');
    fs.writeFileSync(
      fakeAgent,
      [
        '#!/bin/sh',
        // Prove read-only tools were requested and answer.
        'case "$*" in *"Read,Glob,Grep"*) ;; *) echo "wrong tools" >&2; exit 2;; esac',
        'printf \'%s\\n\' \'{"type":"result","subtype":"success","session_id":"s","result":"The passage assumes **nothing**."}\'',
      ].join('\n') + '\n',
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('round-trips annotations and keeps a pending answer across edits', async () => {
    expect(readAnnotations(root)).toEqual([]);
    await saveAnnotation(root, note('a-1'));
    await saveAnnotation(root, note('a-2', { kind: 'question', text: 'Why?' }));
    expect(readAnnotations(root).map((a) => a.id)).toEqual(['a-1', 'a-2']);
    expect(fs.existsSync(path.join(root, '.parallel', 'annotations.json'))).toBe(true);

    const edited = await saveAnnotation(root, { ...note('a-1'), text: 'edited', resolved: true });
    expect(edited.text).toBe('edited');
    expect(readAnnotations(root)[0].createdAt).toBe('2026-01-01T00:00:00Z');

    await deleteAnnotation(root, 'a-1');
    expect(readAnnotations(root).map((a) => a.id)).toEqual(['a-2']);
  });

  it('skips malformed entries instead of losing the file', async () => {
    const file = path.join(root, '.parallel', 'annotations.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { annotations: unknown[] };
    raw.annotations.push({ id: 'bad', kind: 'note' });
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(readAnnotations(root).map((a) => a.id)).toEqual(['a-2']);
  });

  it('asks a read-only agent and stores the answer in the bubble', async () => {
    const pending = await askAnnotation(win, {
      projectRoot: root,
      documentPath: 'docs/spec.md',
      annotationId: 'a-2',
      agentId: 'claude-code',
      agentName: 'Fake Claude',
      command: fakeAgent,
    });
    expect(pending.answerStatus).toBe('pending');
    const answered = await new Promise<DocumentAnnotation>((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const done = events.find(
          (e) => e.annotation.id === 'a-2' && e.annotation.answerStatus !== 'pending',
        );
        if (done) return resolve(done.annotation);
        if (Date.now() - started > 10_000) return reject(new Error('no answer'));
        setTimeout(tick, 50);
      };
      tick();
    });
    expect(answered.answerStatus).toBe('answered');
    expect(answered.answer?.text).toContain('assumes **nothing**');
    expect(answered.answer?.agentName).toBe('Fake Claude');
    expect(readAnnotations(root)[0].answer?.text).toContain('nothing');
    // Question and answer both survive: the question text is untouched.
    expect(readAnnotations(root)[0].text).toBe('Why?');
  });

  it('refuses agents without a headless mode and unknown annotations', async () => {
    await expect(
      askAnnotation(win, {
        projectRoot: root,
        documentPath: 'docs/spec.md',
        annotationId: 'a-2',
        agentId: 'opencode',
        agentName: 'x',
        command: fakeAgent,
      }),
    ).rejects.toThrow(/no headless mode/);
    await expect(
      askAnnotation(win, {
        projectRoot: root,
        documentPath: 'docs/spec.md',
        annotationId: 'missing-1',
        agentId: 'claude-code',
        agentName: 'x',
        command: fakeAgent,
      }),
    ).rejects.toThrow(/not found/);
  });
});
