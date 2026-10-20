import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setupCoordinatorHarness,
  resetCoordinatorMocks,
  registerDefaultCoordinator,
  getOutputCb,
  getExitHandler,
  getHookEventHandler,
  getPromptSubmittedHandler,
  getSpawnHandler,
  getAgentTextWrites,
  encodeAgentOutput as encode,
  mockGetAgentScrollback,
  mockDeleteBackendTask,
  mockSpawnAgent,
  mockKillAgent,
  mockNotifyRenderer,
  mockCreateBackendTask,
  mockWriteToAgent,
} from './coordinator-test-harness.js';

const { Coordinator } = await setupCoordinatorHarness();
type TestCoordinator = InstanceType<typeof Coordinator>;
type HookEvent = Parameters<ReturnType<typeof getHookEventHandler>>[0];

function hook(agentId: string, overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    agentId,
    taskId: '',
    state: 'working',
    event: 'UserPromptSubmit',
    at: Date.now(),
    ...overrides,
  };
}

let coordinator: TestCoordinator;
let counter = 0;

beforeEach(() => {
  resetCoordinatorMocks();
  counter = 0;
  mockCreateBackendTask.mockImplementation(async () => {
    counter += 1;
    return {
      id: `task-${counter}`,
      branch_name: `task/t${counter}`,
      worktree_path: `/tmp/t${counter}`,
    };
  });
  coordinator = registerDefaultCoordinator(new Coordinator());
  coordinator.registerCoordinator('coord-1', 'proj-1');
});

afterEach(() => {
  vi.useRealTimers();
});

function track<T>(promise: Promise<T>): { settled: () => boolean; promise: Promise<T> } {
  let done = false;
  const wrapped = promise.finally(() => {
    done = true;
  });
  // Callers assert on the outcome themselves; avoid an unhandled rejection meanwhile.
  wrapped.catch(() => undefined);
  return { settled: () => done, promise: wrapped };
}

describe('wait_for_idle before the assignment is delivered', () => {
  it('does not report idle on the first prompt while the initial prompt is undelivered', async () => {
    vi.useFakeTimers();
    await coordinator.createTask({ name: 't', prompt: 'do work', coordinatorTaskId: 'coord-1' });
    const wait = track(coordinator.waitForIdle('task-1', 60_000));

    getOutputCb()(encode('❯ '));
    await vi.advanceTimersByTimeAsync(10);

    expect(wait.settled()).toBe(false);
    expect(getAgentTextWrites()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(getAgentTextWrites().join('')).toContain('do work');
    expect(wait.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(3_000);
    getOutputCb()(encode('Working...\n'));
    getOutputCb()(encode('Done ❯ '));
    await expect(wait.promise).resolves.toEqual({ reason: 'idle' });
  });

  it('does not report idle on a startup hook Stop while the initial prompt is undelivered', async () => {
    vi.useFakeTimers();
    const task = await coordinator.createTask({
      name: 't',
      prompt: 'do work',
      coordinatorTaskId: 'coord-1',
    });
    const wait = track(coordinator.waitForIdle(task.id, 60_000));

    getHookEventHandler()(hook(task.agentId, { event: 'SessionStart', state: 'done' }));
    await vi.advanceTimersByTimeAsync(10);

    expect(wait.settled()).toBe(false);
    expect(task.status).not.toBe('idle');
  });

  it('does not resolve an already-idle task while a queued prompt remains', async () => {
    vi.useFakeTimers();
    const task = await coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' });
    task.status = 'idle';
    task.pendingPrompts = ['next'];
    const wait = track(coordinator.waitForIdle(task.id, 60_000));
    await vi.advanceTimersByTimeAsync(10);
    expect(wait.settled()).toBe(false);
  });
});

describe('queued prompts respect agent readiness', () => {
  it('does not flush a queued prompt into a busy agent after a direct write', async () => {
    vi.useFakeTimers();
    const task = await coordinator.createTask({
      name: 't',
      prompt: 'x',
      coordinatorTaskId: 'coord-1',
    });
    coordinator.markPromptDelivered(task.id);
    const first = coordinator.sendPrompt(task.id, 'first');
    await expect(coordinator.sendPrompt(task.id, 'second')).resolves.toEqual({ queued: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await first;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(getAgentTextWrites()).toEqual(['first']);

    getOutputCb()(encode('Done ❯ '));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getAgentTextWrites()).toEqual(['first', 'second']);
  });

  it('does not flush on control return until the agent shows a prompt', async () => {
    vi.useFakeTimers();
    const task = await coordinator.createTask({
      name: 't',
      prompt: 'x',
      coordinatorTaskId: 'coord-1',
    });
    coordinator.markPromptDelivered(task.id);
    coordinator.setTaskControl(task.id, 'human');
    await coordinator.sendPrompt(task.id, 'queued');

    coordinator.setTaskControl(task.id, 'coordinator');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getAgentTextWrites()).toEqual([]);

    getOutputCb()(encode('Done ❯ '));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getAgentTextWrites()).toEqual(['queued']);
  });
});

describe('initial prompt Enter failure', () => {
  async function strandAssignment() {
    vi.useFakeTimers();
    const task = await coordinator.createTask({
      name: 't',
      prompt: 'do work',
      coordinatorTaskId: 'coord-1',
    });
    await coordinator.sendPrompt(task.id, 'next');
    let enterFailed = false;
    mockWriteToAgent.mockImplementation((agentId: string, data: string) => {
      if (data === '\r' && !enterFailed) {
        enterFailed = true;
        throw new Error('pty enter failed');
      }
      return { id: agentId, data };
    });
    getOutputCb()(encode('❯ '));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getAgentTextWrites().join('')).toContain('do work');
    mockWriteToAgent.mockClear();
    return task;
  }

  it('submits the stranded body, then flushes prompts queued behind it', async () => {
    await strandAssignment();
    getOutputCb()(encode('Done ❯ '));
    await vi.advanceTimersByTimeAsync(3_000);
    // Submitted on its own, not merged with the queued prompt.
    expect(getAgentTextWrites()).toEqual([]);
    expect(mockWriteToAgent).toHaveBeenCalledWith(expect.anything(), '\r');

    getOutputCb()(encode('Worked ❯ '));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getAgentTextWrites()).toEqual(['next']);
  });

  it('does not type the queued prompt on output left over from before the submit', async () => {
    await strandAssignment();
    getOutputCb()(encode('Done ❯ '));
    await vi.advanceTimersByTimeAsync(3_000);
    getOutputCb()(encode('\x1b[2K'));
    await vi.advanceTimersByTimeAsync(10);
    expect(getAgentTextWrites()).toEqual([]);
  });

  it('sends no stray Enter once the body was submitted another way', async () => {
    const task = await strandAssignment();
    getPromptSubmittedHandler()(task.agentId);
    getOutputCb()(encode('Done ❯ '));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getAgentTextWrites()).toEqual(['next']);
    // Only the queued prompt's own Enter.
    expect(mockWriteToAgent.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(1);
  });
});

describe('stranded prompt without a queue', () => {
  it('retries the Enter instead of reporting the unstarted task idle', async () => {
    vi.useFakeTimers();
    const task = await coordinator.createTask({
      name: 't',
      prompt: 'do work',
      coordinatorTaskId: 'coord-1',
    });
    let enterFailed = false;
    mockWriteToAgent.mockImplementation((agentId: string, data: string) => {
      if (data === '\r' && !enterFailed) {
        enterFailed = true;
        throw new Error('pty enter failed');
      }
      return { id: agentId, data };
    });
    getOutputCb()(encode('❯ '));
    await vi.advanceTimersByTimeAsync(3_000);
    mockWriteToAgent.mockClear();
    mockNotifyRenderer.mockClear();

    getOutputCb()(encode('do work ❯ '));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(mockWriteToAgent).toHaveBeenCalledWith(task.agentId, '\r');
    expect(task.status).toBe('running');
    expect(task.unsubmittedPrompt).toBe(false);
  });

  it('does not mark a cancelled prompt as stranded', async () => {
    vi.useFakeTimers();
    const task = await coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' });
    getOutputCb()(encode('❯ '));
    await vi.advanceTimersByTimeAsync(2_000);
    const sending = coordinator.sendPrompt(task.id, 'go').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    coordinator.setOrchestrationEnabled(false);
    await vi.advanceTimersByTimeAsync(3_000);
    await sending;
    expect(task.unsubmittedPrompt).toBeFalsy();
  });
});

describe('prompts queued behind a direct send', () => {
  it('delivers a prompt queued while the first was being written', async () => {
    vi.useFakeTimers();
    const task = await coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' });
    task.assignedPromptDelivered = false;
    getOutputCb()(encode('❯ '));
    await vi.advanceTimersByTimeAsync(2_000);
    const first = coordinator.sendPrompt(task.id, 'A');
    await vi.advanceTimersByTimeAsync(1);
    await coordinator.sendPrompt(task.id, 'B');
    await vi.advanceTimersByTimeAsync(3_000);
    await first;

    getOutputCb()(encode('Done ❯ '));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getAgentTextWrites()).toEqual(['A', 'B']);
  });
});

describe('reattach scrollback and hook-live agents', () => {
  it('does not mark a hook-live mid-turn agent idle from replayed scrollback', async () => {
    const task = await coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' });
    getHookEventHandler()(hook(task.agentId, { event: 'UserPromptSubmit' }));
    expect(task.status).toBe('running');

    mockGetAgentScrollback.mockReturnValue(Buffer.from('old frame ❯ ').toString('base64'));
    getSpawnHandler()(task.agentId, { reattached: true });

    expect(task.status).toBe('running');
    expect(coordinator.getTaskStatus(task.id)?.status).toBe('running');
  });
});

describe('initial prompt readiness is re-checked at delivery', () => {
  it('does not type into a trust dialog that appeared after the first prompt', async () => {
    vi.useFakeTimers();
    await coordinator.createTask({ name: 't', prompt: 'do work', coordinatorTaskId: 'coord-1' });
    getOutputCb()(encode('❯ '));
    getOutputCb()(encode('\nDo you trust the files in this folder?\n'));
    await vi.advanceTimersByTimeAsync(1_600);
    expect(getAgentTextWrites()).toHaveLength(0);
  });
});

describe('wait_for_signal_done requestId retry', () => {
  it('hands the next signal to the retried request, not the orphaned one', async () => {
    await coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' });
    const first = track(coordinator.waitForSignalDone('coord-1', 60_000, 'req-1'));
    const retry = coordinator.waitForSignalDone('coord-1', 60_000, 'req-1');

    await first.promise;
    await coordinator.signalDone('task-1');

    await expect(retry).resolves.toMatchObject({ taskId: 'task-1' });
  });

  it('keeps the wait slot across the supersede so no batch is staged', async () => {
    await coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' });
    const exited = await coordinator.createTask({ name: 'exited', coordinatorTaskId: 'coord-1' });
    // A pending notification the retry must not flash as staged.
    getExitHandler()(exited.agentId, { exitCode: 0 });
    void coordinator.waitForSignalDone('coord-1', 60_000, 'req-1');
    mockNotifyRenderer.mockClear();

    void coordinator.waitForSignalDone('coord-1', 60_000, 'req-1');

    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );
  });

  it('releases the orphan when the retry is answered by a waiting signal', async () => {
    const one = await coordinator.createTask({ name: 'a', coordinatorTaskId: 'coord-1' });
    const two = await coordinator.createTask({ name: 'b', coordinatorTaskId: 'coord-1' });
    const exited = await coordinator.createTask({ name: 'c', coordinatorTaskId: 'coord-1' });
    getExitHandler()(exited.agentId, { exitCode: 0 });
    const orphan = track(coordinator.waitForSignalDone('coord-1', 60_000, 'req-1'));
    one.signalDoneAt = new Date();
    mockNotifyRenderer.mockClear();

    await expect(coordinator.waitForSignalDone('coord-1', 60_000, 'req-1')).resolves.toMatchObject({
      taskId: one.id,
    });
    await orphan.promise;
    // The released slot lets the exit notification held back during the wait stage.
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.anything(),
    );

    await coordinator.signalDone(two.id);
    const next = await coordinator.waitForSignalDone('coord-1', 60_000, 'req-2');
    expect(next).toMatchObject({ taskId: two.id });
  });
});

describe('wait timeouts are clamped', () => {
  it.each([0, -5, Number.NaN])('waitForIdle(%s) does not fire immediately', async (ms) => {
    vi.useFakeTimers();
    await coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' });
    const wait = track(coordinator.waitForIdle('task-1', ms));
    await vi.advanceTimersByTimeAsync(5);
    expect(wait.settled()).toBe(false);
  });

  it('waitForIdle with a value above the setTimeout limit does not fire after 1ms', async () => {
    vi.useFakeTimers();
    await coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' });
    const wait = track(coordinator.waitForIdle('task-1', 2 ** 31));
    await vi.advanceTimersByTimeAsync(5);
    expect(wait.settled()).toBe(false);
  });

  it.each([0, -5, 2 ** 31])('waitForSignalDone(%s) does not fire early', async (ms) => {
    vi.useFakeTimers();
    await coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' });
    const wait = track(coordinator.waitForSignalDone('coord-1', ms));
    await vi.advanceTimersByTimeAsync(5);
    expect(wait.settled()).toBe(false);
  });
});

describe('task closed while still creating', () => {
  it('does not spawn into or announce a task closed during creation', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockSpawnAgent.mockImplementationOnce(() => gate);

    const creating = track(coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' }));
    for (let i = 0; i < 50 && mockSpawnAgent.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    await coordinator.closeTask('task-1');
    mockNotifyRenderer.mockClear();
    mockKillAgent.mockClear();
    release();

    await expect(creating.promise).rejects.toThrow(/closed/i);
    expect(mockKillAgent).toHaveBeenCalled();
    expect(mockNotifyRenderer).not.toHaveBeenCalledWith('mcp_task_created', expect.anything());
  });

  it('fails before creating a worktree when no notifier is set', async () => {
    const bare = new Coordinator();
    bare.setDefaultProject('proj-1', '/tmp/project');
    bare.registerCoordinator('coord-x', 'proj-1');
    await expect(bare.createTask({ name: 't', coordinatorTaskId: 'coord-x' })).rejects.toThrow(
      'No notifier set on coordinator',
    );
    expect(bare.getTask('task-1')).toBeUndefined();
  });
});

describe('waiters do not hang', () => {
  it('wakes signal waiters when the last pending child is removed', async () => {
    await coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' });
    const wait = coordinator.waitForSignalDone('coord-1', 60_000);
    coordinator.removeCoordinatedTask('task-1');
    await expect(wait).resolves.toMatchObject({ remaining: 0 });
  });

  it('treats an errored task as terminal for waitForIdle', async () => {
    const task = await coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' });
    task.status = 'error';
    await expect(coordinator.waitForIdle(task.id, 60_000)).resolves.toEqual({ reason: 'exited' });
  });

  it('resolves signal waiters when worktree deletion fails after the agent exited', async () => {
    const task = await coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' });
    const wait = coordinator.waitForSignalDone('coord-1', 60_000);
    mockDeleteBackendTask.mockImplementationOnce(async () => {
      // The PTY exit lands while cleanup is in progress, where the exit handler defers to it.
      getExitHandler()(task.agentId, { exitCode: 0 });
      throw new Error('delete failed');
    });
    await coordinator.closeTask(task.id);
    await expect(wait).resolves.toMatchObject({ taskId: task.id, status: 'exited' });
  });

  it('does not hand an exit reported before the close to a later waiter', async () => {
    vi.useFakeTimers();
    const task = await coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' });
    // Keeps a child pending so the waiter is not resolved with remaining: 0.
    await coordinator.createTask({ name: 'other', coordinatorTaskId: 'coord-1' });
    getExitHandler()(task.agentId, { exitCode: 0 });
    const wait = track(coordinator.waitForSignalDone('coord-1', 60_000));
    mockDeleteBackendTask.mockRejectedValueOnce(new Error('delete failed'));

    await coordinator.closeTask(task.id);
    await vi.advanceTimersByTimeAsync(10);

    expect(wait.settled()).toBe(false);
  });
});

describe('cleanup', () => {
  it('runs deleteTask once for concurrent cleanups of the same task', async () => {
    const task = await coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' });
    await Promise.all([coordinator.closeTask(task.id), coordinator.closeTask(task.id)]);
    expect(mockDeleteBackendTask).toHaveBeenCalledTimes(1);
  });

  it.each(['close', 'remove'] as const)('clears hook and interrupt state on %s', async (how) => {
    const task = await coordinator.createTask({ name: 't', coordinatorTaskId: 'coord-1' });
    getHookEventHandler()(hook(task.agentId));
    const internals = coordinator as unknown as {
      hookLiveAgentIds: Set<string>;
      interruptedAt: Map<string, number>;
    };
    internals.interruptedAt.set(task.agentId, Date.now());
    expect(internals.hookLiveAgentIds.has(task.agentId)).toBe(true);

    if (how === 'close') await coordinator.closeTask(task.id);
    else coordinator.removeCoordinatedTask(task.id);

    expect(internals.hookLiveAgentIds.has(task.agentId)).toBe(false);
    expect(internals.interruptedAt.has(task.agentId)).toBe(false);
  });
});
