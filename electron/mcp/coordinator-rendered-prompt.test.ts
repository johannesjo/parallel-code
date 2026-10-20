import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setupCoordinatorHarness,
  resetCoordinatorMocks,
  registerDefaultCoordinator,
  getOutputCb,
  getHookEventHandler,
  getSpawnHandler,
  getAgentTextWrites,
  encodeAgentOutput as encode,
  mockCreateBackendTask,
  mockGetAgentPromptSnapshot,
  mockGetAgentScrollback,
} from './coordinator-test-harness.js';

// Screens as the main-process mirror renders them, recorded from Codex 0.163.0.
const CODEX_READY = [
  '  >_ OpenAI Codex (v0.163.0)',
  '',
  '› Ask Codex to do anything',
  '',
  '  GPT-6.1-Sol default · ~/repo',
  '  ? for shortcuts',
].join('\n');
const CODEX_WORKING = [
  '› Reply with ALPHA',
  '',
  '• Working (1s • esc to interrupt)',
  '',
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol default · ~/repo',
].join('\n');
const CODEX_DONE = [
  '› Reply with ALPHA',
  '',
  '• ALPHA',
  '  Worked for 3s • 12:11',
  '',
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol default · ~/repo · Reply with ALPHA',
  '  ? for shortcuts',
].join('\n');
// Codex clears its input on submit, a moment before it shows it is working.
const CODEX_SUBMITTED = [
  '• ALPHA',
  '  Worked for 3s • 12:11',
  '',
  '› Now reply with BRAVO',
  '',
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol default · ~/repo',
  '  ? for shortcuts',
].join('\n');
// Codex hides its working line while it streams a reply.
const CODEX_STREAMING = [
  '› Reply with ALPHA',
  '',
  '• AL',
  '› Ask Codex to do anything',
  '  GPT-6.1-Sol default · ~/repo',
  '  ? for shortcuts',
].join('\n');
const CODEX_APPROVAL = [
  '  Would you like to run the following command?',
  '  $ npm test',
  '› 1. Yes, proceed (y)',
  '  2. No, and tell Codex what to do differently (esc)',
].join('\n');

let screen: { text: string; bracketedPaste: boolean; alternateScreen: boolean } | null = null;
let mirrorParsing = false;

function showScreen(text: string | null, alternateScreen = true): void {
  screen = text === null ? null : { text, bracketedPaste: true, alternateScreen };
  mirrorParsing = false;
}

/** Output has reached the mirror but is not parsed yet: only the screen so far is readable. */
function startParsing(): void {
  mirrorParsing = true;
}

const { Coordinator } = await setupCoordinatorHarness();
let coordinator: InstanceType<typeof Coordinator>;

beforeEach(() => {
  resetCoordinatorMocks();
  mockCreateBackendTask.mockResolvedValue({
    id: 'task-1',
    branch_name: 'task/t1',
    worktree_path: '/tmp/t1',
  });
  showScreen(null);
  mockGetAgentPromptSnapshot.mockImplementation(
    (_agentId: string, options?: { parsedSoFar?: boolean }) =>
      mirrorParsing && !options?.parsedSoFar ? null : screen,
  );
  coordinator = registerDefaultCoordinator(new Coordinator());
  coordinator.registerCoordinator('coord-1', 'proj-1');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Start a Codex child and let it take its assignment. */
async function createDeliveredCodexTask() {
  const task = await coordinator.createTask({
    name: 't',
    prompt: 'Reply with ALPHA',
    coordinatorTaskId: 'coord-1',
  });
  showScreen(CODEX_READY);
  // At startup Codex draws the whole prompt line, so even the stream shows it.
  getOutputCb()(encode('\x1b[37;1H›\x1b[37;3H\x1b[2mAsk Codex to do anything\x1b[0m'));
  await vi.advanceTimersByTimeAsync(3_000);
  expect(getAgentTextWrites().join('')).toContain('Reply with ALPHA');
  return task;
}

/** A turn Codex finishes by repainting only the changed cells: no prompt in the stream. */
async function finishCodexTurn(): Promise<void> {
  showScreen(CODEX_WORKING);
  getOutputCb()(encode('\x1b[35;3H•\x1b[35;5HWorking\x1b[35;13H(1s'));
  await vi.advanceTimersByTimeAsync(2_500);
  showScreen(CODEX_DONE);
  getOutputCb()(encode('\x1b[33;3H•\x1b[33;5HALPHA\x1b[34;3HWorked\x1b[34;10Hfor\x1b[34;14H3s'));
  // Output has settled: the turn is over.
  await vi.advanceTimersByTimeAsync(2_000);
}

describe('prompt readiness from the rendered screen', () => {
  it('resolves wait_for_idle when a Codex turn ends without redrawing its prompt', async () => {
    const task = await createDeliveredCodexTask();
    const wait = coordinator.waitForIdle(task.id, 60_000);

    await finishCodexTurn();

    await expect(wait).resolves.toEqual({ reason: 'idle' });
  });

  it('takes follow-ups after the first turn and resolves wait_for_idle for each', async () => {
    const task = await createDeliveredCodexTask();
    await finishCodexTurn();
    await expect(coordinator.waitForIdle(task.id, 60_000)).resolves.toEqual({ reason: 'idle' });

    const sent = coordinator.sendPrompt(task.id, 'Now reply with BRAVO');
    // Queued behind the write in flight, so it waits for the next fresh prompt.
    await expect(coordinator.sendPrompt(task.id, 'Then reply with CHARLIE')).resolves.toEqual({
      queued: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(sent).resolves.toEqual({ queued: false });
    const wait = coordinator.waitForIdle(task.id, 60_000);
    expect(getAgentTextWrites().join('')).not.toContain('CHARLIE');

    // Idle waits out the queue: the second turn's prompt sends CHARLIE.
    await finishCodexTurn();
    expect(getAgentTextWrites().join('')).toContain('Then reply with CHARLIE');
    await finishCodexTurn();

    await expect(wait).resolves.toEqual({ reason: 'idle' });
  });

  it('ignores the prompt left on screen until output arrives after a send', async () => {
    const task = await createDeliveredCodexTask();
    await finishCodexTurn();
    const sent = coordinator.sendPrompt(task.id, 'first');
    await coordinator.sendPrompt(task.id, 'second');
    await vi.advanceTimersByTimeAsync(1_000);
    await sent;
    let settled = false;
    void coordinator.waitForIdle(task.id, 60_000).then(() => (settled = true));

    // The screen still shows the ready prompt the agent just took.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(settled).toBe(false);
    expect(getAgentTextWrites().join('')).not.toContain('second');
  });

  it('does not report idle while a reply streams under the input prompt', async () => {
    const task = await createDeliveredCodexTask();
    let settled = false;
    const wait = coordinator.waitForIdle(task.id, 60_000);
    void wait.then(() => (settled = true));
    showScreen(CODEX_WORKING);
    getOutputCb()(encode('\x1b[35;5HWorking'));
    await vi.advanceTimersByTimeAsync(500);

    showScreen(CODEX_STREAMING);
    for (let i = 0; i < 10; i++) {
      getOutputCb()(encode('\x1b[33;6HL'));
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(settled).toBe(false);

    showScreen(CODEX_DONE);
    getOutputCb()(encode('\x1b[33;5HALPHA'));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(wait).resolves.toEqual({ reason: 'idle' });
  });

  it('does not count the input Codex empties on submit as idle before output settles', async () => {
    const task = await createDeliveredCodexTask();
    await finishCodexTurn();
    const sent = coordinator.sendPrompt(task.id, 'Now reply with BRAVO');
    await vi.advanceTimersByTimeAsync(1_000);
    await sent;
    let settled = false;
    const wait = coordinator.waitForIdle(task.id, 60_000);
    void wait.then(() => (settled = true));

    showScreen(CODEX_SUBMITTED);
    getOutputCb()(encode('\x1b[30;3HNow\x1b[30;7Hreply'));
    await vi.advanceTimersByTimeAsync(100);
    getOutputCb()(encode('\x1b[32;3H\x1b[2mAsk'));
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);

    await finishCodexTurn();
    await expect(wait).resolves.toEqual({ reason: 'idle' });
  });

  it('reports idle when an agent never shows it started the prompt', async () => {
    const task = await createDeliveredCodexTask();
    await finishCodexTurn();
    const sent = coordinator.sendPrompt(task.id, 'Now reply with BRAVO');
    await vi.advanceTimersByTimeAsync(1_000);
    await sent;
    const wait = coordinator.waitForIdle(task.id, 60_000);

    showScreen(CODEX_SUBMITTED);
    getOutputCb()(encode('\x1b[30;3HNow\x1b[30;7Hreply'));
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(wait).resolves.toEqual({ reason: 'idle' });
  });

  it('reports idle when the agent only redraws its prompt right after a send', async () => {
    const task = await createDeliveredCodexTask();
    await finishCodexTurn();
    let sent = false;
    void coordinator.sendPrompt(task.id, 'Now reply with BRAVO').then(() => (sent = true));
    while (!sent) await vi.advanceTimersByTimeAsync(10);
    // Within the echo window: the only output after the send, then silence.
    showScreen(CODEX_SUBMITTED);
    getOutputCb()(encode('\x1b[32;3H\x1b[2mAsk'));
    const wait = coordinator.waitForIdle(task.id, 60_000);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(wait).resolves.toEqual({ reason: 'idle' });
  });

  it('does not take the selection marker of a Codex dialog for a ready prompt', async () => {
    const task = await createDeliveredCodexTask();
    const wait = coordinator.waitForIdle(task.id, 60_000);
    let settled = false;
    void wait.then(() => (settled = true));
    showScreen(CODEX_WORKING);
    getOutputCb()(encode('\x1b[35;3H•\x1b[35;5HWorking'));
    await vi.advanceTimersByTimeAsync(2_500);

    showScreen(CODEX_APPROVAL);
    // Moving the selection repaints the › alone on its row.
    getOutputCb()(encode('\x1b[2K\r\n\x1b[38;1H›\r\n'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(settled).toBe(false);
  });

  it('checks the screen again once the mirror has parsed the latest output', async () => {
    const task = await createDeliveredCodexTask();
    const wait = coordinator.waitForIdle(task.id, 60_000);
    showScreen(CODEX_WORKING);
    getOutputCb()(encode('\x1b[35;5HWorking'));
    await vi.advanceTimersByTimeAsync(2_500);

    // The mirror is still parsing when the last chunk reaches the coordinator.
    startParsing();
    getOutputCb()(encode('\x1b[33;5HALPHA'));
    showScreen(CODEX_DONE);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(wait).resolves.toEqual({ reason: 'idle' });
  });

  it('checks the screen again when it is reattached while the mirror is parsing', async () => {
    const task = await createDeliveredCodexTask();
    const wait = coordinator.waitForIdle(task.id, 60_000);
    showScreen(CODEX_WORKING);
    getOutputCb()(encode('\x1b[35;5HWorking'));
    await vi.advanceTimersByTimeAsync(2_500);

    // The turn ended while the renderer was detached, so no output reached the coordinator.
    mockGetAgentScrollback.mockReturnValue(Buffer.from('\x1b[33;5HALPHA').toString('base64'));
    showScreen(CODEX_DONE);
    startParsing();
    getSpawnHandler()(task.agentId, { reattached: true });
    showScreen(CODEX_DONE);
    await vi.advanceTimersByTimeAsync(200);

    await expect(wait).resolves.toEqual({ reason: 'idle' });
  });

  it('returns the rendered screen as task output for a full-screen TUI', async () => {
    const task = await createDeliveredCodexTask();
    mockGetAgentScrollback.mockReturnValue(
      Buffer.from('\x1b[33;3H•\x1b[33;5HALPHA\x1b[34;3HWorked').toString('base64'),
    );
    showScreen(CODEX_DONE);
    expect(coordinator.getTaskOutput(task.id)).toBe(CODEX_DONE);

    showScreen('❯ ', false);
    expect(coordinator.getTaskOutput(task.id)).toBe('•ALPHAWorked');
  });

  it('returns the screen parsed so far while the mirror is still parsing output', async () => {
    const task = await createDeliveredCodexTask();
    mockGetAgentScrollback.mockReturnValue(Buffer.from('\x1b[33;5HALPHA').toString('base64'));
    // Readiness waits for the latest output; reading output need not.
    showScreen(CODEX_DONE);
    startParsing();

    expect(coordinator.getTaskOutput(task.id)).toBe(CODEX_DONE);
  });
});

describe('prompt readiness on a main-screen agent', () => {
  const CLAUDE_WORKING = '> do work\n✻ Thinking… (esc to interrupt)\n\n❯ ';
  const CLAUDE_READY = '> do work\n● Done.\n\n❯ ';
  const THINKING = '✻ Thinking… (esc to interrupt)';
  // A finished reply pushes the spinner line out of the tail's busy window.
  const DONE = `● ${'Done. '.repeat(200)}\r\n\r\n❯ `;

  async function createDeliveredClaudeTask() {
    const task = await coordinator.createTask({
      name: 't',
      prompt: 'do work',
      coordinatorTaskId: 'coord-1',
    });
    showScreen('❯ ', false);
    getOutputCb()(encode('❯ '));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getAgentTextWrites().join('')).toContain('do work');
    return task;
  }

  async function queueFollowUp(taskId: string): Promise<void> {
    const first = coordinator.sendPrompt(taskId, 'first step');
    await expect(coordinator.sendPrompt(taskId, 'next step')).resolves.toEqual({ queued: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
  }

  it('sends a queued follow-up on the prompt in its output, without waiting to settle', async () => {
    const task = await createDeliveredClaudeTask();
    showScreen(CLAUDE_WORKING, false);
    await queueFollowUp(task.id);
    getOutputCb()(encode(THINKING));
    await vi.advanceTimersByTimeAsync(2_500);

    showScreen(CLAUDE_READY, false);
    getOutputCb()(encode(DONE));
    await vi.advanceTimersByTimeAsync(200);

    expect(getAgentTextWrites().join('')).toContain('next step');
  });

  it('reads its output tail while the mirror is still parsing that output', async () => {
    const task = await createDeliveredClaudeTask();
    showScreen(CLAUDE_WORKING, false);
    await queueFollowUp(task.id);
    getOutputCb()(encode(THINKING));
    await vi.advanceTimersByTimeAsync(2_500);

    // The PTY feeds the mirror just before it hands the chunk on.
    showScreen(CLAUDE_READY, false);
    startParsing();
    getOutputCb()(encode(DONE));
    await vi.advanceTimersByTimeAsync(200);

    expect(getAgentTextWrites().join('')).toContain('next step');
  });

  it('does not read its screen: a prompt left there is not a fresh one', async () => {
    const task = await createDeliveredClaudeTask();
    showScreen(CLAUDE_READY, false);
    await queueFollowUp(task.id);
    getOutputCb()(encode(THINKING));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getAgentTextWrites().join('')).not.toContain('next step');
  });

  it('sends a hook-live agent its queued follow-up once the prompt is redrawn', async () => {
    const task = await createDeliveredClaudeTask();
    const hook = (state: 'working' | 'done', event: string) =>
      getHookEventHandler()({ agentId: task.agentId, taskId: '', state, event, at: Date.now() });
    hook('working', 'UserPromptSubmit');
    showScreen(CLAUDE_WORKING, false);
    await queueFollowUp(task.id);
    getOutputCb()(encode(THINKING));

    // Stop fires before the TUI repaints its input prompt.
    hook('done', 'Stop');
    await vi.advanceTimersByTimeAsync(500);
    expect(getAgentTextWrites().join('')).not.toContain('next step');

    showScreen(CLAUDE_READY, false);
    getOutputCb()(encode(DONE));
    await vi.advanceTimersByTimeAsync(200);
    expect(getAgentTextWrites().join('')).toContain('next step');
  });
});
