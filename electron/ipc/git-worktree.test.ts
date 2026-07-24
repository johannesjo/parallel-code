import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorktree, getSymlinkCandidates } from './git.js';

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

function initRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-git-worktree-'));
  tempDirs.push(root);
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
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('getSymlinkCandidates', () => {
  it('includes a fully ignored default directory marked as default', async () => {
    const root = initRepository();
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n', 'utf8');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'package.json'), '{}\n', 'utf8');

    await expect(getSymlinkCandidates(root)).resolves.toEqual([
      { name: 'node_modules', isDefault: true },
    ]);
  });

  it('includes a fully ignored non-default directory marked as discovered', async () => {
    const root = initRepository();
    fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n', 'utf8');
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'app.js'), 'built\n', 'utf8');

    await expect(getSymlinkCandidates(root)).resolves.toEqual([{ name: 'dist', isDefault: false }]);
  });

  it('includes an ignored top-level file', async () => {
    const root = initRepository();
    fs.writeFileSync(path.join(root, '.gitignore'), '.env\n', 'utf8');
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=test\n', 'utf8');

    await expect(getSymlinkCandidates(root)).resolves.toEqual([{ name: '.env', isDefault: true }]);
  });

  it('does not expose a tracked directory that only contains ignored files', async () => {
    const root = initRepository();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'tracked.ts'), 'export {};\n', 'utf8');
    git(root, ['add', 'src/tracked.ts']);
    git(root, [
      '-c',
      'user.name=Parallel Code Tests',
      '-c',
      'user.email=tests@parallel-code.local',
      'commit',
      '-m',
      'track source directory',
    ]);
    fs.writeFileSync(path.join(root, '.gitignore'), '*.log\n', 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'foo.log'), 'ignored\n', 'utf8');

    await expect(getSymlinkCandidates(root)).resolves.toEqual([]);
  });

  it('does not include a default candidate that is not ignored', async () => {
    const root = initRepository();
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'package.json'), '{}\n', 'utf8');

    await expect(getSymlinkCandidates(root)).resolves.toEqual([]);
  });

  it('filters entries managed internally by Parallel Code', async () => {
    const root = initRepository();
    const sandboxArtifacts = [
      '.bash_profile',
      '.bashrc',
      '.gitconfig',
      '.gitmodules',
      '.mcp.json',
      '.profile',
      '.ripgreprc',
      '.zprofile',
      '.zshrc',
    ];
    fs.writeFileSync(path.join(root, '.gitignore'), '.claude/\ndist/\n', 'utf8');
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{}\n', 'utf8');
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'app.js'), 'built\n', 'utf8');
    fs.appendFileSync(
      path.join(root, '.git', 'info', 'exclude'),
      sandboxArtifacts.map((name) => `/${name}`).join('\n') + '\n',
    );
    for (const name of sandboxArtifacts) {
      fs.writeFileSync(path.join(root, name), 'sandbox artifact\n', 'utf8');
    }

    await expect(getSymlinkCandidates(root)).resolves.toEqual([{ name: 'dist', isDefault: false }]);
  });

  it('filters the Parallel Code worktree container without hiding a singular name', async () => {
    const root = initRepository();
    fs.writeFileSync(path.join(root, '.gitignore'), '.worktree/\n.worktrees/\ndist/\n', 'utf8');
    fs.mkdirSync(path.join(root, '.worktree'));
    fs.writeFileSync(path.join(root, '.worktree', 'user.txt'), 'user directory\n', 'utf8');
    fs.mkdirSync(path.join(root, '.worktrees'));
    fs.writeFileSync(path.join(root, '.worktrees', 'task.txt'), 'managed worktree\n', 'utf8');
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'app.js'), 'built\n', 'utf8');

    await expect(getSymlinkCandidates(root)).resolves.toEqual([
      { name: '.worktree', isDefault: false },
      { name: 'dist', isDefault: false },
    ]);
  });

  it('does not show a directory whose contents are ignored by *.log', async () => {
    const root = initRepository();
    fs.writeFileSync(path.join(root, '.gitignore'), '*.log\n', 'utf8');
    fs.mkdirSync(path.join(root, 'logs'));
    fs.writeFileSync(path.join(root, 'logs', 'app.log'), 'ignored\n', 'utf8');

    await expect(getSymlinkCandidates(root)).resolves.toEqual([]);

    await createWorktree(root, 'task-logs', []);
    const exclude = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).not.toContain('/logs');
  });

  it('does not show a directory whose contents are ignored by coverage/*', async () => {
    const root = initRepository();
    fs.writeFileSync(path.join(root, '.gitignore'), 'coverage/*\n', 'utf8');
    fs.mkdirSync(path.join(root, 'coverage'));
    fs.writeFileSync(path.join(root, 'coverage', 'lcov.info'), 'ignored\n', 'utf8');

    await expect(getSymlinkCandidates(root)).resolves.toEqual([]);

    await createWorktree(root, 'task-coverage', []);
    const exclude = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).not.toContain('/coverage');
  });

  it('does not show a directory whose contents are ignored by *.tmp', async () => {
    const root = initRepository();
    fs.writeFileSync(path.join(root, '.gitignore'), '*.tmp\n', 'utf8');
    fs.mkdirSync(path.join(root, 'tmp'));
    fs.writeFileSync(path.join(root, 'tmp', 'foo.tmp'), 'ignored\n', 'utf8');

    await expect(getSymlinkCandidates(root)).resolves.toEqual([]);

    await createWorktree(root, 'task-tmp', []);
    const exclude = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).not.toContain('/tmp');
  });

  it('handles non-ASCII directory names', async () => {
    const root = initRepository();
    fs.writeFileSync(path.join(root, '.gitignore'), 'dàta/\n', 'utf8');
    fs.mkdirSync(path.join(root, 'dàta'));
    fs.writeFileSync(path.join(root, 'dàta', 'file.txt'), 'data\n', 'utf8');

    await expect(getSymlinkCandidates(root)).resolves.toEqual([{ name: 'dàta', isDefault: false }]);

    const result = await createWorktree(root, 'task-data', ['dàta']);
    const target = path.join(result.path, 'dàta');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(path.join(root, 'dàta')));
    const exclude = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('/dàta');
  });

  it('handles non-ASCII file names', async () => {
    const root = initRepository();
    fs.writeFileSync(path.join(root, '.gitignore'), 'nöte.txt\n', 'utf8');
    fs.writeFileSync(path.join(root, 'nöte.txt'), 'notes\n', 'utf8');

    await expect(getSymlinkCandidates(root)).resolves.toEqual([
      { name: 'nöte.txt', isDefault: false },
    ]);
    expect(fs.existsSync(path.join(root, 'nöte.txt'))).toBe(true);
  });
});

describe('createWorktree', () => {
  it('symlinks a selected ignored directory from the main checkout', async () => {
    const root = initRepository();
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n', 'utf8');
    const source = path.join(root, 'node_modules');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'package.json'), '{}\n', 'utf8');

    const result = await createWorktree(root, 'task-symlink', ['node_modules']);
    const target = path.join(result.path, 'node_modules');

    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(source));
  });

  it('silently rejects selected names nested below the repository root', async () => {
    const root = initRepository();
    fs.mkdirSync(path.join(root, 'foo', 'bar'), { recursive: true });
    fs.writeFileSync(path.join(root, 'foo', 'tracked.txt'), 'tracked\n', 'utf8');
    git(root, ['add', 'foo/tracked.txt']);
    git(root, [
      '-c',
      'user.name=Parallel Code Tests',
      '-c',
      'user.email=tests@parallel-code.local',
      'commit',
      '-m',
      'track parent directory',
    ]);

    const result = await createWorktree(root, 'task-nested', ['foo/bar']);

    expect(fs.existsSync(path.join(result.path, 'foo', 'tracked.txt'))).toBe(true);
    expect(fs.existsSync(path.join(result.path, 'foo', 'bar'))).toBe(false);
  });
});
