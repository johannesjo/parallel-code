import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefined, type MockStoreHarness } from './test-helpers';
import {
  createHookPayloadMapper,
  type HookPayloadMapper,
} from '../../electron/agent-hooks/hook-pipeline';
import { followTerminalDraft } from '../../electron/shared/terminal-input';
import {
  createProgramStatusReporter,
  parseProgramStatus,
  type ProgramStatusReport,
} from '../../electron/agent-hooks/program-status';
import {
  invalidateAgentActivity,
  observeAgentHook,
  onAgentActivityObservation,
  registerAgentLaunch,
  retireAgentLaunch,
} from '../../electron/agent-hooks/observations';
import {
  loadRecordedSessions,
  type RecordedSession,
  type SessionStep,
} from '../../electron/agent-hooks/recorded-sessions';

let mockTasks: Record<string, unknown> = {};
let mockAgents: Record<string, unknown> = {};
const core = vi.hoisted(() => ({
  harness: undefined as
    | MockStoreHarness<{
        activeTaskId: string | null;
        tasks: Record<string, unknown>;
        agents: Record<string, unknown>;
        terminals: Record<string, unknown>;
        taskGitStatus: Record<string, unknown>;
      }>
    | undefined,
}));
vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness({
    // Another task is open, as when the user waits on this one from elsewhere.
    activeTaskId: 'other-task',
    get tasks() {
      return mockTasks;
    },
    get agents() {
      return mockAgents;
    },
    terminals: {},
    taskGitStatus: {},
  });
  return core.harness.moduleMock();
});
vi.mock('../lib/ipc', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('solid-js', () => {
  function createSignal<T>(initial: T): [() => T, (v: T | ((prev: T) => T)) => void] {
    let value = initial;
    const setter = (v: T | ((prev: T) => T)) => {
      value = typeof v === 'function' ? (v as (prev: T) => T)(value) : v;
    };
    return [() => value, setter];
  }
  return {
    createSignal,
    createEffect: vi.fn(),
    createRoot: vi.fn(),
    onMount: vi.fn(),
    onCleanup: vi.fn(),
    untrack: (fn: () => unknown) => fn(),
    batch: (fn: () => unknown) => fn(),
  };
});

import { applyAgentActivityObservation, noteAgentTerminalInput } from './agentHookStatus';
import {
  clearAgentActivity,
  getTaskAttentionState,
  markAgentOutput,
  markAgentSpawned,
} from './taskStatus';

const TASK_ID = 'task-1';
const LAUNCH_ID = 'launch-1';

interface Replay {
  agentId: string;
  mapPayload: HookPayloadMapper;
  inputPending: boolean;
  /** Set for launches without hooks, which the main process reads OSC 7501 from (pty.ts). */
  reportProgramStatus?: (report: ProgramStatusReport) => void;
}

// shortcut: a report split across two output chunks is missed; feed the
// terminal-query responder instead if a recording ever splits one.
// eslint-disable-next-line no-control-regex -- OSC 7501, ended by BEL or ST
const PROGRAM_STATUS_REPORT = /\x1b\]7501;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

function programStatusReports(output: string): ProgramStatusReport[] {
  return [...output.matchAll(PROGRAM_STATUS_REPORT)].flatMap(([, payload]) => {
    const report = parseProgramStatus(payload ?? '');
    return report && report !== 'query' ? [report] : [];
  });
}

/** One step as production handles it; returns the attention state for `expect`. */
function play(run: Replay, session: RecordedSession, step: SessionStep): string | null {
  const { agentId } = run;
  if ('hook' in step) {
    const update =
      session.hooks === 'none' ? null : run.mapPayload(session.hooks, LAUNCH_ID, step.hook);
    if (update)
      observeAgentHook({
        ...update,
        agentId,
        taskId: TASK_ID,
        launchId: LAUNCH_ID,
        at: Date.now(),
      });
  } else if ('output' in step) {
    for (const report of run.reportProgramStatus ? programStatusReports(step.output) : [])
      run.reportProgramStatus?.(report);
    markAgentOutput(agentId, new TextEncoder().encode(step.output), TASK_ID);
  } else if ('input' in step) {
    // The main process's half of a keystroke (pty.ts writeSessionInput), then the renderer's.
    const draft = followTerminalDraft(run.inputPending, step.input);
    if (draft.submitted) invalidateAgentActivity(agentId, LAUNCH_ID);
    run.inputPending = draft.pending;
    noteAgentTerminalInput(agentId, step.input, () => '');
  } else if ('wait' in step) {
    vi.advanceTimersByTime(step.wait);
  } else {
    return getTaskAttentionState(TASK_ID);
  }
  return null;
}

/**
 * Plays a recorded session through the path production uses — the hook
 * server's payload mapping, the main process reducer, the renderer's hook
 * status and terminal heuristics — and returns `step: state` for every `expect`.
 */
function replay(session: RecordedSession, agentId: string): string[] {
  mockTasks = { [TASK_ID]: { id: TASK_ID, name: TASK_ID, agentIds: [agentId], shellAgentIds: [] } };
  mockAgents = { [agentId]: { id: agentId, status: 'running', def: { command: session.command } } };
  const run: Replay = {
    agentId,
    mapPayload: createHookPayloadMapper(),
    inputPending: false,
    reportProgramStatus:
      session.hooks === 'none'
        ? createProgramStatusReporter({ agentId, taskId: TASK_ID, launchId: LAUNCH_ID })
        : undefined,
  };
  // The renderer's side of a spawn, as the app runs it when the agent starts.
  markAgentSpawned(agentId);
  registerAgentLaunch(agentId, TASK_ID, LAUNCH_ID);
  try {
    return session.steps.flatMap((step, index) => {
      const state = play(run, session, step);
      return state === null ? [] : [`${index}: ${state}`];
    });
  } finally {
    retireAgentLaunch(agentId, LAUNCH_ID);
  }
}

function expected(session: RecordedSession): string[] {
  return session.steps.flatMap((step, index) =>
    'expect' in step ? [`${index}: ${step.expect}`] : [],
  );
}

const sessions = loadRecordedSessions();
let stopForwarding: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-19T10:00:00Z'));
  const harness = expectDefined(core.harness, 'mock store harness');
  harness.reset(harness.state());
  // Stands in for the IPC hop from the main process to the renderer.
  stopForwarding = onAgentActivityObservation(applyAgentActivityObservation);
});

afterEach(() => {
  stopForwarding();
  for (const session of sessions) clearAgentActivity(session.name);
  vi.useRealTimers();
});

describe('recorded agent sessions', () => {
  it('has recordings to replay', () => {
    expect(sessions.length).toBeGreaterThan(0);
  });

  it.each(sessions.map((session) => [session.name, session] as const))(
    'shows what the user saw: %s',
    (_name, session) => {
      expect(replay(session, session.name)).toEqual(expected(session));
    },
  );
});
