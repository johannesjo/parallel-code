import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { VerificationRun } from '../ipc/types';

const { mockInvoke, mockSaveState, mockSendPrompt, FakeChannel } = vi.hoisted(() => {
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
    FakeChannel,
  };
});
type FakeChannel = InstanceType<typeof FakeChannel>;

vi.mock('../lib/ipc', () => ({
  invoke: mockInvoke,
  fireAndForget: vi.fn(),
  Channel: FakeChannel,
}));
vi.mock('./persistence', () => ({ saveState: mockSaveState }));
vi.mock('./tasks', () => ({ sendPrompt: mockSendPrompt }));

import { setStore, store } from './core';
import type { Project } from './types';
import {
  getVerificationOutput,
  getVerifyCommand,
  runTaskVerification,
  sendVerificationFailureToAgent,
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
