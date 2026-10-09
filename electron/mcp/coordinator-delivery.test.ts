import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setupCoordinatorHarness,
  resetCoordinatorMocks,
  registerDefaultCoordinator,
  getOutputCb,
  getHookEventHandler,
  getAgentTextWrites,
  encodeAgentOutput as encode,
  mockCreateBackendTask,
} from './coordinator-test-harness.js';

const { Coordinator } = await setupCoordinatorHarness();
let coordinator: InstanceType<typeof Coordinator>;

beforeEach(() => {
  resetCoordinatorMocks();
  mockCreateBackendTask.mockResolvedValue({
    id: 'task-1',
    branch_name: 'task/t1',
    worktree_path: '/tmp/t1',
  });
  coordinator = registerDefaultCoordinator(new Coordinator());
  coordinator.registerCoordinator('coord-1', 'proj-1');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function createDeliveredTask() {
  const task = await coordinator.createTask({
    name: 't',
    prompt: 'do work',
    coordinatorTaskId: 'coord-1',
  });
  getOutputCb()(encode('❯ '));
  await vi.advanceTimersByTimeAsync(3_000);
  expect(getAgentTextWrites().join('')).toContain('do work');
  return task;
}

describe('prompt delivery status', () => {
  it('reports an assignment the agent never became ready for as a stalled child', async () => {
    const task = await coordinator.createTask({
      name: 't',
      prompt: 'do work',
      coordinatorTaskId: 'coord-1',
    });
    getOutputCb()(encode('Starting MCP servers (1/2)'));
    const wait = coordinator.waitForSignalDone('coord-1', 61_000);
    await vi.advanceTimersByTimeAsync(61_000);

    expect(coordinator.getTaskStatus(task.id)?.delivery).toMatchObject({
      state: 'queued',
      blockedBy: 'agent_startup',
    });
    await expect(wait).resolves.toMatchObject({
      timedOut: true,
      stalled: [
        {
          taskId: task.id,
          name: 't',
          delivery: { state: 'queued', blockedBy: 'agent_startup' },
        },
      ],
    });
  });

  it('reports a follow-up held by user activity', async () => {
    const task = await createDeliveredTask();
    coordinator.setTaskControl(task.id, 'human');
    await expect(coordinator.sendPrompt(task.id, 'next')).resolves.toEqual({ queued: true });

    expect(coordinator.listTasks()[0]?.delivery).toMatchObject({
      state: 'queued',
      blockedBy: 'user_activity',
    });
  });

  it('reports a submitted assignment as unconfirmed when the agent shows an empty prompt again', async () => {
    const task = await createDeliveredTask();
    getOutputCb()(encode('❯ Try "fix typecheck errors"'));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(coordinator.getTaskStatus(task.id)?.delivery).toMatchObject({ state: 'unconfirmed' });
  });

  it('confirms delivery once the agent shows a busy marker', async () => {
    const task = await createDeliveredTask();
    getOutputCb()(encode('Thinking… (esc to interrupt)'));
    getOutputCb()(encode('Done\n❯ '));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(coordinator.getTaskStatus(task.id)?.delivery).toBeUndefined();
  });

  it('confirms delivery once a prompt-submit hook arrives', async () => {
    const task = await createDeliveredTask();
    getHookEventHandler()({
      agentId: task.agentId,
      taskId: '',
      state: 'working',
      event: 'UserPromptSubmit',
      at: Date.now(),
    });
    getOutputCb()(encode('❯ '));
    await vi.advanceTimersByTimeAsync(20_000);

    expect(coordinator.getTaskStatus(task.id)?.delivery).toBeUndefined();
  });

  it('does not report a working agent with a queued follow-up as stalled', async () => {
    const task = await createDeliveredTask();
    getOutputCb()(encode('Thinking… (esc to interrupt)'));
    // The second prompt queues behind the first one's write.
    void coordinator.sendPrompt(task.id, 'first');
    await coordinator.sendPrompt(task.id, 'next');
    getOutputCb()(encode('Thinking… (esc to interrupt)'));
    const wait = coordinator.waitForSignalDone('coord-1', 61_000);
    await vi.advanceTimersByTimeAsync(61_000);

    expect(coordinator.getTaskStatus(task.id)?.delivery).toMatchObject({
      state: 'queued',
      blockedBy: 'agent_busy',
    });
    const result = await wait;
    expect(result.stalled).toBeUndefined();
  });

  it('times a follow-up from when it was queued, not from a discarded earlier queue', async () => {
    const task = await createDeliveredTask();
    coordinator.setTaskControl(task.id, 'human');
    await coordinator.sendPrompt(task.id, 'old');
    coordinator.setOrchestrationEnabled(false);
    coordinator.setOrchestrationEnabled(true);
    await vi.advanceTimersByTimeAsync(90_000);
    await coordinator.sendPrompt(task.id, 'new');

    expect(coordinator.getTaskStatus(task.id)?.delivery).toMatchObject({
      state: 'queued',
      sinceMs: 0,
    });
  });

  it('does not report a child that signalled done as stalled', async () => {
    const task = await createDeliveredTask();
    await coordinator.signalDone(task.id, {});
    getOutputCb()(encode('❯ '));
    await coordinator.waitForSignalDone('coord-1', 1_000);
    const wait = coordinator.waitForSignalDone('coord-1', 61_000);
    await vi.advanceTimersByTimeAsync(61_000);

    const result = await wait;
    expect(result.timedOut).toBe(true);
    expect(result.stalled).toBeUndefined();
  });
});
