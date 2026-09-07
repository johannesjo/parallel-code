import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BrowserWindow } from 'electron';
import {
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
