import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorktree, resolveWorktreeFolder, worktreePathFor } from './git.js';

const tempDirs: string[] = [];
const localGitEnvVars = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);
const inheritedGitEnv = new Map<string, string | undefined>();

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-wt-folder-')));
  tempDirs.push(dir);
  return dir;
}

function initRepository(): string {
  const root = path.join(tempDir(), 'repo');
  fs.mkdirSync(root);
  git(root, ['init', '--quiet', '--initial-branch=main']);
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

function readExclude(root: string): string {
  return fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
}

beforeEach(() => {
  for (const name of localGitEnvVars) {
    inheritedGitEnv.set(name, process.env[name]);
    Reflect.deleteProperty(process.env, name);
  }
});

afterEach(() => {
  for (const [name, value] of inheritedGitEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  inheritedGitEnv.clear();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('worktreePathFor', () => {
  it('keeps the .worktrees layout without a folder', () => {
    expect(worktreePathFor('/repo', 'task/fix-a1b2c3')).toBe('/repo/.worktrees/task/fix-a1b2c3');
  });

  it('puts the worktree in the configured folder', () => {
    expect(worktreePathFor('/repo', 'task/fix-a1b2c3', '/wt/repo')).toBe(
      '/wt/repo/task/fix-a1b2c3',
    );
  });

  it('rejects a branch that would land the worktree inside the repo', () => {
    const root = initRepository();
    const parent = path.dirname(root);
    expect(() => worktreePathFor(root, 'repo/fix', parent)).toThrow('inside the project folder');
    expect(() => worktreePathFor(root, 'repo', parent)).toThrow('inside the project folder');
    expect(worktreePathFor(root, 'task/fix', parent)).toBe(path.join(parent, 'task', 'fix'));
  });

  it('rejects a branch name that escapes the folder', () => {
    expect(() => worktreePathFor('/repo', '../outside', '/wt/repo')).toThrow(
      'outside the worktree folder',
    );
    expect(() => worktreePathFor('/repo', '.', '/wt/repo')).toThrow('outside the worktree folder');
  });
});

describe('resolveWorktreeFolder', () => {
  it('treats a blank setting as the default layout', async () => {
    const root = initRepository();
    await expect(resolveWorktreeFolder(root, undefined)).resolves.toBeUndefined();
    await expect(resolveWorktreeFolder(root, '   ')).resolves.toBeUndefined();
  });

  it('creates an absolute folder outside the repo without touching its excludes', async () => {
    const root = initRepository();
    const before = readExclude(root);
    const folder = path.join(tempDir(), 'nested', 'worktrees');

    await expect(resolveWorktreeFolder(root, `  ${folder}/ `)).resolves.toBe(folder);

    expect(fs.statSync(folder).isDirectory()).toBe(true);
    expect(readExclude(root)).toBe(before);
  });

  it('expands ~ to the home folder', async () => {
    const root = initRepository();
    const home = tempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    await expect(resolveWorktreeFolder(root, '~/worktrees/repo')).resolves.toBe(
      path.join(home, 'worktrees', 'repo'),
    );
    await expect(resolveWorktreeFolder(root, '~')).resolves.toBe(home);
    expect(fs.existsSync(path.join(home, 'worktrees', 'repo'))).toBe(true);
  });

  it('rejects relative paths and ~user forms without creating anything', async () => {
    const root = initRepository();
    await expect(resolveWorktreeFolder(root, 'worktrees')).rejects.toThrow('absolute path');
    await expect(resolveWorktreeFolder(root, '~other/worktrees')).rejects.toThrow('absolute path');
    expect(fs.existsSync(path.join(root, 'worktrees'))).toBe(false);
  });

  it('rejects a multi-line value', async () => {
    const root = initRepository();
    await expect(resolveWorktreeFolder(root, `${root}/a\n/b`)).rejects.toThrow('single line');
  });

  it('rejects the repo root, also through a symlink', async () => {
    const root = initRepository();
    const link = path.join(tempDir(), 'link');
    fs.symlinkSync(root, link);

    await expect(resolveWorktreeFolder(root, root)).rejects.toThrow('project folder itself');
    await expect(resolveWorktreeFolder(root, `${root}/`)).rejects.toThrow('project folder itself');
    await expect(resolveWorktreeFolder(root, link)).rejects.toThrow('project folder itself');
  });

  it('rejects a folder inside .git, also through a symlinked parent', async () => {
    const root = initRepository();
    const link = path.join(tempDir(), 'gitlink');
    fs.symlinkSync(path.join(root, '.git'), link);

    await expect(resolveWorktreeFolder(root, path.join(root, '.git'))).rejects.toThrow('.git');
    await expect(resolveWorktreeFolder(root, path.join(root, '.git', 'wt'))).rejects.toThrow(
      '.git',
    );
    await expect(resolveWorktreeFolder(root, path.join(link, 'wt'))).rejects.toThrow('.git');
    expect(fs.existsSync(path.join(root, '.git', 'wt'))).toBe(false);
  });

  it.runIf(fs.existsSync(os.tmpdir().toUpperCase()))(
    'rejects the repo root and .git written in another letter case',
    async () => {
      const root = initRepository();
      const upper = path.join(path.dirname(root), 'REPO');
      await expect(resolveWorktreeFolder(root, upper)).rejects.toThrow('project folder itself');
      await expect(resolveWorktreeFolder(root, path.join(root, '.GIT', 'wt'))).rejects.toThrow(
        '.git',
      );
    },
  );

  it('rejects the main git dir when the project is itself a linked worktree', async () => {
    const root = initRepository();
    const linked = path.join(tempDir(), 'linked');
    git(root, ['worktree', 'add', '-b', 'side', linked]);

    await expect(resolveWorktreeFolder(linked, path.join(root, '.git', 'wt'))).rejects.toThrow(
      '.git',
    );
  });

  it('git-excludes a folder inside the repo once, escaping wildcards', async () => {
    const root = initRepository();
    const folder = path.join(root, 'tmp', 'wt*');

    await expect(resolveWorktreeFolder(root, folder)).resolves.toBe(folder);
    await resolveWorktreeFolder(root, folder);

    const lines = readExclude(root).split('\n');
    expect(lines.filter((line) => line === '/tmp/wt\\*/')).toHaveLength(1);
    fs.writeFileSync(path.join(folder, 'file.txt'), 'x\n', 'utf8');
    expect(git(root, ['status', '--porcelain'])).toBe('');
  });
});

describe('createWorktree with a worktree folder', () => {
  it('creates the worktree in an external folder', async () => {
    const root = initRepository();
    const folder = path.join(tempDir(), 'worktrees');
    const resolved = await resolveWorktreeFolder(root, folder);

    const result = await createWorktree(root, 'task/ext-1', [], undefined, false, resolved);

    expect(result.path).toBe(path.join(folder, 'task', 'ext-1'));
    expect(fs.readFileSync(path.join(result.path, 'tracked.txt'), 'utf8')).toBe('initial\n');
    expect(git(result.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('task/ext-1');
    expect(fs.existsSync(path.join(root, '.worktrees'))).toBe(false);
    expect(git(root, ['status', '--porcelain'])).toBe('');
  });

  it('does not symlink an in-repo worktree folder into its own worktrees', async () => {
    const root = initRepository();
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'app.js'), 'built\n', 'utf8');
    fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n', 'utf8');
    const resolved = await resolveWorktreeFolder(root, path.join(root, 'wt', 'tasks'));

    const result = await createWorktree(
      root,
      'task/in-1',
      ['wt', 'dist'],
      undefined,
      false,
      resolved,
    );

    expect(result.path).toBe(path.join(root, 'wt', 'tasks', 'task', 'in-1'));
    expect(fs.existsSync(path.join(result.path, 'wt'))).toBe(false);
    expect(fs.lstatSync(path.join(result.path, 'dist')).isSymbolicLink()).toBe(true);
  });
});
