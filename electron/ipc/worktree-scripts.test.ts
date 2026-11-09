import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  WORKTREE_SCRIPT_MAX_LENGTH,
  buildScriptInvocation,
  describeTeardownFailure,
  listLinkedWorktrees,
  optionalWorktreeScript,
  runTeardownScript,
  validateWorktreeScript,
} from './worktree-scripts.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-worktree-scripts-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('validateWorktreeScript', () => {
  it('rejects non-strings, blanks, NUL and oversized scripts', () => {
    expect(() => validateWorktreeScript(42, 'script')).toThrow(/non-empty string/);
    expect(() => validateWorktreeScript('  \n', 'script')).toThrow(/non-empty string/);
    expect(() => validateWorktreeScript('echo\0hi', 'script')).toThrow(/NUL/);
    expect(() =>
      validateWorktreeScript('x'.repeat(WORKTREE_SCRIPT_MAX_LENGTH + 1), 'script'),
    ).toThrow(/too long/);
    expect(() => validateWorktreeScript('npm ci', 'script')).not.toThrow();
  });

  it('treats missing or blank optional scripts as none', () => {
    expect(optionalWorktreeScript(undefined, 'script')).toBeUndefined();
    expect(optionalWorktreeScript('   ', 'script')).toBeUndefined();
    expect(optionalWorktreeScript('npm ci', 'script')).toBe('npm ci');
    expect(() => optionalWorktreeScript(['npm ci'], 'script')).toThrow();
  });
});

describe('buildScriptInvocation', () => {
  it('runs POSIX login shells with errexit', () => {
    expect(buildScriptInvocation('a\nb', { platform: 'darwin', shell: '/bin/zsh' })).toEqual({
      file: '/bin/zsh',
      args: ['-e', '-c', 'a\nb'],
    });
  });

  it('falls back to /bin/sh for shells with other syntax', () => {
    expect(buildScriptInvocation('a', { platform: 'linux', shell: '/usr/bin/fish' })).toEqual({
      file: '/bin/sh',
      args: ['-e', '-c', 'a'],
    });
  });

  it('always uses /bin/sh inside Docker', () => {
    expect(
      buildScriptInvocation('a', { platform: 'darwin', shell: '/bin/zsh', docker: true }).file,
    ).toBe('/bin/sh');
  });

  it('chains lines with && for cmd.exe on Windows, without Node re-quoting', () => {
    const inv = buildScriptInvocation('npm ci\r\n\r\ncopy a b\n', {
      platform: 'win32',
      shell: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(inv.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(inv.args).toEqual(['/d', '/s', '/c', '"npm ci && copy a b"']);
    expect(inv.windowsVerbatimArguments).toBe(true);
  });

  it('makes PowerShell stop on errors, including native exit codes', () => {
    const inv = buildScriptInvocation('npm ci', { platform: 'win32', shell: 'pwsh.exe' });
    expect(inv.file).toBe('pwsh.exe');
    expect(inv.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    expect(inv.args[4]).toContain("$ErrorActionPreference = 'Stop'");
    expect(inv.args[4]).toContain('$PSNativeCommandUseErrorActionPreference = $true');
    expect(inv.args[4].endsWith('\nnpm ci')).toBe(true);
  });

  it('uses Git Bash on Windows when that is the user shell', () => {
    expect(
      buildScriptInvocation('a', { platform: 'win32', shell: 'C:\\Git\\bin\\bash.exe' }).args,
    ).toEqual(['-e', '-c', 'a']);
  });
});

describe.skipIf(process.platform === 'win32')('runTeardownScript', () => {
  // Each test's worktree is listed as a linked worktree of its root.
  let listed: string[] = [];
  const listWorktrees = async () => listed;
  const shellDeps = { shell: '/bin/sh', listWorktrees };
  const worktreeDir = () => {
    const dir = tempDir();
    listed = [fs.realpathSync(dir)];
    return dir;
  };

  it('runs in the worktree with the script variables and passes on exit 0', async () => {
    const root = tempDir();
    const worktree = worktreeDir();
    const result = await runTeardownScript(
      {
        worktreePath: worktree,
        projectRoot: root,
        script: 'pwd\necho "root=$PARALLEL_CODE_ROOT_PATH"',
        env: { PARALLEL_CODE_ROOT_PATH: root },
      },
      shellDeps,
    );
    expect(result.status).toBe('passed');
    expect(result.outputTail).toContain(fs.realpathSync(worktree));
    expect(result.outputTail).toContain(`root=${root}`);
    expect(describeTeardownFailure(result)).toBeUndefined();
  });

  it('stops at the first failing line and reports the exit code with the output', async () => {
    const root = tempDir();
    const worktree = worktreeDir();
    const result = await runTeardownScript(
      {
        worktreePath: worktree,
        projectRoot: root,
        script: 'echo stopping db\nexit 3\ntouch after',
      },
      shellDeps,
    );
    expect(result).toMatchObject({ status: 'failed', exitCode: 3 });
    expect(fs.existsSync(path.join(worktree, 'after'))).toBe(false);
    const notice = describeTeardownFailure(result);
    expect(notice).toContain('exited with code 3');
    expect(notice).toContain('stopping db');
  });

  it('kills a script that runs past its timeout', async () => {
    const root = tempDir();
    const worktree = worktreeDir();
    const result = await runTeardownScript(
      { worktreePath: worktree, projectRoot: root, script: 'sleep 30', timeoutMs: 200 },
      shellDeps,
    );
    expect(result.status).toBe('timed_out');
    expect(describeTeardownFailure(result)).toContain('timed out');
  });

  it('reports a script killed by a signal as failed', async () => {
    const root = tempDir();
    const worktree = worktreeDir();
    const result = await runTeardownScript(
      { worktreePath: worktree, projectRoot: root, script: 'kill -TERM $$' },
      shellDeps,
    );
    expect(result.status).toBe('failed');
    expect(describeTeardownFailure(result)).toContain('SIGTERM');
  });

  it('settles when the script exits even if a background child keeps its output open', async () => {
    const root = tempDir();
    const worktree = worktreeDir();
    const started = Date.now();
    const result = await runTeardownScript(
      {
        worktreePath: worktree,
        projectRoot: root,
        script: 'sleep 20 &\necho done',
        timeoutMs: 10_000,
      },
      shellDeps,
    );
    expect(result.status).toBe('passed');
    expect(result.outputTail).toContain('done');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('refuses a folder git does not list as a worktree of the repository', async () => {
    const root = tempDir();
    const elsewhere = tempDir();
    listed = [];
    const result = await runTeardownScript(
      { worktreePath: elsewhere, projectRoot: root, script: 'touch ran' },
      shellDeps,
    );
    expect(result.status).toBe('error');
    expect(describeTeardownFailure(result)).toContain('is not a worktree of this repository');
    expect(fs.existsSync(path.join(elsewhere, 'ran'))).toBe(false);
  });

  it('never runs in the main checkout', async () => {
    const root = tempDir();
    const result = await runTeardownScript(
      { worktreePath: root, projectRoot: root, script: 'touch ran' },
      shellDeps,
    );
    expect(result.status).toBe('skipped');
    expect(fs.existsSync(path.join(root, 'ran'))).toBe(false);
  });

  it('skips a worktree that is already gone', async () => {
    const root = tempDir();
    const result = await runTeardownScript(
      { worktreePath: path.join(root, 'missing'), projectRoot: root, script: 'true' },
      shellDeps,
    );
    expect(result.status).toBe('skipped');
    expect(describeTeardownFailure(result)).toBeUndefined();
  });
});

describe('listLinkedWorktrees', () => {
  it('lists linked worktrees as real paths, without the main checkout', async () => {
    const root = tempDir();
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git(['init', '--quiet', '--initial-branch=main']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init']);
    git(['worktree', 'add', '-b', 'task/a', path.join(root, '.worktrees', 'a')]);
    expect(await listLinkedWorktrees(root)).toEqual([
      fs.realpathSync(path.join(root, '.worktrees', 'a')),
    ]);
  });
});
