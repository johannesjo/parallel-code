import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { changedFilesFromMaps, countReadableTextLines, ensureSymlinkExcludes } from './git.js';
import { appendGitInfoExcludeBlock, resolveGitInfoExcludePath } from './git-exclude.js';

const tempDirs: string[] = [];
const localGitEnvVars = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-git-helpers-'));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function withoutInheritedGitContext<T>(fn: () => T): T {
  const inherited = new Map(localGitEnvVars.map((name) => [name, process.env[name]]));
  for (const name of localGitEnvVars) Reflect.deleteProperty(process.env, name);
  try {
    return fn();
  } finally {
    for (const [name, value] of inherited) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}

function initRepository(): string {
  const root = tempDir();
  git(root, ['init']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'initial\n', 'utf8');
  git(root, ['add', 'tracked.txt']);
  git(root, [
    '-c',
    'user.name=Parallel Code Tests',
    '-c',
    'user.email=tests@parallel-code.local',
    'commit',
    '-m',
    'initial',
  ]);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('changedFilesFromMaps', () => {
  it('builds sorted ChangedFile entries from numstat and status maps', () => {
    const files = changedFilesFromMaps({
      statusMap: new Map([
        ['b.bin', 'D'],
        ['a.ts', 'M'],
      ]),
      numstatMap: new Map([['a.ts', [4, 2]]]),
      committed: true,
    });

    expect(files).toEqual([
      { path: 'a.ts', lines_added: 4, lines_removed: 2, status: 'M', committed: true },
      { path: 'b.bin', lines_added: 0, lines_removed: 0, status: 'D', committed: true },
    ]);
  });

  it('can derive committed from each path', () => {
    const files = changedFilesFromMaps({
      statusMap: new Map([
        ['clean.ts', 'M'],
        ['dirty.ts', 'M'],
      ]),
      numstatMap: new Map([
        ['clean.ts', [1, 0]],
        ['dirty.ts', [2, 1]],
      ]),
      committed: (filePath) => filePath === 'clean.ts',
    });

    expect(files.map((file) => [file.path, file.committed])).toEqual([
      ['clean.ts', true],
      ['dirty.ts', false],
    ]);
  });
});

describe('countReadableTextLines', () => {
  it('does not count a phantom line after a trailing newline', async () => {
    const file = path.join(tempDir(), 'file.txt');
    fs.writeFileSync(file, 'one\ntwo\n', 'utf8');

    await expect(countReadableTextLines(file)).resolves.toBe(2);
  });

  it('returns zero for unreadable files', async () => {
    await expect(countReadableTextLines(path.join(tempDir(), 'missing.txt'))).resolves.toBe(0);
  });
});

describe('git exclude helpers', () => {
  it('resolves the exclude path for normal repositories', () =>
    withoutInheritedGitContext(() => {
      const root = initRepository();

      expect(resolveGitInfoExcludePath(root)).toBe(path.join(root, '.git', 'info', 'exclude'));
    }));

  it('writes linked worktree excludes to the common file Git reads', () =>
    withoutInheritedGitContext(() => {
      const root = initRepository();
      const worktreePath = path.join(tempDir(), 'task');
      git(root, ['worktree', 'add', '-b', 'task', worktreePath]);
      const commonExcludePath = path.join(fs.realpathSync(root), '.git', 'info', 'exclude');

      expect(resolveGitInfoExcludePath(worktreePath)).toBe(commonExcludePath);

      appendGitInfoExcludeBlock(worktreePath, '# probe', '# probe\n/probe\n');
      fs.writeFileSync(path.join(worktreePath, 'probe'), 'ignored\n', 'utf8');

      expect(git(worktreePath, ['check-ignore', '-v', 'probe'])).toContain('info/exclude');
      expect(git(worktreePath, ['status', '--short', '--untracked-files=all'])).not.toContain(
        'probe',
      );
    }));

  it('appends an idempotent block with newline padding', () =>
    withoutInheritedGitContext(() => {
      const root = initRepository();
      const excludePath = path.join(root, '.git', 'info', 'exclude');
      fs.writeFileSync(excludePath, 'existing', 'utf8');

      appendGitInfoExcludeBlock(root, '# marker', '# marker\nignored\n');
      appendGitInfoExcludeBlock(root, '# marker', '# marker\nignored\n');

      expect(fs.readFileSync(excludePath, 'utf8')).toBe('existing\n# marker\nignored\n');
    }));

  it('symlink excludes cover missing entries beside a hand-written trailing-space line', () =>
    withoutInheritedGitContext(() => {
      const root = initRepository();
      const excludePath = path.join(root, '.git', 'info', 'exclude');
      // Git strips the unescaped trailing space, so `/foo ` already covers
      // `foo` — but a marker match on it must not swallow the missing `/bar`.
      fs.writeFileSync(excludePath, '/foo \n', 'utf8');

      ensureSymlinkExcludes(root, ['foo', 'bar']);

      expect(() => git(root, ['check-ignore', '-q', 'foo'])).not.toThrow();
      expect(() => git(root, ['check-ignore', '-q', 'bar'])).not.toThrow();
    }));

  it('symlink excludes treat a tab-suffixed line as a distinct pattern', () =>
    withoutInheritedGitContext(() => {
      const root = initRepository();
      const excludePath = path.join(root, '.git', 'info', 'exclude');
      // Git does not strip trailing tabs — `/foo\t` ignores `foo\t`, so `foo`
      // still needs its own entry.
      fs.writeFileSync(excludePath, '/foo\t\n', 'utf8');

      ensureSymlinkExcludes(root, ['foo']);

      expect(() => git(root, ['check-ignore', '-q', 'foo'])).not.toThrow();
    }));
});
