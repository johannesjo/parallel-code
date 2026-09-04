import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Guards the invariant every git-touching test depends on: a `git` spawned by a
 * test acts on its own temp repository, never on the checkout the suite runs in.
 * Run from a git hook without `vitest.setup.ts` scrubbing the inherited
 * `GIT_DIR`/`GIT_INDEX_FILE`, both of these fail.
 */
describe('test environment', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('hands tests no pointer to a surrounding repository', () => {
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'])
      expect({ [name]: process.env[name] }).toEqual({ [name]: undefined });
  });

  it('creates a temp repository in the temp folder, not in the ambient one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-test-env-'));
    made.push(dir);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });

    // `--show-toplevel` would pass either way: an inherited GIT_DIR leaves the
    // work tree at cwd. Only the git dir itself reveals the hijack.
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();

    expect(fs.realpathSync(gitDir)).toBe(path.join(fs.realpathSync(dir), '.git'));
  });
});
