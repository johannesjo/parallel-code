import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createWorktree,
  ensureSymlinkExcludes,
  getSymlinkCandidates,
  refreshWorktreeNodeModules,
} from './git.js';

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

  it('writes an exclude entry that matches a trailing-space name exactly', async () => {
    const root = initRepository();
    // Directory-only ignore rule for a directory whose name ends in a space.
    fs.writeFileSync(path.join(root, '.gitignore'), 'foo\\ /\n', 'utf8');
    fs.mkdirSync(path.join(root, 'foo '));
    fs.writeFileSync(path.join(root, 'foo ', 'f.txt'), 'x\n', 'utf8');
    // Same name without the trailing space: not ignored, never a candidate.
    fs.mkdirSync(path.join(root, 'foo'));
    fs.writeFileSync(path.join(root, 'foo', 'f.txt'), 'x\n', 'utf8');

    await expect(getSymlinkCandidates(root)).resolves.toEqual([{ name: 'foo ', isDefault: false }]);

    await createWorktree(root, 'task-trailing-space', ['foo ']);

    // Raw execFileSync — the shared git() helper trims stdout and would eat
    // the trailing space this test is about.
    expect(execFileSync('git', ['check-ignore', 'foo '], { cwd: root, encoding: 'utf8' })).toBe(
      'foo \n',
    );
    expect(() => git(root, ['check-ignore', 'foo'])).toThrow();
  });

  it('returns an empty list and warns when the git probe fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-not-a-repo-'));
    tempDirs.push(root);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(getSymlinkCandidates(root)).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
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

  it('finds root candidates even above a tracked directory full of ignored files', async () => {
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
    fs.writeFileSync(path.join(root, '.gitignore'), '*.log\nnode_modules/\n', 'utf8');
    // 5000 nested ignored files with 240-char names (just under the 255 fs
    // limit): ≈1.2 MB of output, ~17% above the old 1 MiB execFile default —
    // unbounded enumeration of these used to blow the exec buffer and lose
    // every candidate, node_modules included.
    for (let i = 0; i < 5000; i++) {
      const name = `f${i}-`.padEnd(236, 'x') + '.log';
      fs.writeFileSync(path.join(root, 'src', name), 'ignored\n', 'utf8');
    }
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'package.json'), '{}\n', 'utf8');

    await expect(getSymlinkCandidates(root)).resolves.toEqual([
      { name: 'node_modules', isDefault: true },
    ]);
  }, 60000);

  it('returns a root-level ignored file named like a git flag without hanging', async () => {
    const root = initRepository();
    fs.writeFileSync(path.join(root, '.gitignore'), '/--stdin\n', 'utf8');
    fs.writeFileSync(path.join(root, '--stdin'), 'tricky\n', 'utf8');

    // The default 5s test timeout is the hang tripwire: the old per-candidate
    // `git check-ignore` re-verification parsed `--stdin` as a flag and waited
    // on stdin forever.
    await expect(getSymlinkCandidates(root)).resolves.toEqual([
      { name: '--stdin', isDefault: false },
    ]);
  });

  it('does not show a dot-directory whose contents alone are ignored', async () => {
    const root = initRepository();
    fs.writeFileSync(path.join(root, '.gitignore'), '*.log\n', 'utf8');
    fs.mkdirSync(path.join(root, '.hidden'));
    fs.writeFileSync(path.join(root, '.hidden', 'app.log'), 'ignored\n', 'utf8');

    await expect(getSymlinkCandidates(root)).resolves.toEqual([]);
  });

  // Git accepts yes/on/1 and case variants as boolean true — every synonym
  // must enable case folding, not just the literal string "true".
  for (const ignoreCaseValue of ['true', 'yes', 'on', '1', 'TRUE']) {
    it(`filters case variants of reserved names when core.ignorecase=${ignoreCaseValue}`, async () => {
      const root = initRepository();
      git(root, ['config', 'core.ignorecase', ignoreCaseValue]);
      fs.writeFileSync(
        path.join(root, '.gitignore'),
        '.worktrees/\nnode_modules/\n.claude/\n',
        'utf8',
      );
      fs.mkdirSync(path.join(root, '.WORKTREES'));
      fs.writeFileSync(path.join(root, '.WORKTREES', 'task.txt'), 'managed worktree\n', 'utf8');
      fs.mkdirSync(path.join(root, '.CLAUDE'));
      fs.writeFileSync(path.join(root, '.CLAUDE', 'settings.json'), '{}\n', 'utf8');
      fs.mkdirSync(path.join(root, 'Node_Modules'));
      fs.writeFileSync(path.join(root, 'Node_Modules', 'package.json'), '{}\n', 'utf8');

      // .WORKTREES / .CLAUDE must never be offered (self-referential symlink
      // loop / bwrap breakage); Node_Modules is a legitimate candidate and is
      // recognized as a default despite the case difference.
      await expect(getSymlinkCandidates(root)).resolves.toEqual([
        { name: 'Node_Modules', isDefault: true },
      ]);
    });
  }
});

describe('createWorktree', () => {
  it('git-excludes the worktree container so the project root stays clean', async () => {
    const root = initRepository();

    await createWorktree(root, 'task-container', []);

    const exclude = fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('/.worktrees/');
    expect(git(root, ['status', '--porcelain'])).toBe('');
  });

  it('symlinks a selected ignored directory from the main checkout', async () => {
    const root = initRepository();
    fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n', 'utf8');
    const source = path.join(root, 'dist');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'app.js'), 'built\n', 'utf8');

    const result = await createWorktree(root, 'task-symlink', ['dist']);
    const target = path.join(result.path, 'dist');

    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(source));
  });

  it('materializes node_modules as a real directory of per-entry links', async () => {
    const root = initRepository();
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n', 'utf8');
    const source = path.join(root, 'node_modules');
    fs.mkdirSync(path.join(source, 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(source, 'left-pad', 'index.js'), 'module.exports = 1;\n', 'utf8');
    fs.mkdirSync(path.join(source, '.vite'));

    const result = await createWorktree(root, 'task-nm-entries', ['node_modules']);
    const target = path.join(result.path, 'node_modules');

    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(target).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(target, 'left-pad')).isSymbolicLink()).toBe(true);
    // The source's cache dir is not linked — tools create a writable one.
    expect(fs.existsSync(path.join(target, '.vite'))).toBe(false);
    // The real directory is still invisible to git in the worktree.
    expect(git(result.path, ['status', '--porcelain'])).not.toContain('node_modules');
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

  it('creates a symlink for a name containing a `..` substring', async () => {
    const root = initRepository();
    fs.mkdirSync(path.join(root, 'foo..bar'));
    fs.writeFileSync(path.join(root, 'foo..bar', 'file.txt'), 'data\n', 'utf8');

    const result = await createWorktree(root, 'task-dotdot', ['foo..bar']);
    const target = path.join(result.path, 'foo..bar');

    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(path.join(root, 'foo..bar')));
  });

  for (const ignoreCaseValue of ['true', 'yes', 'on', '1', 'TRUE']) {
    it(`refuses a case variant of the worktree container when core.ignorecase=${ignoreCaseValue}`, async () => {
      const root = initRepository();
      git(root, ['config', 'core.ignorecase', ignoreCaseValue]);
      fs.mkdirSync(path.join(root, '.WORKTREES'));
      fs.writeFileSync(path.join(root, '.WORKTREES', 'task.txt'), 'managed worktree\n', 'utf8');

      // Even if the UI (or a bug above it) passes a reserved name through, the
      // backend must not link the worktree container into its own child.
      const result = await createWorktree(root, 'task-reserved', ['.WORKTREES']);

      expect(fs.existsSync(path.join(result.path, '.WORKTREES'))).toBe(false);
    });
  }
});

describe('refreshWorktreeNodeModules', () => {
  it('migrates a legacy whole-dir symlink and tops up new packages', async () => {
    const root = initRepository();
    const source = path.join(root, 'node_modules');
    fs.mkdirSync(path.join(source, 'pkg-a'), { recursive: true });

    const result = await createWorktree(root, 'task-nm-migrate', []);
    const target = path.join(result.path, 'node_modules');
    // Layout produced by createWorktree before per-entry links existed.
    fs.symlinkSync(source, target);

    fs.mkdirSync(path.join(source, 'pkg-b'));
    // A caller-resolved "not a repo" must be trusted, not re-detected.
    refreshWorktreeNodeModules(result.path, null);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);

    refreshWorktreeNodeModules(result.path, root);

    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(target, 'pkg-a')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(target, 'pkg-b')).isSymbolicLink()).toBe(true);
  });

  it('leaves the main checkout and unmanaged worktree installs untouched', async () => {
    const root = initRepository();
    const rootInstall = path.join(root, 'node_modules');
    fs.mkdirSync(path.join(rootInstall, 'pkg'), { recursive: true });

    const result = await createWorktree(root, 'task-nm-unmanaged', []);
    // A real install the user ran inside the worktree.
    const localInstall = path.join(result.path, 'node_modules');
    fs.mkdirSync(path.join(localInstall, 'other-pkg'), { recursive: true });

    refreshWorktreeNodeModules(root);
    refreshWorktreeNodeModules(result.path);

    expect(fs.lstatSync(path.join(rootInstall, 'pkg')).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(localInstall, 'other-pkg')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(localInstall, 'pkg'))).toBe(false);
  });
});

describe('ensureSymlinkExcludes', () => {
  it('escapes gitignore wildcards so similarly-named files stay visible', async () => {
    const root = initRepository();
    fs.writeFileSync(path.join(root, 'star*file'), 'a\n', 'utf8');
    fs.writeFileSync(path.join(root, 'starZZfile'), 'b\n', 'utf8');

    ensureSymlinkExcludes(root, ['star*file']);

    const status = git(root, ['status', '--porcelain']);
    expect(status).not.toContain('star*file');
    expect(status).toContain('starZZfile');
  });
});
