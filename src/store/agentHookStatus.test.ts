import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockStoreHarness } from './test-helpers';
import type {
  AgentActivityObservation,
  AgentHookEventPayload,
} from '../../electron/agent-hooks/status';
import { mapClaudeHookPayload } from '../../electron/agent-hooks/status';
import { IPC } from '../../electron/ipc/channels';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
const { invoke } = await import('../lib/ipc');

let mockActiveTaskId: string | null = null;
let mockTasks: Record<string, unknown> = {};
let mockAgents: Record<string, unknown> = {};
const core = vi.hoisted(() => ({
  harness: undefined as
    | MockStoreHarness<{
        activeTaskId: string | null;
        tasks: Record<string, unknown>;
        agents: Record<string, unknown>;
      }>
    | undefined,
}));
vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness({
    get activeTaskId() {
      return mockActiveTaskId;
    },
    set activeTaskId(next) {
      mockActiveTaskId = next;
    },
    get tasks() {
      return mockTasks;
    },
    set tasks(next) {
      mockTasks = next;
    },
    get agents() {
      return mockAgents;
    },
    set agents(next) {
      mockAgents = next;
    },
  });
  return core.harness.moduleMock();
});

vi.mock('solid-js', () => {
  function createSignal<T>(initial: T): [() => T, (v: T | ((prev: T) => T)) => void] {
    let value = initial;
    return [
      () => value,
      (v) => {
        value = typeof v === 'function' ? (v as (prev: T) => T)(value) : v;
      },
    ];
  }
  return {
    createSignal,
    createEffect: vi.fn(),
    createRoot: (fn: (dispose: () => void) => unknown) => fn(vi.fn()),
    untrack: (fn: () => unknown) => fn(),
  };
});

const {
  AGENT_HOOK_STALE_MS,
  applyAgentHookEvent,
  applyAgentActivityObservation,
  applyAgentActivitySnapshot,
  clearAgentHookStatus,
  getAgentHookStatus,
  getTaskAgentHookStatus,
  isTaskUnread,
  markTaskRead,
  noteAgentPromptSent,
  noteAgentTerminalInput,
  startAgentHookStatusListener,
} = await import('./agentHookStatus');

let sequence = 100;
function observation(
  overrides: Partial<AgentHookEventPayload> = {},
): Extract<AgentActivityObservation, { kind: 'hook' }> {
  return {
    ...event(overrides),
    kind: 'hook',
    launchId: 'launch-1',
    sequence: ++sequence,
    since: Date.now(),
  };
}

function event(overrides: Partial<AgentHookEventPayload>): AgentHookEventPayload {
  return {
    agentId: 'a1',
    taskId: 't1',
    state: 'working',
    event: 'UserPromptSubmit',
    at: Date.now(),
    ...overrides,
  };
}

/** Applies a raw Claude Code hook payload for agent `a1`, mapped as the main process maps it. */
function hook(payload: Record<string, unknown>): void {
  const update = mapClaudeHookPayload(payload);
  if (!update) throw new Error(`${String(payload.hook_event_name)} maps to no status`);
  applyAgentHookEvent(event(update));
}

describe('agentHookStatus', () => {
  /** No dialog on screen: a mouse click can't hit an option. */
  const noScreen = () => '';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    mockActiveTaskId = 't1';
    mockTasks = { t1: { agentIds: ['a1', 'a2'] } };
    mockAgents = {};
  });

  afterEach(() => {
    for (const id of ['a1', 'a2']) clearAgentHookStatus(id);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('records the state and keeps `since` across same-state events', () => {
    applyAgentHookEvent(event({ at: 1_000_000 }));
    applyAgentHookEvent(
      event({ at: 1_005_000, event: 'PreToolUse', toolName: 'Bash', detail: 'ls' }),
    );
    expect(getAgentHookStatus('a1')).toMatchObject({
      state: 'working',
      since: 1_000_000,
      updatedAt: 1_005_000,
      toolName: 'Bash',
      detail: 'ls',
    });
    applyAgentHookEvent(event({ at: 1_009_000, state: 'waiting', event: 'PermissionRequest' }));
    expect(getAgentHookStatus('a1')?.since).toBe(1_009_000);
  });

  it('keeps the final message when an idle-prompt notification follows Stop', () => {
    applyAgentHookEvent(event({ state: 'done', event: 'Stop', lastAssistantMessage: 'Shipped' }));
    applyAgentHookEvent(event({ state: 'done', event: 'Notification', at: Date.now() + 60_000 }));
    expect(getAgentHookStatus('a1')?.lastAssistantMessage).toBe('Shipped');
    applyAgentHookEvent(event({ state: 'working', at: Date.now() + 70_000 }));
    expect(getAgentHookStatus('a1')?.lastAssistantMessage).toBeUndefined();
  });

  it('keeps naming a background command when an idle-prompt notification follows Stop', () => {
    const detail = 'background: Dev server';
    applyAgentHookEvent(event({ state: 'done', event: 'Stop', detail }));
    applyAgentHookEvent(event({ state: 'done', event: 'Notification', at: Date.now() + 60_000 }));
    expect(getAgentHookStatus('a1')?.detail).toBe(detail);
    applyAgentHookEvent(event({ state: 'working', at: Date.now() + 70_000 }));
    expect(getAgentHookStatus('a1')?.detail).toBeUndefined();
  });

  it('marks a finished turn unread only when its task is not on screen', () => {
    applyAgentHookEvent(event({ state: 'done', event: 'Stop' }));
    expect(isTaskUnread('t1')).toBe(false);

    mockActiveTaskId = 'other';
    applyAgentHookEvent(event({ state: 'done', event: 'Stop', at: Date.now() + 1 }));
    expect(isTaskUnread('t1')).toBe(true);

    // The idle-prompt notification a minute later is not the user looking.
    applyAgentHookEvent(event({ state: 'done', event: 'Notification', at: Date.now() + 60_000 }));
    expect(isTaskUnread('t1')).toBe(true);

    markTaskRead('t1');
    expect(isTaskUnread('t1')).toBe(false);

    applyAgentHookEvent(event({ state: 'done', event: 'Stop', at: Date.now() + 70_000 }));
    applyAgentHookEvent(event({ state: 'working', at: Date.now() + 80_000 }));
    expect(isTaskUnread('t1')).toBe(false);
  });

  it('treats Enter or a digit on a permission dialog as approval until hooks say otherwise', () => {
    applyAgentHookEvent(
      event({
        state: 'waiting',
        event: 'PermissionRequest',
        toolName: 'Bash',
        prompt: 'permission',
      }),
    );
    noteAgentTerminalInput('a1', '\x1b[A', noScreen);
    expect(getAgentHookStatus('a1')?.state).toBe('waiting');
    noteAgentTerminalInput('a1', '\r', noScreen);
    expect(getAgentHookStatus('a1')).toMatchObject({
      state: 'working',
      event: 'PermissionAnswered',
      source: 'terminal',
      toolName: 'Bash',
    });

    applyAgentHookEvent(
      event({ state: 'waiting', event: 'PermissionRequest', prompt: 'permission' }),
    );
    noteAgentTerminalInput('a1', '2', noScreen);
    expect(getAgentHookStatus('a1')?.state).toBe('working');
  });

  it('treats the letters a Codex approval dialog offers as an answer, for a Codex agent only', () => {
    const ask = (toolName: string) =>
      applyAgentHookEvent(
        event({ state: 'waiting', event: 'PermissionRequest', prompt: 'permission', toolName }),
      );
    const stateAfter = (toolName: string, key: string) => {
      ask(toolName);
      noteAgentTerminalInput('a1', key, noScreen);
      return getAgentHookStatus('a1')?.state;
    };
    // Claude's dialog has no letter shortcuts, so a typed letter answers nothing.
    expect(stateAfter('Bash', 'y')).toBe('waiting');

    mockAgents = { a1: { def: { command: '/usr/local/bin/codex' } } };
    // As Codex CLI 0.167.0 lists them: (y) and (p) for a command, (y) and (a) for a file edit.
    expect(stateAfter('Bash', 'y')).toBe('working');
    expect(stateAfter('Bash', 'p')).toBe('working');
    expect(stateAfter('apply_patch', 'y')).toBe('working');
    expect(stateAfter('apply_patch', 'a')).toBe('working');
    expect(getAgentHookStatus('a1')?.event).toBe('PermissionAnswered');
    // Codex ignores a letter its dialog does not offer, and the dialog stays up.
    expect(stateAfter('Bash', 'a')).toBe('waiting');
    expect(stateAfter('apply_patch', 'p')).toBe('waiting');
    // A decline is not inferred: Codex reports it as an interrupt.
    expect(stateAfter('Bash', 'n')).toBe('waiting');
  });

  it('leaves Esc during a Codex turn to the interrupt Codex reports itself', () => {
    mockAgents = { a1: { def: { command: 'codex' } } };
    applyAgentHookEvent(event({ state: 'working' }));
    noteAgentTerminalInput('a1', '\x1b', noScreen);
    vi.advanceTimersByTime(5_000);
    expect(getAgentHookStatus('a1')?.state).toBe('working');
  });

  it('treats a click on the selected permission option as approval, but not a click elsewhere', () => {
    // Rows as Claude Code 2.1.318 draws its dialog; mouse reports are SGR (1006).
    const screen: Record<number, string> = {
      16: ' Do you want to create notes.txt?',
      17: ' ❯ 1. Yes',
      18: '   2. Yes, and switch to accept edits (auto-approve file edits) (shift+tab)',
      19: '   3. No',
    };
    const lineAt = (row: number) => screen[row] ?? '';
    applyAgentHookEvent(
      event({ state: 'waiting', event: 'PermissionRequest', prompt: 'permission' }),
    );
    // Focusing the terminal or pressing on an option is no answer yet. A click on
    // another option is unverified against real Claude, so it doesn't count either.
    noteAgentTerminalInput('a1', '\x1b[<0;10;16m', lineAt);
    noteAgentTerminalInput('a1', '\x1b[<0;6;17M', lineAt);
    noteAgentTerminalInput('a1', '\x1b[<0;6;18m', lineAt);
    expect(getAgentHookStatus('a1')?.state).toBe('waiting');

    noteAgentTerminalInput('a1', '\x1b[<0;6;17m', lineAt);
    expect(getAgentHookStatus('a1')).toMatchObject({
      state: 'working',
      event: 'PermissionAnswered',
    });
  });

  it('ignores a click on a numbered line outside the dialog', () => {
    // Claude's own numbered plan sits above the dialog; it has no selection cursor.
    const screen: Record<number, string> = {
      4: '  1. Add the parser',
      5: '  2. Wire it into the CLI',
      16: ' Do you want to create notes.txt?',
      17: ' ❯ 1. Yes',
      18: '   2. No',
    };
    const lineAt = (row: number) => screen[row] ?? '';
    applyAgentHookEvent(
      event({ state: 'waiting', event: 'PermissionRequest', prompt: 'permission' }),
    );
    noteAgentTerminalInput('a1', '\x1b[<0;6;5m', lineAt);
    expect(getAgentHookStatus('a1')?.state).toBe('waiting');
  });

  it('keeps the permission prompt kind across a follow-up notification', () => {
    applyAgentHookEvent(
      event({ state: 'waiting', event: 'PermissionRequest', prompt: 'permission' }),
    );
    applyAgentHookEvent(event({ state: 'waiting', event: 'Notification', at: Date.now() + 5 }));
    expect(getAgentHookStatus('a1')?.prompt).toBe('permission');
  });

  it('does not guess at answers to a structured question', () => {
    applyAgentHookEvent(
      event({
        state: 'waiting',
        event: 'PreToolUse',
        toolName: 'AskUserQuestion',
        prompt: 'question',
      }),
    );
    noteAgentTerminalInput('a1', '\r', noScreen);
    expect(getAgentHookStatus('a1')?.state).toBe('waiting');
  });

  it("does not read Enter or a digit as an answer to a question's permission request", () => {
    const ask = {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which DB?' }, { question: 'Which port?' }] },
    };
    hook({ hook_event_name: 'PreToolUse', tool_use_id: 'q1', ...ask });
    // Claude Code's PermissionRequest carries no tool_use_id.
    hook({ hook_event_name: 'PermissionRequest', ...ask });
    const asking = { state: 'waiting', prompt: 'question', detail: 'Which DB?', toolUseId: 'q1' };
    expect(getAgentHookStatus('a1')).toMatchObject(asking);
    // Answering the first of two questions.
    noteAgentTerminalInput('a1', '1', noScreen);
    noteAgentTerminalInput('a1', '\r', noScreen);
    expect(getAgentHookStatus('a1')).toMatchObject(asking);
  });

  it("keeps a question a question through Claude's later permission notification", () => {
    const ask = {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which DB?' }, { question: 'Which port?' }] },
    };
    hook({ hook_event_name: 'PreToolUse', tool_use_id: 'q1', ...ask });
    hook({ hook_event_name: 'PermissionRequest', ...ask });
    hook({
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use AskUserQuestion',
    });
    const asking = { state: 'waiting', prompt: 'question', detail: 'Which DB?', toolUseId: 'q1' };
    expect(getAgentHookStatus('a1')).toMatchObject(asking);
    noteAgentTerminalInput('a1', '1', noScreen);
    expect(getAgentHookStatus('a1')).toMatchObject(asking);
  });

  it('keeps a dialog open when a sibling tool call finishes first', () => {
    applyAgentHookEvent(
      event({
        state: 'waiting',
        event: 'PreToolUse',
        prompt: 'question',
        toolUseId: 'ask-1',
        at: 10,
      }),
    );
    applyAgentHookEvent(
      event({ state: 'working', event: 'PostToolUse', toolUseId: 'read-2', at: 11 }),
    );
    expect(getAgentHookStatus('a1')).toMatchObject({
      state: 'waiting',
      prompt: 'question',
      toolUseId: 'ask-1',
      since: 10,
    });

    // A follow-up notification carries no id; the wait keeps the one it had.
    applyAgentHookEvent(event({ state: 'waiting', event: 'Notification', at: 12 }));
    expect(getAgentHookStatus('a1')?.toolUseId).toBe('ask-1');

    applyAgentHookEvent(
      event({ state: 'working', event: 'PostToolUse', toolUseId: 'ask-1', at: 13 }),
    );
    expect(getAgentHookStatus('a1')?.state).toBe('working');
  });

  it('lets any tool result end a wait whose call id is unknown', () => {
    applyAgentHookEvent(event({ state: 'waiting', event: 'PermissionRequest', at: 10 }));
    applyAgentHookEvent(
      event({ state: 'working', event: 'PostToolUse', toolUseId: 'read-2', at: 11 }),
    );
    expect(getAgentHookStatus('a1')?.state).toBe('working');
  });

  it('drops a stale working claim but keeps done forever', () => {
    applyAgentHookEvent(event({ agentId: 'a1', state: 'working' }));
    applyAgentHookEvent(event({ agentId: 'a2', state: 'done', event: 'Stop' }));
    vi.advanceTimersByTime(AGENT_HOOK_STALE_MS - 1);
    expect(getAgentHookStatus('a1')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(getAgentHookStatus('a1')).toBeNull();
    expect(getAgentHookStatus('a2')?.state).toBe('done');
  });

  it('keeps an unanswered prompt however long it waits', () => {
    applyAgentHookEvent(event({ agentId: 'a1', state: 'working' }));
    applyAgentHookEvent(
      event({
        agentId: 'a1',
        state: 'waiting',
        event: 'PermissionRequest',
        prompt: 'permission',
        at: Date.now() + 1_000,
      }),
    );
    vi.advanceTimersByTime(AGENT_HOOK_STALE_MS * 4);
    expect(getAgentHookStatus('a1')).toMatchObject({ state: 'waiting', prompt: 'permission' });
    expect(getTaskAgentHookStatus('t1')?.state).toBe('waiting');
  });

  it('keeps a restored wait whose observation is older than the stale window', () => {
    const old = observation({
      state: 'waiting',
      event: 'PermissionRequest',
      prompt: 'permission',
      at: Date.now() - AGENT_HOOK_STALE_MS * 2,
    });
    applyAgentActivitySnapshot({ sequence: old.sequence, observations: [old] });
    expect(getAgentHookStatus('a1')?.state).toBe('waiting');
  });

  it('infers an interrupt from a bare Esc that no hook event follows', () => {
    applyAgentHookEvent(event({ state: 'working' }));
    noteAgentTerminalInput('a1', '\x1b', noScreen);
    vi.advanceTimersByTime(499);
    expect(getAgentHookStatus('a1')?.state).toBe('working');
    vi.advanceTimersByTime(1);
    expect(getAgentHookStatus('a1')).toMatchObject({
      state: 'done',
      event: 'Interrupt',
      source: 'terminal',
    });

    // The interrupted tool's PostToolUse still lands; it must not revive the turn.
    applyAgentHookEvent(event({ event: 'PostToolUse', at: Date.now() + 100 }));
    expect(getAgentHookStatus('a1')?.state).toBe('done');
    // A new prompt from the user is always real.
    applyAgentHookEvent(event({ event: 'UserPromptSubmit', at: Date.now() + 200 }));
    expect(getAgentHookStatus('a1')?.state).toBe('working');
  });

  it('ends the turn when Esc interrupts a running shell command', () => {
    const bash = { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'npm test' } };
    hook({ hook_event_name: 'PreToolUse', ...bash });
    noteAgentTerminalInput('a1', '\x1b', noScreen);
    // Claude kills the command at once and reports it before the settle window ends.
    vi.advanceTimersByTime(100);
    hook({
      hook_event_name: 'PostToolUseFailure',
      ...bash,
      error: 'Interrupted',
      is_interrupt: true,
    });
    expect(getAgentHookStatus('a1')).toMatchObject({ state: 'done', event: 'Interrupt' });

    // A parallel sibling's result from the dead turn must not revive it.
    vi.advanceTimersByTime(100);
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'toolu_2' });
    vi.advanceTimersByTime(10_000);
    expect(getAgentHookStatus('a1')).toMatchObject({ state: 'done', event: 'Interrupt' });
  });

  it('shows a new turn in full right after an interrupt', () => {
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1' });
    hook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', is_interrupt: true });
    vi.advanceTimersByTime(500);
    hook({ hook_event_name: 'UserPromptSubmit' });
    vi.advanceTimersByTime(500);
    hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'toolu_2' });
    expect(getAgentHookStatus('a1')).toMatchObject({ state: 'waiting', prompt: 'permission' });
  });

  it('shows a sent prompt as working before its UserPromptSubmit lands', () => {
    applyAgentHookEvent(event({ state: 'done', event: 'Stop', lastAssistantMessage: 'Shipped' }));
    noteAgentPromptSent('a1');
    expect(getAgentHookStatus('a1')).toMatchObject({
      state: 'working',
      event: 'PromptSent',
      source: 'terminal',
      since: Date.now(),
    });
    expect(getAgentHookStatus('a1')?.lastAssistantMessage).toBeUndefined();

    vi.advanceTimersByTime(300);
    applyAgentHookEvent(event({ event: 'UserPromptSubmit', at: Date.now() }));
    vi.advanceTimersByTime(10_000);
    expect(getAgentHookStatus('a1')).toMatchObject({ state: 'working', source: 'hook' });
  });

  it('restores the previous state when no hook confirms the sent prompt', () => {
    applyAgentHookEvent(event({ state: 'done', event: 'Stop', lastAssistantMessage: 'Shipped' }));
    noteAgentPromptSent('a1');
    vi.advanceTimersByTime(4_999);
    expect(getAgentHookStatus('a1')?.state).toBe('working');
    vi.advanceTimersByTime(1);
    expect(getAgentHookStatus('a1')).toMatchObject({
      state: 'done',
      event: 'Stop',
      lastAssistantMessage: 'Shipped',
      unread: false,
    });
  });

  it('leaves working, waiting and unknown agents alone when a prompt is sent', () => {
    noteAgentPromptSent('a1');
    expect(getAgentHookStatus('a1')).toBeNull();

    applyAgentHookEvent(event({ state: 'waiting', event: 'PermissionRequest' }));
    noteAgentPromptSent('a1');
    expect(getAgentHookStatus('a1')?.event).toBe('PermissionRequest');

    applyAgentHookEvent(event({ state: 'working', event: 'PreToolUse', at: Date.now() + 1 }));
    noteAgentPromptSent('a1');
    expect(getAgentHookStatus('a1')?.event).toBe('PreToolUse');
  });

  it('reads no interrupt into Esc at the prompt while a background sub-agent runs', () => {
    applyAgentHookEvent(event({ state: 'working', event: 'SubagentRunning', background: true }));
    noteAgentTerminalInput('a1', '\x1b', noScreen);
    noteAgentTerminalInput('a1', '\x03', noScreen);
    vi.advanceTimersByTime(1_000);
    expect(getAgentHookStatus('a1')).toMatchObject({ state: 'working', background: true });
  });

  it('cancels the interrupt when a hook event arrives inside the settle window', () => {
    applyAgentHookEvent(event({ state: 'working' }));
    noteAgentTerminalInput('a1', '\x03', noScreen);
    vi.advanceTimersByTime(200);
    applyAgentHookEvent(event({ event: 'PostToolUse', at: Date.now() }));
    vi.advanceTimersByTime(500);
    expect(getAgentHookStatus('a1')?.state).toBe('working');
  });

  it('ignores Esc sequences that are not the bare key and any key outside working', () => {
    applyAgentHookEvent(event({ state: 'working' }));
    noteAgentTerminalInput('a1', '\x1b[A', noScreen);
    vi.advanceTimersByTime(1000);
    expect(getAgentHookStatus('a1')?.state).toBe('working');

    applyAgentHookEvent(event({ state: 'waiting', event: 'PermissionRequest', at: Date.now() }));
    noteAgentTerminalInput('a1', '\x1b', noScreen);
    vi.advanceTimersByTime(1000);
    expect(getAgentHookStatus('a1')?.state).toBe('waiting');
  });

  it('surfaces the most attention-worthy agent for a task', () => {
    applyAgentHookEvent(event({ agentId: 'a1', state: 'working', at: 5 }));
    applyAgentHookEvent(event({ agentId: 'a2', state: 'done', event: 'Stop', at: 9 }));
    expect(getTaskAgentHookStatus('t1')?.agentId).toBe('a1');
    applyAgentHookEvent(
      event({ agentId: 'a2', state: 'waiting', event: 'PermissionRequest', at: 10 }),
    );
    expect(getTaskAgentHookStatus('t1')?.agentId).toBe('a2');
    expect(getTaskAgentHookStatus('missing')).toBeNull();
  });

  it('forgets an agent entirely when cleared', () => {
    applyAgentHookEvent(event({ state: 'working' }));
    noteAgentTerminalInput('a1', '\x1b', noScreen);
    clearAgentHookStatus('a1');
    vi.advanceTimersByTime(1000);
    expect(getAgentHookStatus('a1')).toBeNull();
  });

  it('merges older snapshots without overwriting a subscribed event', () => {
    const old = observation({ state: 'waiting', event: 'PermissionRequest' });
    const newer = observation({ event: 'UserPromptSubmit', at: Date.now() + 1 });
    applyAgentActivityObservation(newer);
    applyAgentActivitySnapshot({ sequence: newer.sequence, observations: [old] });
    expect(getAgentHookStatus('a1')?.state).toBe('working');
  });

  it("keeps the task's plan from a TodoWrite observation", () => {
    mockTasks = { t1: { id: 't1', agentIds: ['a1'] } };
    const todos = [{ step: 'Check the dev command', status: 'in_progress' as const }];
    applyAgentActivityObservation(
      observation({ event: 'PostToolUse', toolName: 'TodoWrite', todos, at: 7 }),
    );
    expect(mockTasks.t1).toMatchObject({ agentPlan: { steps: todos, updatedAt: 7 } });
  });

  it('does not revive a retired launch from an in-flight snapshot', () => {
    const old = observation({ state: 'done', event: 'Stop' });
    applyAgentActivityObservation(old);
    applyAgentActivityObservation({ ...old, kind: 'retired', sequence: ++sequence });
    applyAgentActivitySnapshot({ sequence: old.sequence, observations: [old] });
    expect(getAgentHookStatus('a1')).toBeNull();
  });

  it('clears missed retirements from an empty snapshot and rejects events below its watermark', () => {
    const old = observation({ state: 'done', event: 'Stop' });
    applyAgentActivityObservation(old);
    applyAgentActivitySnapshot({ sequence: ++sequence, observations: [] });
    expect(getAgentHookStatus('a1')).toBeNull();
    applyAgentActivityObservation({ ...old, sequence: sequence - 1 });
    expect(getAgentHookStatus('a1')).toBeNull();
  });

  it('clears replaced launches and accepts only newer observations', () => {
    const old = observation({ state: 'done', event: 'Stop' });
    applyAgentActivityObservation(old);
    applyAgentActivityObservation({
      ...old,
      kind: 'launch',
      launchId: 'launch-2',
      sequence: ++sequence,
    });
    expect(getAgentHookStatus('a1')).toBeNull();
    applyAgentActivityObservation(old);
    expect(getAgentHookStatus('a1')).toBeNull();
    const current = { ...observation(), launchId: 'launch-2' };
    applyAgentActivityObservation(current);
    expect(getAgentHookStatus('a1')?.launchId).toBe('launch-2');
  });

  it('expires snapshot evidence by observation time rather than load time', () => {
    const old = observation({ at: Date.now() - AGENT_HOOK_STALE_MS + 10 });
    applyAgentActivitySnapshot({ sequence: old.sequence, observations: [old] });
    expect(getAgentHookStatus('a1')).not.toBeNull();
    vi.advanceTimersByTime(10);
    expect(getAgentHookStatus('a1')).toBeNull();
  });

  it('retains local input inference when the cache has not advanced', () => {
    const current = observation({
      state: 'waiting',
      event: 'PermissionRequest',
      prompt: 'permission',
    });
    applyAgentActivityObservation(current);
    noteAgentTerminalInput('a1', '\r', noScreen);
    applyAgentActivitySnapshot({ sequence: current.sequence, observations: [current] });
    expect(getAgentHookStatus('a1')).toMatchObject({
      event: 'PermissionAnswered',
      source: 'terminal',
    });
  });

  it('does not attribute local interruption details to a later hook observation', () => {
    applyAgentActivityObservation(observation());
    noteAgentTerminalInput('a1', '\x1b', noScreen);
    vi.advanceTimersByTime(500);
    expect(getAgentHookStatus('a1')).toMatchObject({ source: 'terminal', detail: 'Interrupted' });
    vi.advanceTimersByTime(60_000);
    const idle = observation({ state: 'done', event: 'Notification' });
    applyAgentActivityObservation(idle);
    expect(getAgentHookStatus('a1')).toMatchObject({
      source: 'hook',
      event: 'Notification',
      since: idle.since,
      updatedAt: idle.at,
    });
    expect(getAgentHookStatus('a1')?.detail).toBeUndefined();
  });

  it('replaces an older tool wait with the already reduced main snapshot', () => {
    applyAgentActivityObservation(
      observation({
        state: 'waiting',
        event: 'PermissionRequest',
        prompt: 'permission',
        toolUseId: 'old-tool',
        detail: 'Old approval',
      }),
    );
    vi.advanceTimersByTime(20);
    const current = observation({ event: 'PostToolUse', toolUseId: 'new-tool' });
    applyAgentActivitySnapshot({ sequence: current.sequence, observations: [current] });
    expect(getAgentHookStatus('a1')).toMatchObject({
      state: 'working',
      toolUseId: 'new-tool',
      since: current.since,
      updatedAt: current.at,
    });
    expect(getAgentHookStatus('a1')?.detail).toBeUndefined();
    expect(getAgentHookStatus('a1')?.prompt).toBeUndefined();
  });

  it('retains unread state and main-provided final text through idle observations', () => {
    mockActiveTaskId = 'other';
    applyAgentActivityObservation(
      observation({ state: 'done', event: 'Stop', lastAssistantMessage: 'Finished' }),
    );
    applyAgentActivityObservation(
      observation({ state: 'done', event: 'Notification', lastAssistantMessage: 'Finished' }),
    );
    expect(getAgentHookStatus('a1')).toMatchObject({
      unread: true,
      lastAssistantMessage: 'Finished',
    });
    markTaskRead('t1');
    expect(getAgentHookStatus('a1')?.unread).toBe(false);
  });

  it('does not change inferred interrupt onset when a tool event is suppressed', () => {
    applyAgentActivityObservation(observation());
    noteAgentTerminalInput('a1', '\x1b', noScreen);
    vi.advanceTimersByTime(500);
    const inferredSince = getAgentHookStatus('a1')?.since;
    applyAgentActivityObservation({ ...observation({ event: 'PostToolUse' }), since: 1 });
    expect(getAgentHookStatus('a1')).toMatchObject({ event: 'Interrupt', since: inferredSince });
  });

  it('subscribes before requesting a snapshot and ignores a response after disposal', async () => {
    const calls: string[] = [];
    let deliver: ((value: unknown) => void) | undefined;
    let resolveSnapshot: ((value: unknown) => void) | undefined;
    vi.mocked(invoke).mockImplementation(() => {
      calls.push('snapshot');
      return new Promise((resolve) => {
        resolveSnapshot = resolve;
      });
    });
    vi.stubGlobal('window', {
      electron: {
        ipcRenderer: {
          on: (channel: string, handler: (value: unknown) => void) => {
            expect(channel).toBe(IPC.AgentHookEvent);
            calls.push('subscribe');
            deliver = handler;
            return vi.fn();
          },
        },
      },
    });
    const stop = startAgentHookStatusListener();
    expect(calls).toEqual(['subscribe', 'snapshot']);
    expect(invoke).toHaveBeenCalledWith(IPC.AgentHookSnapshot);
    const current = observation();
    deliver?.(current);
    expect(getAgentHookStatus('a1')).not.toBeNull();
    stop();
    clearAgentHookStatus('a1');
    resolveSnapshot?.({ sequence: current.sequence, observations: [current] });
    await Promise.resolve();
    expect(getAgentHookStatus('a1')).toBeNull();
  });
});
