import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { VerificationRun } from '../ipc/types';

const { mockInvoke, mockSaveState, mockSendPrompt, mockStagePrompt, FakeChannel } = vi.hoisted(
  () => {
    class FakeChannel {
      onmessage: ((msg: string) => void) | null = null;
      dispose = vi.fn();
      toJSON() {
        return { __CHANNEL_ID__: 'fake' };
      }
    }
    return {
      mockInvoke: vi.fn(),
      mockSaveState: vi.fn(),
      mockSendPrompt: vi.fn(),
      mockStagePrompt: vi.fn(),
      FakeChannel,
    };
  },
);
type FakeChannel = InstanceType<typeof FakeChannel>;

vi.mock('../lib/ipc', () => ({
  invoke: mockInvoke,
  fireAndForget: vi.fn(),
  Channel: FakeChannel,
}));
vi.mock('./persistence', () => ({ saveState: mockSaveState }));
vi.mock('./tasks', () => ({ sendPrompt: mockSendPrompt }));
vi.mock('./staged-prompt', () => ({ stageTaskPrompt: mockStagePrompt }));

import { setStore, store } from './core';
import type { EvidenceScan } from '../../electron/shared/evidence';
import { HELD_RUN_MESSAGE } from '../../electron/shared/verification-run';
import type { Project } from './types';
import {
  cancelBackgroundVerify,
  getBackgroundVerifyHold,
  getVerificationOutput,
  getVerifyCommand,
  runBackgroundVerify,
  runTaskVerification,
  sendVerificationFailureToAgent,
  stageVerificationFailurePrompt,
} from './verification';

function finishedRun(overrides: Partial<VerificationRun> = {}): VerificationRun {
  return {
    command: 'npm test',
    status: 'passed',
    exitCode: 0,
    headSha: 'abc',
    dirty: false,
    startedAt: '2026-09-03T10:00:00.000Z',
    finishedAt: '2026-09-03T10:01:00.000Z',
    outputTail: 'all good\n',
    ...overrides,
  };
}

function channelOf(call: number): FakeChannel {
  const args = mockInvoke.mock.calls[call]?.[1] as { onOutput: FakeChannel };
  return args.onOutput;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveState.mockResolvedValue(undefined);
  mockSendPrompt.mockResolvedValue(undefined);
  setStore('projects', [
    { id: 'p1', name: 'Repo', path: '/repo', verifyCommand: 'npm test' } as Project,
    { id: 'p2', name: 'Other', path: '/other' } as Project,
  ]);
  setStore('taskOrder', ['t1', 't2']);
  setStore('tasks', {
    t1: {
      id: 't1',
      name: 'Task',
      projectId: 'p1',
      branchName: 'task/t1',
      worktreePath: '/repo/.worktrees/t1',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
    },
    t2: {
      id: 't2',
      name: 'Unconfigured',
      projectId: 'p2',
      branchName: 'task/t2',
      worktreePath: '/other/.worktrees/t2',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
    },
  });
});

describe('runTaskVerification', () => {
  it('streams live output while running and stores the finished run', async () => {
    let resolveRun: (run: VerificationRun) => void = () => {};
    mockInvoke.mockReturnValueOnce(new Promise<VerificationRun>((r) => (resolveRun = r)));

    const pending = runTaskVerification('t1');
    await flush();

    expect(store.tasks.t1.verificationRun).toMatchObject({
      status: 'running',
      command: 'npm test',
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      IPC.RunTaskVerification,
      expect.objectContaining({
        taskId: 't1',
        worktreePath: '/repo/.worktrees/t1',
        command: 'npm test',
        branchName: 'task/t1',
      }),
    );
    channelOf(0).onmessage?.('compiling...\n');
    expect(getVerificationOutput('t1')).toBe('compiling...\n');

    resolveRun(finishedRun());
    const run = await pending;

    expect(run?.status).toBe('passed');
    expect(store.tasks.t1.verificationRun).toEqual(finishedRun());
    expect(getVerificationOutput('t1')).toBe('all good\n');
    expect(channelOf(0).dispose).toHaveBeenCalled();
    expect(mockSaveState).toHaveBeenCalled();
  });

  it('does nothing when the project has no verify command', async () => {
    expect(getVerifyCommand('t2')).toBeUndefined();
    expect(await runTaskVerification('t2')).toBeUndefined();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(store.tasks.t2.verificationRun).toBeUndefined();
  });

  it('lets a newer run win over the cancelled run it replaced', async () => {
    let resolveFirst: (run: VerificationRun) => void = () => {};
    let resolveSecond: (run: VerificationRun) => void = () => {};
    mockInvoke
      .mockReturnValueOnce(new Promise<VerificationRun>((r) => (resolveFirst = r)))
      .mockReturnValueOnce(new Promise<VerificationRun>((r) => (resolveSecond = r)));

    const first = runTaskVerification('t1');
    await flush();
    const second = runTaskVerification('t1');
    await flush();

    channelOf(0).onmessage?.('stale chunk');
    expect(getVerificationOutput('t1')).toBe('');

    resolveFirst(finishedRun({ status: 'cancelled', exitCode: null }));
    await first;
    expect(store.tasks.t1.verificationRun?.status).toBe('running');

    resolveSecond(finishedRun({ outputTail: 'second\n' }));
    await second;
    expect(store.tasks.t1.verificationRun).toMatchObject({
      status: 'passed',
      outputTail: 'second\n',
    });
  });

  it("drops the previous run's message instead of merging it into the next run", async () => {
    mockInvoke.mockResolvedValueOnce(
      finishedRun({ status: 'timed_out', exitCode: null, message: 'Timed out after 10 min.' }),
    );
    await runTaskVerification('t1');
    expect(store.tasks.t1.verificationRun?.message).toBe('Timed out after 10 min.');

    mockInvoke.mockResolvedValueOnce(finishedRun());
    await runTaskVerification('t1');
    expect(store.tasks.t1.verificationRun?.status).toBe('passed');
    expect(store.tasks.t1.verificationRun?.message).toBeUndefined();
  });

  it('records an error run when the main process rejects', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('verify command too long'));

    const run = await runTaskVerification('t1');

    expect(run).toMatchObject({ status: 'error', message: 'verify command too long' });
    expect(store.tasks.t1.verificationRun?.status).toBe('error');
  });
});

describe('sendVerificationFailureToAgent', () => {
  it('sends the failing output to the agent as a prompt', async () => {
    setStore(
      'tasks',
      't1',
      'verificationRun',
      finishedRun({ status: 'failed', exitCode: 1, outputTail: '1 test failed\n' }),
    );

    expect(await sendVerificationFailureToAgent('t1', 'agent-1')).toBe(true);
    const prompt = mockSendPrompt.mock.calls[0]?.[2] as string;
    expect(mockSendPrompt).toHaveBeenCalledWith('t1', 'agent-1', expect.any(String));
    expect(prompt).toContain('`npm test`');
    expect(prompt).toContain('Exit code: 1');
    expect(prompt).toContain('1 test failed');
  });

  it('sends nothing for a passing or missing run', async () => {
    setStore('tasks', 't1', 'verificationRun', finishedRun());
    expect(await sendVerificationFailureToAgent('t1', 'agent-1')).toBe(false);
    expect(await sendVerificationFailureToAgent('t2', 'agent-1')).toBe(false);
    expect(mockSendPrompt).not.toHaveBeenCalled();
  });
});

describe('last pass', () => {
  it('remembers a clean pass, and not one with uncommitted changes', async () => {
    mockInvoke.mockResolvedValueOnce(finishedRun({ headSha: 'good' }));
    await runTaskVerification('t1');
    mockInvoke.mockResolvedValueOnce(finishedRun({ headSha: 'dirty', dirty: true }));
    await runTaskVerification('t1');

    expect(store.tasks.t1.lastVerifyPass).toEqual({
      command: 'npm test',
      headSha: 'good',
      finishedAt: '2026-09-03T10:01:00.000Z',
    });
  });

  it('points the staged fix prompt at the last passing commit', () => {
    setStore('tasks', 't1', 'lastVerifyPass', {
      command: 'npm test',
      headSha: 'good',
      finishedAt: 'x',
    });
    setStore('tasks', 't1', 'verificationRun', finishedRun({ status: 'failed', exitCode: 1 }));

    expect(stageVerificationFailurePrompt('t1')).toBe(true);
    const prompt = mockStagePrompt.mock.calls[0]?.[1] as string;
    expect(prompt).toContain('last passed at commit good');
    expect(prompt).toContain('`git diff good`');
  });

  it('stages nothing while a run passes', () => {
    setStore('tasks', 't1', 'verificationRun', finishedRun());
    expect(stageVerificationFailurePrompt('t1')).toBe(false);
    expect(mockStagePrompt).not.toHaveBeenCalled();
  });
});

function scan(overrides: Partial<EvidenceScan> = {}): EvidenceScan {
  return {
    headSha: 'head',
    baseSha: 'base',
    dirty: false,
    files: [{ path: 'src/a.ts', status: 'M', added: 1, removed: 0, role: 'source' }],
    flags: [],
    tests: [],
    coveringTests: [],
    sourceWithoutTests: [],
    ...overrides,
  };
}

/** Answers the evidence scan, and the verify run with `run` (or holds it open). */
function mockBackground(next: EvidenceScan, run?: VerificationRun | Promise<VerificationRun>) {
  mockInvoke.mockImplementation((channel: string) => {
    if (channel === IPC.GetEvidenceScan) return Promise.resolve(next);
    if (channel === IPC.RunTaskVerification) return Promise.resolve(run ?? finishedRun());
    return Promise.resolve(true);
  });
}

describe('runBackgroundVerify', () => {
  it('runs at low priority, pinned to the scanned commit', async () => {
    mockBackground(scan(), finishedRun({ headSha: 'head' }));

    const run = await runBackgroundVerify('t1');

    expect(run?.status).toBe('passed');
    expect(mockInvoke).toHaveBeenCalledWith(
      IPC.RunTaskVerification,
      expect.objectContaining({ expectedHeadSha: 'head', lowPriority: true }),
    );
  });

  it('runs once per commit: a result on this commit, pass or fail, is enough', async () => {
    setStore(
      'tasks',
      't1',
      'verificationRun',
      finishedRun({ status: 'failed', exitCode: 1, headSha: 'head' }),
    );
    mockBackground(scan());

    expect(await runBackgroundVerify('t1')).toBeUndefined();
    expect(mockInvoke).not.toHaveBeenCalledWith(IPC.RunTaskVerification, expect.anything());
  });

  it('skips a branch without changes', async () => {
    mockBackground(scan({ files: [] }));
    expect(await runBackgroundVerify('t1')).toBeUndefined();
    expect(mockInvoke).not.toHaveBeenCalledWith(IPC.RunTaskVerification, expect.anything());
  });

  it('holds uncommitted work back and says why', async () => {
    mockBackground(scan({ dirty: true }));

    expect(await runBackgroundVerify('t1')).toBeUndefined();
    expect(mockInvoke).not.toHaveBeenCalledWith(IPC.RunTaskVerification, expect.anything());
    expect(getBackgroundVerifyHold('t1')).toEqual({ headSha: 'head', reason: 'dirty' });
  });

  it('holds a change to how checks run until the reviewer accepts it', async () => {
    const flag = {
      id: 'surface-1',
      category: 'needs-decision' as const,
      rule: 'execution-surface-changed',
      file: 'package.json',
      detail: 'changed',
    };
    mockBackground(scan({ flags: [flag] }));
    expect(await runBackgroundVerify('t1')).toBeUndefined();
    expect(getBackgroundVerifyHold('t1')?.reason).toBe('execution-surface');
  });

  it('is off for Docker tasks and when the project turned it off', async () => {
    mockBackground(scan());
    setStore('tasks', 't1', 'dockerMode', true);
    expect(await runBackgroundVerify('t1')).toBeUndefined();
    setStore('tasks', 't1', 'dockerMode', false);
    setStore('projects', 0, 'verifyAutoRun', false);
    expect(await runBackgroundVerify('t1')).toBeUndefined();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('asks again whether the agent is idle once the scan is back', async () => {
    let idle = true;
    mockInvoke.mockImplementation((channel: string) => {
      if (channel !== IPC.GetEvidenceScan) return Promise.resolve(finishedRun());
      idle = false;
      return Promise.resolve(scan());
    });
    expect(await runBackgroundVerify('t1', () => idle)).toBeUndefined();
    expect(mockInvoke).not.toHaveBeenCalledWith(IPC.RunTaskVerification, expect.anything());
  });

  it('records a hold when the runner finds uncommitted changes at start', async () => {
    mockBackground(
      scan(),
      finishedRun({
        status: 'cancelled',
        exitCode: null,
        headSha: 'head',
        dirty: true,
        outputTail: '',
        message: HELD_RUN_MESSAGE,
      }),
    );
    await runBackgroundVerify('t1');
    expect(getBackgroundVerifyHold('t1')).toEqual({ headSha: 'head', reason: 'dirty' });
  });

  it('never starts over a run already in flight', async () => {
    setStore('tasks', 't1', 'verificationRun', finishedRun({ status: 'running' }));
    mockBackground(scan());
    expect(await runBackgroundVerify('t1')).toBeUndefined();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('leaves the previous result in place when the run is held at start', async () => {
    const previous = finishedRun({ headSha: 'older' });
    setStore('tasks', 't1', 'verificationRun', previous);
    mockBackground(scan(), finishedRun({ status: 'cancelled', exitCode: null, headSha: 'moved' }));

    await runBackgroundVerify('t1');

    expect(store.tasks.t1.verificationRun).toMatchObject({ status: 'passed', headSha: 'older' });
  });
});

describe('cancelBackgroundVerify', () => {
  it('stops a background run and keeps the result it replaced', async () => {
    setStore('tasks', 't1', 'verificationRun', finishedRun({ headSha: 'older' }));
    let finish: (run: VerificationRun) => void = () => {};
    mockBackground(scan(), new Promise<VerificationRun>((resolve) => (finish = resolve)));
    const pending = runBackgroundVerify('t1');
    await flush();

    await cancelBackgroundVerify('t1');

    expect(mockInvoke).toHaveBeenCalledWith(IPC.CancelTaskVerification, { taskId: 't1' });
    finish(finishedRun({ status: 'cancelled', exitCode: null }));
    await pending;
    expect(store.tasks.t1.verificationRun).toMatchObject({ status: 'passed', headSha: 'older' });
  });

  it('keeps a run from starting when cancelled during the scan', async () => {
    let answer: (value: EvidenceScan) => void = () => {};
    mockInvoke.mockImplementation((channel: string) =>
      channel === IPC.GetEvidenceScan
        ? new Promise<EvidenceScan>((resolve) => (answer = resolve))
        : Promise.resolve(finishedRun()),
    );
    const pending = runBackgroundVerify('t1');
    await flush();

    await cancelBackgroundVerify('t1');
    answer(scan());

    expect(await pending).toBeUndefined();
    expect(mockInvoke).not.toHaveBeenCalledWith(IPC.RunTaskVerification, expect.anything());
  });

  it('leaves a run the user started alone', async () => {
    let finish: (run: VerificationRun) => void = () => {};
    mockInvoke.mockReturnValueOnce(new Promise<VerificationRun>((resolve) => (finish = resolve)));
    const pending = runTaskVerification('t1');
    await flush();

    cancelBackgroundVerify('t1');

    expect(mockInvoke).not.toHaveBeenCalledWith(IPC.CancelTaskVerification, expect.anything());
    finish(finishedRun());
    await pending;
  });
});
