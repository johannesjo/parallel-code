import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'node:util';
import {
  setupCoordinatorHarness,
  resetCoordinatorMocks,
  mockNotify,
  mockExecFile,
  mockNotifyRenderer,
  mockOnPtyEvent,
  getSpawnHandler,
  getHookEventHandler,
} from './coordinator-test-harness.js';

// Match execFile's custom promisification (both stdout and stderr), including
// when a test deliberately holds a callback to expose an async publication race.
Object.defineProperty(mockExecFile, promisify.custom, {
  value: (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      mockExecFile(...args, (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    }),
});
const { Coordinator } = await setupCoordinatorHarness();
const sha = 'a'.repeat(40);
const report = { summary: 'Done', artifacts: [{ path: 'report.txt' }] };
let coordinator: InstanceType<typeof Coordinator>;

function gitResults(status = '', head = sha) {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _options: unknown,
      cb: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, args[0] === 'status' ? status : head, '');
    },
  );
}

beforeEach(async () => {
  vi.useFakeTimers();
  resetCoordinatorMocks();
  coordinator = new Coordinator();
  coordinator.setNotify(mockNotify);
  coordinator.registerCoordinator('parent', 'project', {
    projectRoot: '/project',
    automaticNotifications: false,
  });
  await coordinator.createTask({
    name: 'Child',
    prompt: 'Implement',
    coordinatorTaskId: 'parent',
    integrationPolicy: 'review',
  });
  mockNotifyRenderer.mockClear();
  gitResults();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('completion capture', () => {
  it('keeps empty legacy completion independent of Git and replaces older reports', async () => {
    const previous = await coordinator.signalDone('task-1', { result: report });
    mockExecFile.mockClear();
    coordinator.setOrchestrationEnabled(false);
    const legacy = await coordinator.signalDone('task-1', {});
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(legacy.completion).toMatchObject({
      snapshotState: 'unknown',
      reviewRevision: previous.completion.reviewRevision + 1,
    });
    expect(legacy.completion.id).not.toBe(previous.completion.id);
    expect(legacy.completion.result).toBeUndefined();
    expect(legacy.completion.sourceCommit).toBeUndefined();
    expect(coordinator.getTaskStatus('task-1')?.completion).toEqual(legacy.completion);
  });

  it.each(['', ' M report.txt\0'])(
    'associates a report with a stable HEAD and dirty state %j',
    async (status) => {
      gitResults(status);
      const result = await coordinator.signalDone('task-1', { result: report });
      expect(result).toMatchObject({
        ok: true,
        completion: {
          result: report,
          sourceCommit: sha,
          snapshotState: status ? 'dirty' : 'clean',
        },
      });
      expect(coordinator.listTasks()[0].completion).toEqual(result.completion);
      expect(mockNotifyRenderer).toHaveBeenCalledWith(
        'mcp_task_state_sync',
        expect.objectContaining({
          completion: result.completion,
          reviewRevision: result.completion.reviewRevision,
        }),
      );
      expect(await coordinator.waitForSignalDone('parent')).toMatchObject({
        taskId: 'task-1',
        completion: result.completion,
        remaining: 0,
      });
    },
  );

  it('returns reports to an already waiting parent and preserves timeout/empty variants', async () => {
    const waiter = coordinator.waitForSignalDone('parent');
    const { completion } = await coordinator.signalDone('task-1', { result: report });
    expect(await waiter).toMatchObject({ completion, remaining: 0 });
    expect(await coordinator.waitForSignalDone('parent')).toEqual({ remaining: 0 });
  });

  it('keeps a wait timeout free of a fabricated completion', async () => {
    const waiter = coordinator.waitForSignalDone('parent', 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiter).toEqual({ timedOut: true, remaining: 1 });
  });

  it('rejects malformed reports without changing earlier completion', async () => {
    const before = await coordinator.signalDone('task-1');
    mockNotifyRenderer.mockClear();
    await expect(
      coordinator.signalDone('task-1', {
        result: { summary: 'Done', artifacts: [{ path: '../secret' }] },
      }),
    ).rejects.toThrow('repository-relative');
    expect(coordinator.getTaskStatus('task-1')?.completion).toEqual(before.completion);
    expect(mockNotifyRenderer).not.toHaveBeenCalled();
  });

  it('rejects a moving HEAD without partial completion mutation', async () => {
    let reads = 0;
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _options: unknown,
        cb: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, args[0] === 'status' ? '' : ++reads === 1 ? sha : 'b'.repeat(40), '');
      },
    );
    await expect(coordinator.signalDone('task-1', { result: report })).rejects.toThrow(
      'HEAD changed',
    );
    expect(coordinator.getTaskStatus('task-1')?.signalDoneAt).toBeUndefined();
    expect(coordinator.getTaskStatus('task-1')?.completion).toBeUndefined();
    expect(mockNotifyRenderer).not.toHaveBeenCalled();
  });

  it('requires a source identity for a structured report', async () => {
    gitResults('', '');
    await expect(coordinator.signalDone('task-1', { result: report })).rejects.toThrow(
      'source commit',
    );
    expect(coordinator.getTaskStatus('task-1')?.completion).toBeUndefined();
  });

  it('does not let an overlapping capture overwrite a newer publication', async () => {
    let release: (() => void) | undefined;
    mockExecFile.mockImplementationOnce(
      (
        _cmd: string,
        _args: string[],
        _options: unknown,
        cb: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        release = () => cb(null, sha, '');
      },
    );
    const older = coordinator.signalDone('task-1', { result: report });
    const rejected = expect(older).rejects.toThrow('superseded');
    const newer = await coordinator.signalDone('task-1', { result: { summary: 'New result' } });
    release?.();
    await rejected;
    expect(coordinator.getTaskStatus('task-1')?.completion).toEqual(newer.completion);
  });

  it.each([
    'follow-up',
    'replacement',
    'native prompt',
    'hook prompt',
    'removed task',
    'expired caller',
  ])('rejects capture superseded by %s', async (action) => {
    let current = true;
    let release: (() => void) | undefined;
    mockExecFile.mockImplementationOnce(
      (
        _cmd: string,
        _args: string[],
        _options: unknown,
        cb: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        release = () => cb(null, sha, '');
      },
    );
    const pending = coordinator.signalDone('task-1', { result: report }, () => {
      if (!current) throw new Error('expired');
    });
    const rejected = expect(pending).rejects.toThrow(
      action === 'expired caller' ? 'expired' : 'superseded',
    );
    const task = coordinator.getTask('task-1');
    if (!task) throw new Error('missing fixture');
    if (action === 'follow-up') await coordinator.sendPrompt(task.id, 'new assignment');
    if (action === 'replacement') getSpawnHandler()(task.agentId, { reattached: false });
    if (action === 'native prompt') {
      const listener = mockOnPtyEvent.mock.calls.find(([name]) => name === 'prompt-submitted')?.[1];
      listener?.(task.agentId);
    }
    if (action === 'hook prompt')
      getHookEventHandler()({
        agentId: task.agentId,
        taskId: task.id,
        event: 'UserPromptSubmit',
        state: 'working',
        at: Date.now(),
      });
    if (action === 'removed task') coordinator.removeCoordinatedTask(task.id);
    if (action === 'expired caller') current = false;
    release?.();
    await rejected;
    expect(task.completion).toBeUndefined();
  });

  it('reattachment and secondary input preserve the completion capture', async () => {
    let release: (() => void) | undefined;
    mockExecFile.mockImplementationOnce(
      (
        _cmd: string,
        _args: string[],
        _options: unknown,
        cb: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        release = () => cb(null, sha, '');
      },
    );
    const pending = coordinator.signalDone('task-1', { result: report });
    const task = coordinator.getTask('task-1');
    if (!task) throw new Error('missing fixture');
    getSpawnHandler()(task.agentId, { reattached: true });
    const listener = mockOnPtyEvent.mock.calls.find(([name]) => name === 'prompt-submitted')?.[1];
    listener?.('secondary-agent');
    release?.();
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it('restores valid metadata without replacing it on reattachment, tolerating invalid saves', async () => {
    const { completion } = await coordinator.signalDone('task-1', { result: report });
    const base = {
      id: 'restored',
      name: 'Restored',
      projectId: 'project',
      projectRoot: '/project',
      branchName: 'task/restored',
      worktreePath: '/restored',
      agentId: 'restored-agent',
      coordinatorTaskId: 'parent',
    };
    coordinator.hydrateTask({ ...base, completion });
    expect(coordinator.getTaskStatus(base.id)?.completion).toEqual(completion);
    expect(coordinator.getTaskStatus(base.id)?.reviewRevision).toBe(completion.reviewRevision);
    coordinator.hydrateTask({ ...base, completion: undefined });
    expect(coordinator.getTaskStatus(base.id)?.completion).toEqual(completion);
    coordinator.hydrateTask({
      ...base,
      id: 'invalid',
      completion: { ...completion, sourceCommit: 'bad' },
    });
    expect(coordinator.getTaskStatus('invalid')?.completion).toBeUndefined();
  });
});
