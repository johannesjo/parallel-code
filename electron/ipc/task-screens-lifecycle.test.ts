import { existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { gitCalls, statusOut, mockStart, mockBaseSha, mockShoot, mockServe, mockPorts } = vi.hoisted(
  () => ({
    gitCalls: [] as string[][],
    /** What each `git status` answers, in order; then nothing changed. */
    statusOut: [] as string[],
    mockPorts: vi.fn(),
    mockStart: vi.fn(),
    mockBaseSha: vi.fn(),
    mockShoot: vi.fn(),
    mockServe: vi.fn(),
  }),
);

vi.mock('child_process', () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (error: Error | null, out?: { stdout: string }) => void,
  ) => {
    gitCalls.push(args);
    const status = args.includes('status') ? (statusOut.shift() ?? '') : '';
    cb(null, { stdout: args[0] === 'rev-parse' ? 'head1\n' : status });
  },
}));
// A temp folder of its own, so the test can see what a run leaves behind.
vi.mock('os', async (importOriginal) => {
  const os = await importOriginal<typeof import('os')>();
  const { mkdtempSync } = await import('fs');
  const { join } = await import('path');
  const root = mkdtempSync(join(os.tmpdir(), 'pc-screens-test-'));
  return { ...os, tmpdir: () => root };
});
vi.mock('./git.js', () => ({ getDiffBaseSha: mockBaseSha }));
vi.mock('./task-screens-run.js', () => ({ startCapture: mockStart, killAllCaptures: vi.fn() }));
vi.mock('./task-screens-serve.js', () => ({
  freePorts: mockPorts,
  startServer: mockServe,
}));
vi.mock('./task-screens-shoot.js', () => ({
  shootPage: mockShoot,
  VIEWPORT: { width: 1280, height: 800 },
}));

import { approveTaskScreens, cancelTaskScreens, captureTaskScreens } from './task-screens.js';
import type { ServeCommands } from '../shared/task-screens.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
// Allows the commands at once, as a user clicking Start would.
const args = {
  taskId: 't1',
  worktreePath: '/wt',
  onStep: () => undefined,
  onAsk: (commands: ServeCommands) => approveTaskScreens('t1', commands),
};

const runEnv = { PC_SCREENS_RUN: 'tag1' };

/** A run that answers with these screens; returns its stop and end mocks. */
function answerWith(answer: object) {
  const capture = {
    result: Promise.resolve(
      JSON.stringify({ after: 'serve after', before: 'serve before', ...answer }),
    ),
    stop: vi.fn(),
    end: vi.fn(),
    env: runEnv,
  };
  mockStart.mockReturnValue(capture);
  return capture;
}

const login = { label: 'Login', before: '/login', after: '/' };

beforeEach(() => {
  gitCalls.length = 0;
  statusOut.length = 0;
  mockStart.mockReset();
  mockShoot.mockReset().mockResolvedValue(PNG);
  mockBaseSha.mockReset().mockResolvedValue('base1');
  mockServe.mockReset().mockResolvedValue(undefined);
  mockPorts.mockReset().mockResolvedValue([8101, 8102]);
});

describe('captureTaskScreens', () => {
  it('serves both versions with the run’s environment, photographs them, then stops the servers', async () => {
    const capture = answerWith({ shots: [login] });
    const result = await captureTaskScreens(args);
    const served = mockServe.mock.calls.map(([opts]) => opts);
    expect(served).toEqual([
      expect.objectContaining({ cwd: '/wt', command: 'serve after', port: 8101, env: runEnv }),
      expect.objectContaining({ command: 'serve before', port: 8102, env: runEnv }),
    ]);
    expect(served[1].cwd).toMatch(/pc-screens-base-.*base$/);
    expect(mockShoot.mock.calls).toEqual([
      ['http://localhost:8101/'],
      ['http://localhost:8102/login'],
    ]);
    expect(result.headSha).toBe('head1');
    expect(result.shots[0].before?.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(existsSync(result.shots[0].after.path)).toBe(true);
    expect(capture.end).toHaveBeenCalled();
    // The base checkout is removed and its registration pruned.
    expect(gitCalls.some((a) => a[0] === 'worktree' && a[1] === 'remove')).toBe(true);
    expect(gitCalls.some((a) => a[0] === 'worktree' && a[1] === 'prune')).toBe(true);
  });

  it('asks before running the commands, and serves only once allowed', async () => {
    answerWith({ shots: [login] });
    const onAsk = vi.fn();
    const result = captureTaskScreens({ ...args, onAsk });
    await vi.waitFor(() =>
      expect(onAsk).toHaveBeenCalledWith({ after: 'serve after', before: 'serve before' }),
    );
    expect(mockServe).not.toHaveBeenCalled();
    approveTaskScreens('t1', { after: 'serve after', before: 'serve before' });
    await expect(result).resolves.toMatchObject({ headSha: 'head1' });
    expect(mockServe).toHaveBeenCalledTimes(2);
  });

  it('asks only for the commands it will run', async () => {
    answerWith({ shots: [{ label: 'New', after: '/new' }] });
    const onAsk = vi.fn(args.onAsk);
    await captureTaskScreens({ ...args, onAsk });
    expect(onAsk).toHaveBeenCalledWith({ after: 'serve after' });
  });

  it('runs only the commands the user allowed', async () => {
    answerWith({ shots: [login] });
    const result = captureTaskScreens({ ...args, onAsk: vi.fn() });
    await vi.waitFor(() => expect(gitCalls.some((a) => a[0] === 'worktree')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    approveTaskScreens('t1', { after: 'serve after', before: 'rm -rf ~' });
    approveTaskScreens('t1', { after: 'serve after' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockServe).not.toHaveBeenCalled();
    approveTaskScreens('t1', { after: 'serve after', before: 'serve before' });
    await expect(result).resolves.toMatchObject({ headSha: 'head1' });
  });

  it('starts no server when cancelled right after the user allowed it', async () => {
    const capture = answerWith({ shots: [login] });
    const onAsk = (commands: ServeCommands) => {
      approveTaskScreens('t1', commands);
      cancelTaskScreens('t1');
    };
    await expect(captureTaskScreens({ ...args, onAsk })).rejects.toThrow('cancelled');
    expect(mockServe).not.toHaveBeenCalled();
    expect(capture.end).toHaveBeenCalled();
  });

  it('gives up when nobody starts the app in time', async () => {
    answerWith({ shots: [login] });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const onAsk = () => vi.advanceTimersByTime(30 * 60_000);
      await expect(captureTaskScreens({ ...args, onAsk })).rejects.toThrow(
        'Nobody started the app',
      );
      expect(mockServe).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves nothing when cancelled while asking', async () => {
    const capture = answerWith({ shots: [login] });
    const onAsk = () => cancelTaskScreens('t1');
    await expect(captureTaskScreens({ ...args, onAsk })).rejects.toThrow('cancelled');
    expect(mockServe).not.toHaveBeenCalled();
    expect(capture.end).toHaveBeenCalled();
  });

  it('names the files that serving the task changed in it', async () => {
    answerWith({ shots: [login] });
    statusOut.push(' M src/app.ts\n', ' M src/app.ts\n M next-env.d.ts\n?? .cache/\n');
    const result = await captureTaskScreens(args);
    expect(result.note).toBe('Starting the app changed files in the task: next-env.d.ts, .cache/.');
    // Reading the status must not hold the index lock against the task's own agent.
    expect(gitCalls).toContainEqual(['--no-optional-locks', 'status', '--porcelain']);
  });

  it('leaves out a screen whose page fails, and says why', async () => {
    answerWith({ shots: [login, { label: 'New', after: '/new' }] });
    mockShoot.mockImplementation(async (url: string) => {
      if (url.endsWith('/new')) throw new Error('ERR_CONNECTION_REFUSED');
      return PNG;
    });
    const result = await captureTaskScreens(args);
    expect(result.shots.map((shot) => shot.label)).toEqual(['Login']);
    expect(result.note).toBe('1 of the screens could not be photographed: ERR_CONNECTION_REFUSED');
  });

  it('leaves out the screens of a version that did not start, with the end of its output', async () => {
    answerWith({ shots: [login, { label: 'New', after: '/new' }] });
    mockServe.mockImplementation(async (opts: { port: number }) => {
      if (opts.port === 8102)
        throw new Error('The server exited with code 1. Its output ends: boom');
    });
    const result = await captureTaskScreens(args);
    expect(result.shots.map((shot) => shot.label)).toEqual(['New']);
    expect(result.note).toBe(
      '1 of the screens could not be photographed: The version before the task did not start: The server exited with code 1. Its output ends: boom',
    );
  });

  it('starts only the version after when no screen existed before', async () => {
    answerWith({ before: null, shots: [{ label: 'New', after: '/new' }] });
    await captureTaskScreens(args);
    expect(mockServe).toHaveBeenCalledTimes(1);
  });

  it('photographs nothing when cancelled while the servers start', async () => {
    const capture = answerWith({ shots: [login] });
    mockServe.mockImplementation(async () => cancelTaskScreens('t1'));
    await expect(captureTaskScreens(args)).rejects.toThrow('cancelled');
    expect(mockShoot).not.toHaveBeenCalled();
    expect(capture.end).toHaveBeenCalled();
  });

  it('says so when a run captured nothing and gave no reason', async () => {
    answerWith({ shots: [] });
    expect((await captureTaskScreens(args)).note).toBe('No screens were captured.');
  });

  it('lets the next run start after one failed before the CLI ran', async () => {
    mockBaseSha.mockRejectedValueOnce(new Error('no base'));
    await expect(captureTaskScreens(args)).rejects.toThrow('no base');
    answerWith({ shots: [login] });
    await expect(captureTaskScreens(args)).resolves.toMatchObject({ headSha: 'head1' });
  });

  it('replaces a run the renderer lost track of, such as after a reload', async () => {
    answerWith({ shots: [login] });
    let rejectFirst: (error: Error) => void = () => undefined;
    const first = {
      result: new Promise<string>((_, reject) => (rejectFirst = reject)),
      stop: vi.fn((reason: string) => rejectFirst(new Error(reason))),
      end: vi.fn(),
      env: runEnv,
    };
    mockStart.mockReturnValueOnce(first);
    const lost = captureTaskScreens(args);
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledOnce());
    const next = captureTaskScreens(args);
    await expect(lost).rejects.toThrow('cancelled');
    expect(first.end).toHaveBeenCalled();
    await expect(next).resolves.toMatchObject({ headSha: 'head1' });
  });

  it('never starts the CLI when cancelled during setup', async () => {
    mockBaseSha.mockImplementation(async () => {
      cancelTaskScreens('t1');
      return 'base1';
    });
    await expect(captureTaskScreens(args)).rejects.toThrow('cancelled');
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('never starts the CLI when cancelled while finding ports', async () => {
    mockPorts.mockImplementation(async () => {
      cancelTaskScreens('t1');
      return [8101, 8102];
    });
    await expect(captureTaskScreens(args)).rejects.toThrow('cancelled');
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('tells the servers starting up when the run is cancelled', async () => {
    answerWith({ shots: [login] });
    let cancelledSeen: boolean | undefined;
    mockServe.mockImplementation(async (opts: { cancelled: () => boolean }) => {
      cancelTaskScreens('t1');
      cancelledSeen = opts.cancelled();
    });
    await expect(captureTaskScreens(args)).rejects.toThrow('cancelled');
    expect(cancelledSeen).toBe(true);
  });

  it('stops photographing when cancelled between screens', async () => {
    const capture = answerWith({ shots: [login, login] });
    mockShoot.mockImplementation(async () => {
      cancelTaskScreens('t1');
      return PNG;
    });
    await expect(captureTaskScreens(args)).rejects.toThrow('cancelled');
    expect(mockShoot).toHaveBeenCalledTimes(2);
    expect(capture.stop).toHaveBeenCalledWith('cancelled');
    expect(capture.end).toHaveBeenCalled();
  });

  it('deletes a failed run’s files and, on cancel, a finished run’s screenshots', async () => {
    answerWith({ shots: [login] });
    const { shots } = await captureTaskScreens(args);
    const file = shots[0].after.path;
    cancelTaskScreens('t1');
    await vi.waitFor(() => expect(existsSync(file)).toBe(false));

    const end = vi.fn();
    mockStart.mockImplementation(() => ({
      result: Promise.reject(new Error('claude failed')),
      stop: vi.fn(),
      end,
      env: runEnv,
    }));
    await expect(captureTaskScreens(args)).rejects.toThrow('claude failed');
    expect(end).toHaveBeenCalled();
    expect(readdirSync(tmpdir())).toEqual([]);
  });
});
