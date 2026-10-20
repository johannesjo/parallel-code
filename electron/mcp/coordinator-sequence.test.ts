import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  setupCoordinatorHarness,
  resetCoordinatorMocks,
  mockNextTask,
  registerDefaultCoordinator,
  getOutputCb,
  encodeAgentOutput as encode,
  mockGitMergeTask,
  mockNotifyRenderer,
} from './coordinator-test-harness.js';

const { Coordinator } = await setupCoordinatorHarness();

// ─── end-to-end tool sequence smoke ──────────────────────────────────────────

describe('Coordinator — end-to-end tool sequence smoke', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    resetCoordinatorMocks();
    mockNextTask();
    coordinator = registerDefaultCoordinator(new Coordinator());
  });

  it('Test 1: full lifecycle — create → wait_for_idle → signal_done → wait_for_signal_done → close', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({
      name: 'feat-x',
      prompt: 'build it',
      coordinatorTaskId: 'coord-1',
    });

    coordinator.markPromptDelivered('task-1');

    // Simulate idle output
    const outputCb = getOutputCb();
    outputCb(encode('startup echo ❯ '));
    outputCb(encode('real work output '.repeat(40)));
    outputCb(encode('Done ❯ '));

    // waitForIdle should resolve immediately since task is now idle
    const idleResult = await coordinator.waitForIdle('task-1');
    expect(idleResult).toEqual({ reason: 'idle' });

    await coordinator.signalDone('task-1');

    const signalResult = await coordinator.waitForSignalDone('coord-1', 1000);
    expect(signalResult).toMatchObject({ remaining: 0 });

    await coordinator.closeTask('task-1');

    expect(coordinator.getTask('task-1')).toBeUndefined();
  });

  it('Test 2: list_tasks equivalent — getTask returns correct schema', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({
      name: 'feat-x',
      prompt: 'build it',
      coordinatorTaskId: 'coord-1',
    });

    const task = coordinator.getTask('task-1');
    expect(task).toBeDefined();
    if (!task) throw new Error('task should be defined');

    // Verify all expected fields are present and defined
    expect(task.id).toBeDefined();
    expect(task.name).toBeDefined();
    expect(task.branchName).toBeDefined();
    expect(task.worktreePath).toBeDefined();
    expect(task.projectId).toBeDefined();
    expect(task.agentId).toBeDefined();
    expect(task.status).toBeDefined();
    expect(task.coordinatorTaskId).toBeDefined();
    // exitCode can be null (task is running), not undefined
    expect('exitCode' in task).toBe(true);
  });

  it('Test 3: get_task_status — status progression idle → running → idle', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      await coordinator.createTask({
        name: 'feat-x',
        prompt: 'build it',
        coordinatorTaskId: 'coord-1',
      });

      coordinator.markPromptDelivered('task-1');
      const outputCb = getOutputCb();

      // Simulate idle output
      outputCb(encode('startup echo ❯ '));
      outputCb(encode('real work output '.repeat(40)));
      outputCb(encode('Done ❯ '));
      expect(coordinator.getTask('task-1')?.status).toBe('idle');

      // sendPrompt sets status to running
      const sendPromise = coordinator.sendPrompt('task-1', 'next step');
      await vi.advanceTimersByTimeAsync(500);
      await sendPromise;
      expect(coordinator.getTask('task-1')?.status).toBe('running');

      // Simulate idle again after prompt-echo suppression expires
      await vi.advanceTimersByTimeAsync(2_100);
      outputCb(encode('Ready ❯ '));
      expect(coordinator.getTask('task-1')?.status).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Test 4: merge_task smoke — calls gitMergeTask', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({
      name: 'feat-x',
      prompt: 'build it',
      coordinatorTaskId: 'coord-1',
    });

    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    outputCb(encode('startup echo ❯ '));
    outputCb(encode('real work output '.repeat(40)));
    outputCb(encode('Done ❯ '));

    await coordinator.mergeTask('task-1');
    expect(mockGitMergeTask).toHaveBeenCalled();
  });

  it('Test 5: close_task cleans up all maps', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({
      name: 'feat-x',
      prompt: 'build it',
      coordinatorTaskId: 'coord-1',
    });

    await coordinator.closeTask('task-1');

    // Task should be removed
    expect(coordinator.getTask('task-1')).toBeUndefined();

    // Renderer was notified about task closure
    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_task_closed', { taskId: 'task-1' });
  });

  it('Test 6: send_prompt into unknown task rejects', async () => {
    await expect(coordinator.sendPrompt('nonexistent', 'hello')).rejects.toThrow('not found');
  });

  it('Test 7: wait_for_signal_done unknown coordinatorId rejects', async () => {
    await expect(coordinator.waitForSignalDone('unknown-coord', 100)).rejects.toThrow(
      'Coordinator not found',
    );
  });
});
