import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setupCoordinatorHarness,
  resetCoordinatorMocks,
  registerDefaultCoordinator,
  emitWorkThenIdle,
  emitAgentOutput,
  getExitHandler,
  getHookEventHandler,
  getInterruptHandler,
  getSpawnHandler,
  mockCreateBackendTask,
  mockGetAgentMeta,
} from './coordinator-test-harness.js';

// A lost Stop hook must not leave a hook-live Claude task running forever: a
// ❯ prompt followed by 15 s of silence ends the turn instead.
const SILENCE_MS = 15_000;

const { Coordinator } = await setupCoordinatorHarness();
type TestCoordinator = InstanceType<typeof Coordinator>;
type HookEvent = Parameters<ReturnType<typeof getHookEventHandler>>[0];
type Task = Awaited<ReturnType<TestCoordinator['createTask']>>;

function hook(agentId: string, overrides: Partial<HookEvent> = {}): void {
  getHookEventHandler()({
    agentId,
    taskId: '',
    state: 'working',
    event: 'UserPromptSubmit',
    at: Date.now(),
    ...overrides,
  });
}

function agentCommand(command: string): void {
  mockGetAgentMeta.mockImplementation((agentId: string) => ({
    taskId: 'task-1',
    agentId,
    isShell: false,
    command,
  }));
}

function track<T>(promise: Promise<T>): { settled: () => boolean; promise: Promise<T> } {
  let done = false;
  void promise.then(() => (done = true));
  return { settled: () => done, promise };
}

/** A turn that started, drew output, and ended on ❯ without its Stop hook. */
async function stallTurn(task: Task): Promise<void> {
  hook(task.agentId);
  await vi.advanceTimersByTimeAsync(100);
  emitWorkThenIdle();
}

let coordinator: TestCoordinator;
let task: Task;

beforeEach(async () => {
  resetCoordinatorMocks();
  vi.useFakeTimers();
  mockCreateBackendTask.mockResolvedValue({
    id: 'task-1',
    branch_name: 'task/t1',
    worktree_path: '/tmp/t1',
  });
  agentCommand('claude');
  coordinator = registerDefaultCoordinator(new Coordinator());
  coordinator.registerCoordinator('coord-1', 'proj-1');
  task = await coordinator.createTask({ name: 'a', prompt: 'do a', coordinatorTaskId: 'coord-1' });
  // Hand the assignment over, so the turn's end is a result to review.
  emitAgentOutput('❯ ');
  await vi.advanceTimersByTimeAsync(2_000);
  expect(task.assignedPromptDelivered).toBe(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Coordinator silent-prompt fallback for a stalled hook turn', () => {
  it('treats a silent ❯ as the end of a turn whose Stop hook was lost', async () => {
    const waiter = track(coordinator.waitForIdle(task.id, 60_000));
    await stallTurn(task);

    await vi.advanceTimersByTimeAsync(SILENCE_MS - 100);
    expect(coordinator.getTaskStatus(task.id)?.status).toBe('running');
    expect(waiter.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    expect(coordinator.getTaskStatus(task.id)?.status).toBe('idle');
    await expect(waiter.promise).resolves.toEqual({ reason: 'idle' });
    expect(task.reviewNotificationQueued).toBe(true);
  });

  it('keeps a turn running while output continues under a visible ❯', async () => {
    await stallTurn(task);
    for (let i = 0; i < 20; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      emitAgentOutput('tick\n');
    }
    expect(task.status).toBe('running');
  });

  it('keeps a turn running while Claude waits for permission', async () => {
    await stallTurn(task);
    await vi.advanceTimersByTimeAsync(1_000);
    hook(task.agentId, { event: 'PermissionRequest', state: 'waiting', toolName: 'Bash' });

    await vi.advanceTimersByTimeAsync(2 * SILENCE_MS);
    expect(task.status).toBe('running');
  });

  it('keeps a turn running while background work holds the lead at its prompt', async () => {
    await stallTurn(task);
    await vi.advanceTimersByTimeAsync(1_000);
    hook(task.agentId, { event: 'SubagentRunning', background: true });

    await vi.advanceTimersByTimeAsync(2 * SILENCE_MS);
    expect(task.status).toBe('running');
  });

  it('keeps a turn running when no output followed its start', async () => {
    await stallTurn(task);
    // The next turn starts before the first one's silence elapsed, and draws nothing.
    await vi.advanceTimersByTimeAsync(1_000);
    hook(task.agentId);

    await vi.advanceTimersByTimeAsync(2 * SILENCE_MS);
    expect(task.status).toBe('running');
  });

  it('leaves agents other than Claude to their Stop hook', async () => {
    agentCommand('codex');
    await stallTurn(task);

    await vi.advanceTimersByTimeAsync(2 * SILENCE_MS);
    expect(task.status).toBe('running');
  });

  it('still goes idle at once on a real Stop, and output does not undo it', async () => {
    const waiter = track(coordinator.waitForIdle(task.id, 60_000));
    await stallTurn(task);

    hook(task.agentId, { event: 'Stop', state: 'done' });
    expect(task.status).toBe('idle');
    await expect(waiter.promise).resolves.toEqual({ reason: 'idle' });

    emitAgentOutput('Thinking (esc to interrupt)\n');
    expect(task.status).toBe('idle');
  });

  it('returns to running when busy output follows a silence-based idle', async () => {
    await stallTurn(task);
    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(task.status).toBe('idle');
    expect(task.reviewNotificationQueued).toBe(true);

    emitAgentOutput('Thinking (esc to interrupt)\n');
    expect(task.status).toBe('running');
    expect(task.reviewNotificationQueued).toBe(false);

    // The late Stop still ends the turn.
    hook(task.agentId, { event: 'Stop', state: 'done' });
    expect(task.status).toBe('idle');
  });

  it('still ends the turn on silence after the renderer reattaches', async () => {
    await stallTurn(task);
    getSpawnHandler()(task.agentId, { reattached: true });

    await vi.advanceTimersByTimeAsync(SILENCE_MS);
    expect(task.status).toBe('idle');
  });

  it.each([
    ['exit', () => getExitHandler()(task.agentId, { exitCode: 0 })],
    ['respawn', () => getSpawnHandler()(task.agentId)],
    ['interrupt', () => getInterruptHandler()(task.agentId)],
    ['removal', () => coordinator.removeCoordinatedTask(task.id)],
  ])('cancels the pending silence check on %s', async (_name, end) => {
    const checks = (
      coordinator.prompts as unknown as { deferredPromptChecks: Map<string, unknown> }
    ).deferredPromptChecks;
    await stallTurn(task);
    expect(checks.has(task.id)).toBe(true);

    end();
    expect(checks.has(task.id)).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * SILENCE_MS);
    expect(task.status).not.toBe('idle');
  });
});
