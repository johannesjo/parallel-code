import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BrowserWindow } from 'electron';
import { dispatchDocumentRun, listDocumentRuns } from './runs.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function statusOf(root: string, runId: string) {
  return (await listDocumentRuns(root)).find((r) => r.id === runId)?.status;
}

describe('merging proposals with an agent', () => {
  it('hands the agent every chosen proposal as a diff and records the lineage', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-merge-'));
    roots.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(root, 'plan.md'), '# Plan\n\nOriginal.\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'Initial');
    const baseSha = git(root, 'rev-parse', 'HEAD');
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-merge-agent-'));
    roots.push(bin);
    // Each candidate signs its worktree's name so the two proposals differ.
    const propose = path.join(bin, 'propose.sh');
    fs.writeFileSync(
      propose,
      '#!/bin/sh\nprintf "\\nFrom %s.\\n" "$(basename "$PWD")" >> plan.md\n',
      { mode: 0o755 },
    );
    // The merging agent keeps its prompt (the claude-code layout: `-p <prompt>`) for the test to read.
    const promptFile = path.join(bin, 'prompt.txt');
    const merge = path.join(bin, 'merge.sh');
    fs.writeFileSync(
      merge,
      `#!/bin/sh\nprintf '%s' "$2" > ${JSON.stringify(promptFile)}\nprintf "\\nMerged.\\n" >> plan.md\n`,
      { mode: 0o755 },
    );
    const win = { isDestroyed: () => true } as unknown as BrowserWindow;
    const spec = (id: string, label: string, command: string) => ({
      id,
      label,
      agentId: 'claude-code',
      agentName: 'Test',
      command,
      isMain: false,
    });
    const args = {
      projectRoot: root,
      documentPath: 'plan.md',
      instruction: 'Improve the plan',
      scope: { wholeDocument: true },
      candidates: [spec('c1', 'A', propose), spec('c2', 'B', propose)],
    };
    const first = await dispatchDocumentRun(win, args);
    await expect.poll(() => statusOf(root, first.id)).toBe('finished');

    const lineage = { runId: first.id, candidateIds: ['c1', 'c2'] };
    const merged = await dispatchDocumentRun(win, {
      ...args,
      instruction: 'Keep both additions',
      candidates: [{ ...spec('c1', 'A', merge), isMain: true, sessionId: 'warm' }],
      merge: lineage,
    });
    await expect.poll(() => statusOf(root, merged.id)).toBe('finished');
    const record = (await listDocumentRuns(root)).find((r) => r.id === merged.id);
    if (!record) throw new Error('Merge run not found');
    expect(record.merge).toEqual(lineage);
    expect(record.baseSha).toBe(baseSha);
    expect(record.scope.wholeDocument).toBe(true);
    // Never the warm main session: the merge starts fresh.
    expect(record.candidates[0].isMain).toBe(false);
    expect(git(root, 'show', `${record.candidates[0].commitSha}:plan.md`)).toBe(
      '# Plan\n\nOriginal.\n\nMerged.',
    );
    const prompt = fs.readFileSync(promptFile, 'utf8');
    expect(prompt).toContain('2 candidates proposed changes');
    expect(prompt).toContain('> Improve the plan');
    expect(prompt).toContain('### Candidate A (Test)');
    expect(prompt).toContain('### Candidate B (Test)');
    expect(prompt).toMatch(/\+From .*-a\./);
    expect(prompt).toMatch(/\+From .*-b\./);
    expect(prompt).toContain('Instruction:\nKeep both additions');

    await expect(
      dispatchDocumentRun(win, { ...args, merge: { runId: first.id, candidateIds: ['c1'] } }),
    ).rejects.toThrow(/two proposals/);
    await expect(
      dispatchDocumentRun(win, {
        ...args,
        merge: lineage,
        refinement: { runId: first.id, candidateId: 'c1' },
      }),
    ).rejects.toThrow(/not both/);
    await expect(
      dispatchDocumentRun(win, { ...args, merge: { runId: first.id, candidateIds: ['c1', 'c9'] } }),
    ).rejects.toThrow(/c9/);
    await expect(
      dispatchDocumentRun(win, { ...args, documentPath: 'other.md', merge: lineage }),
    ).rejects.toThrow(/document/);
  });
});
