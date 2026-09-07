import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BrowserWindow } from 'electron';
import { acceptDocumentCandidate, dispatchDocumentRun, listDocumentRuns } from './runs.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

describe('candidate refinement', () => {
  it('starts from the proposal, keeps canonical edits untouched, and accepts the complete revision', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-refine-'));
    roots.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(root, 'plan.md'), '# Plan\n\nOriginal.\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'Initial');
    const baseSha = git(root, 'rev-parse', 'HEAD');
    // A deterministic agent: each invocation adds a revision to the file it sees.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-refine-agent-'));
    roots.push(bin);
    const command = path.join(bin, 'agent.sh');
    fs.writeFileSync(command, '#!/bin/sh\nprintf "\\nRevision.\\n" >> plan.md\n', { mode: 0o755 });
    const win = { isDestroyed: () => true } as unknown as BrowserWindow;
    const args = {
      projectRoot: root,
      documentPath: 'plan.md',
      instruction: 'Improve the plan',
      scope: { wholeDocument: true },
      candidates: [
        { id: 'c1', label: 'A', agentId: 'claude-code', agentName: 'Test', command, isMain: false },
      ],
    };
    const first = await dispatchDocumentRun(win, args);
    await expect
      .poll(async () => (await listDocumentRuns(root)).find((r) => r.id === first.id)?.status)
      .toBe('finished');
    const original = fs.readFileSync(path.join(root, 'plan.md'), 'utf8');
    fs.writeFileSync(path.join(root, 'plan.md'), original.replace('# Plan', '# Local title'));
    const refinement = { runId: first.id, candidateId: 'c1' };
    const next = await dispatchDocumentRun(win, {
      ...args,
      instruction: 'Clarify the assumptions',
      refinement,
    });
    await expect
      .poll(async () => (await listDocumentRuns(root)).find((r) => r.id === next.id)?.status)
      .toBe('finished');
    const finished = (await listDocumentRuns(root)).find((r) => r.id === next.id);
    if (!finished) throw new Error('Refinement run not found');
    expect(finished.refinement).toEqual(refinement);
    expect(finished.baseSha).toBe(baseSha);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(baseSha);
    expect(fs.readFileSync(path.join(root, 'plan.md'), 'utf8')).toBe(
      original.replace('# Plan', '# Local title'),
    );
    expect(git(root, 'show', `${finished.candidates[0].commitSha}:plan.md`)).toBe(
      '# Plan\n\nOriginal.\n\nRevision.\n\nRevision.',
    );
    await acceptDocumentCandidate(root, next.id, 'c1');
    expect(fs.readFileSync(path.join(root, 'plan.md'), 'utf8')).toBe(
      '# Local title\n\nOriginal.\n\nRevision.\n\nRevision.\n',
    );
    expect((await listDocumentRuns(root)).find((r) => r.id === first.id)?.status).toBe('finished');
    await expect(
      dispatchDocumentRun(win, { ...args, refinement: { runId: next.id, candidateId: 'c1' } }),
    ).rejects.toThrow(/accepted|review/);
    await expect(
      dispatchDocumentRun(win, { ...args, documentPath: 'other.md', refinement }),
    ).rejects.toThrow(/document/);
    const recordPath = path.join(root, '.parallel', 'runs', `${first.id}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(recordPath, JSON.stringify({ ...record, instruction: 123 }));
    await expect(dispatchDocumentRun(win, { ...args, refinement })).rejects.toThrow(/instruction/);
  });
});
