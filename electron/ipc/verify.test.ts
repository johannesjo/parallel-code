import { execFileSync, type spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildVerifyEnv,
  createVerificationRunner,
  validateVerifyCommand,
  VERIFY_COMMAND_MAX_LENGTH,
} from './verify.js';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-verify-'));
  tmpDirs.push(dir);
  return dir;
}

/** A throwaway repo with one commit; returns its path and HEAD sha. */
function initRepo(): { repo: string; head: string } {
  const repo = tmpDir();
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', 'init');
  return { repo, head: git('rev-parse', 'HEAD') };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const runner = () => createVerificationRunner({ shell: '/bin/sh' });

describe('verification runner', () => {
  it('reports a passing command with its output and no git pin outside a checkout', async () => {
    const chunks: string[] = [];
    const run = await runner().start({
      key: 't1',
      worktreePath: tmpDir(),
      command: 'echo hello; exit 0',
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(run).toMatchObject({
      status: 'passed',
      exitCode: 0,
      headSha: null,
      dirty: false,
      command: 'echo hello; exit 0',
    });
    expect(run.outputTail).toContain('hello');
    expect(chunks.join('')).toContain('hello');
    expect(run.finishedAt).not.toBeNull();
  });

  it.each(['dirty', 'new-head'] as const)(
    'holds queued automatic checks when the tree becomes %s',
    async (change) => {
      const { repo, head } = initRepo();
      const r = createVerificationRunner({ shell: '/bin/sh', maxConcurrent: 1 });
      let started: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const blocker = r.start({
        key: 'blocker',
        worktreePath: repo,
        command: 'echo ready; sleep 30',
        onOutput: () => started?.(),
      });
      await ready;
      const queued = r.start({
        key: 'evidence',
        worktreePath: repo,
        command: 'echo executed',
        expectedHeadSha: head,
      });
      if (change === 'dirty') fs.writeFileSync(path.join(repo, 'package.json'), '{}');
      else
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'next'],
          { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] },
        );
      r.cancel('blocker');
      await blocker;
      const held = await queued;
      expect(held.status).toBe('cancelled');
      expect(held.outputTail).toBe('');
      expect(held.message).toContain('worktree changed');
      const explicit = await r.start({
        key: 'manual',
        worktreePath: repo,
        command: 'echo explicit',
      });
      expect(explicit.status).toBe('passed');
    },
  );

  it('runs automatic checks when the expected commit is still clean', async () => {
    const { repo, head } = initRepo();
    const result = await runner().start({
      key: 'evidence',
      worktreePath: repo,
      command: 'echo checked',
      expectedHeadSha: head,
    });
    expect(result.status).toBe('passed');
    expect(result.outputTail).toContain('checked');
  });

  it('reports a failing command with its exit code and stderr', async () => {
    const run = await runner().start({
      key: 't1',
      worktreePath: tmpDir(),
      command: 'echo boom >&2; exit 3',
    });

    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(3);
    expect(run.outputTail).toContain('boom');
  });

  it('strips ANSI colour codes from the captured tail', async () => {
    const run = await runner().start({
      key: 't1',
      worktreePath: tmpDir(),
      command: "printf '\\033[31mred\\033[0m'",
    });

    expect(run.outputTail).toBe('red');
  });

  it('times out and kills the process tree', async () => {
    const run = await runner().start({
      key: 't1',
      worktreePath: tmpDir(),
      command: 'sleep 30',
      timeoutMs: 200,
    });

    expect(run.status).toBe('timed_out');
    expect(run.message).toBe('Timed out after 0 s.');
  });

  it('cancels a running command by key', async () => {
    const r = runner();
    const pending = r.start({ key: 't1', worktreePath: tmpDir(), command: 'sleep 30' });
    await sleep(100);

    expect(r.isRunning('t1')).toBe(true);
    expect(r.cancel('t1')).toBe(true);
    const run = await pending;

    expect(run.status).toBe('cancelled');
    expect(r.isRunning('t1')).toBe(false);
    expect(r.cancel('t1')).toBe(false);
  });

  it('starting a run for the same key cancels the previous one', async () => {
    const r = runner();
    const first = r.start({ key: 't1', worktreePath: tmpDir(), command: 'sleep 30' });
    await sleep(100);
    const second = r.start({ key: 't1', worktreePath: tmpDir(), command: 'echo second' });

    const [firstRun, secondRun] = await Promise.all([first, second]);
    expect(firstRun.status).toBe('cancelled');
    expect(secondRun.status).toBe('passed');
    expect(secondRun.outputTail).toContain('second');
  });

  it('queues runs beyond the concurrency cap in FIFO order', async () => {
    const r = createVerificationRunner({ shell: '/bin/sh', maxConcurrent: 1 });
    const order: string[] = [];
    const a = r.start({
      key: 'a',
      worktreePath: tmpDir(),
      command: 'sleep 0.3; echo a',
      onOutput: (chunk) => order.push(chunk.trim()),
    });
    const b = r.start({
      key: 'b',
      worktreePath: tmpDir(),
      command: 'echo b',
      onOutput: (chunk) => order.push(chunk.trim()),
    });

    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
  });

  it('cancelling a queued run settles it at once, not when a slot frees up', async () => {
    const r = createVerificationRunner({ shell: '/bin/sh', maxConcurrent: 1 });
    const blocker = r.start({ key: 'a', worktreePath: tmpDir(), command: 'sleep 30' });
    const queued = r.start({ key: 'b', worktreePath: tmpDir(), command: 'echo never' });
    expect(r.cancel('b')).toBe(true);

    const run = await Promise.race([queued, sleep(500).then(() => 'still queued')]);
    expect(run).toMatchObject({ status: 'cancelled', outputTail: '' });

    r.cancel('a');
    await blocker;
  });

  it('cancelAll stops running and queued runs', async () => {
    const r = createVerificationRunner({ shell: '/bin/sh', maxConcurrent: 1 });
    const a = r.start({ key: 'a', worktreePath: tmpDir(), command: 'sleep 30' });
    const b = r.start({ key: 'b', worktreePath: tmpDir(), command: 'echo never' });
    await sleep(100);

    r.cancelAll();

    const runs = await Promise.all([a, b]);
    expect(runs.map((run) => run.status)).toEqual(['cancelled', 'cancelled']);
    expect(r.isRunning('a')).toBe(false);
    expect(r.isRunning('b')).toBe(false);
  });

  it("cancelPrefix stops one task's evidence checks and leaves other runs alone", async () => {
    const r = runner();
    const unit = r.start({ key: 't1:evidence:unit', worktreePath: tmpDir(), command: 'sleep 30' });
    const e2e = r.start({ key: 't1:evidence:e2e', worktreePath: tmpDir(), command: 'sleep 30' });
    await sleep(100);
    expect(r.isRunning('t1:evidence:e2e')).toBe(true);

    expect(r.cancelPrefix('t1:evidence:')).toBe(true);
    expect(r.cancelPrefix('t1:evidence:')).toBe(false);

    const runs = await Promise.all([unit, e2e]);
    expect(runs.map((run) => run.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('reports a run whose process cannot even be spawned', async () => {
    const spawnImpl = (() => {
      throw new Error('spawn ENOTDIR');
    }) as unknown as typeof spawn;

    const run = await createVerificationRunner({ shell: '/bin/sh', spawnImpl }).start({
      key: 't1',
      worktreePath: tmpDir(),
      command: 'true',
    });

    expect(run).toMatchObject({ status: 'error', exitCode: null, message: 'spawn ENOTDIR' });
  });

  it('names a missing worktree instead of blaming the shell', async () => {
    const run = await runner().start({
      key: 't1',
      worktreePath: path.join(tmpDir(), 'gone'),
      command: 'true',
    });

    expect(run.status).toBe('error');
    expect(run.message).toContain('Worktree directory is missing');
  });

  it('pins the run to HEAD and records a dirty tree inside a git checkout', async () => {
    const { repo, head } = initRepo();

    const clean = await runner().start({ key: 't1', worktreePath: repo, command: 'true' });
    expect(clean).toMatchObject({ status: 'passed', headSha: head, dirty: false });

    fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
    const dirty = await runner().start({ key: 't1', worktreePath: repo, command: 'true' });
    expect(dirty).toMatchObject({ status: 'passed', headSha: head, dirty: true });
  });

  it('records the git state after the run so a commit during the run is visible', async () => {
    const { repo, head } = initRepo();

    const run = await runner().start({
      key: 't1',
      worktreePath: repo,
      command:
        'git -c user.name=t -c user.email=t@t commit --allow-empty -q -m during && echo x > late.txt',
    });

    expect(run).toMatchObject({ status: 'passed', headSha: head, dirty: false, dirtyAfter: true });
    expect(run.headShaAfter).toMatch(/^[0-9a-f]{40}$/);
    expect(run.headShaAfter).not.toBe(head);
  });

  it('keeps the HEAD pin and counts the tree as dirty when git status fails', async () => {
    const { repo, head } = initRepo();
    fs.writeFileSync(path.join(repo, '.git', 'index'), 'not an index');

    const run = await runner().start({ key: 't1', worktreePath: repo, command: 'true' });

    expect(run).toMatchObject({ status: 'passed', headSha: head, dirty: true });
  });
});

describe('verify helpers', () => {
  it('exposes task identity to the command environment', () => {
    expect(buildVerifyEnv({ taskId: 'id-1', branchName: 'task/x', worktreePath: '/wt' })).toEqual({
      PARALLEL_CODE_TASK_ID: 'id-1',
      PARALLEL_CODE_BRANCH: 'task/x',
      PARALLEL_CODE_WORKTREE: '/wt',
    });
    expect(buildVerifyEnv({ taskId: 'id-1', worktreePath: '/wt' }).PARALLEL_CODE_BRANCH).toBe('');
  });

  it('rejects blank and oversized commands', () => {
    expect(() => validateVerifyCommand('')).toThrow('non-empty');
    expect(() => validateVerifyCommand('   ')).toThrow('non-empty');
    expect(() => validateVerifyCommand(42)).toThrow('non-empty');
    expect(() => validateVerifyCommand('x'.repeat(VERIFY_COMMAND_MAX_LENGTH + 1))).toThrow(
      'too long',
    );
    expect(() => validateVerifyCommand('npm test')).not.toThrow();
  });
});
