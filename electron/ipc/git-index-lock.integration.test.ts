import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getAllFileDiffs,
  getChangedFiles,
  getUncommittedChangedFiles,
  getUncommittedFileDiffs,
} from './git.js';

// The changed-files poll runs these helpers every few seconds while agents
// commit in the same worktree. If they rewrite the index they briefly hold
// index.lock and the agent's `git add`/`git commit` fails with "File exists".

const directories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A task branch with a committed file, edited text and binary files, and a file touched but unchanged. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'index-lock-'));
  directories.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'touched.txt'), 'same\n');
  writeFileSync(join(root, 'edited.txt'), 'one\n');
  writeFileSync(join(root, 'image.bin'), Buffer.from([0, 1]));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  git(root, 'checkout', '-b', 'task');
  writeFileSync(join(root, 'committed.txt'), 'new\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'task work');

  writeFileSync(join(root, 'edited.txt'), 'one\ntwo\n');
  writeFileSync(join(root, 'image.bin'), Buffer.from([0, 2]));
  // Same content, newer mtime: stat-dirty, which `git diff` refreshes by rewriting the index.
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(root, 'touched.txt'), future, future);
  return root;
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('working-tree diff helpers leave the index alone', () => {
  it('never rewrites .git/index and ignores stat-only changes', async () => {
    const root = fixture();
    const indexBefore = readFileSync(join(root, '.git', 'index'));

    const changed = await getChangedFiles(root, 'main');
    const uncommitted = await getUncommittedChangedFiles(root);
    const allDiffs = await getAllFileDiffs(root, 'main');
    const uncommittedDiffs = await getUncommittedFileDiffs(root);

    expect(readFileSync(join(root, '.git', 'index')).equals(indexBefore)).toBe(true);
    expect(changed.map((f) => [f.path, f.committed])).toEqual([
      ['committed.txt', true],
      ['edited.txt', false],
      ['image.bin', false],
    ]);
    expect(uncommitted.map((f) => [f.path, f.lines_added])).toEqual([
      ['edited.txt', 1],
      ['image.bin', 0],
    ]);
    for (const diff of [allDiffs, uncommittedDiffs]) {
      expect(diff).toContain('edited.txt');
      expect(diff).not.toContain('touched.txt');
    }
  });
});
