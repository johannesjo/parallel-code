import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRestartAgent = vi.fn();
const mockResumeAgentSession = vi.fn();
const mockListResumableSessions = vi.fn();
const mockSaveState = vi.fn();

interface TestTask {
  agentIds: string[];
  agentSessionIds?: Record<string, string>;
  planContent?: string;
  planFileName?: string;
  planPath?: string;
  promptDraft?: string;
  initialPrompt?: string;
  planHandoff?: { sessionId: string; command: string };
  promptedAgentIds?: string[];
  terminalInputPending?: boolean;
  codexChatHandoff?: { threadId: string };
  mainAgentView?: string;
  gitIsolation?: string;
}
const state: {
  tasks: Record<string, TestTask>;
  agents: Record<string, { def: { command: string } }>;
  showPromptInput?: boolean;
} = { tasks: {}, agents: {} };

vi.mock('./core', () => ({
  store: state,
  setStore: (...args: unknown[]) => {
    if (typeof args[0] === 'function') (args[0] as (s: typeof state) => void)(state);
  },
}));
vi.mock('./agents', () => ({ restartAgent: (...a: unknown[]) => mockRestartAgent(...a) }));
vi.mock('./sessions', () => ({
  resumeAgentSession: (...a: unknown[]) => mockResumeAgentSession(...a),
  listResumableSessions: (...a: unknown[]) => mockListResumableSessions(...a),
}));
vi.mock('./persistence', () => ({ saveState: () => mockSaveState() }));
vi.mock('./agent-chat', () => ({ isAgentChat: () => false }));

const { implementPlanInFreshSession, planningSessionToReturnTo, returnToPlanningSession } =
  await import('./plan-handoff');

const PLANNING = '11111111-2222-4333-8444-555555555555';
const EXPECTED_PROMPT =
  'Implement this approved plan. It was planned and approved in an earlier session, ' +
  'so this session starts with a clean context.\n' +
  'Plan file: .claude/plans/p.md (re-read it if you need it again).\n\n' +
  '# Plan';

beforeEach(() => {
  vi.clearAllMocks();
  state.agents = { a1: { def: { command: 'claude' } } };
  state.tasks = {
    t1: {
      agentIds: ['a1'],
      agentSessionIds: { a1: PLANNING },
      planContent: '# Plan',
      planFileName: '.claude/plans/p.md',
      gitIsolation: 'worktree',
    },
  };
});

describe('implementPlanInFreshSession', () => {
  it('queues the plan, remembers the planning session and restarts fresh', async () => {
    state.showPromptInput = false; // the prompt box is what delivers the plan
    expect(await implementPlanInFreshSession('t1')).toBeNull();
    expect(state.tasks.t1.initialPrompt).toBe(EXPECTED_PROMPT);
    expect(state.tasks.t1.planHandoff).toEqual({ sessionId: PLANNING, command: 'claude' });
    expect(mockRestartAgent).toHaveBeenCalledWith('a1', false);
    expect(mockSaveState).toHaveBeenCalled();
    expect(state.showPromptInput).toBe(true);
  });

  // An app restart before delivery resumes the pane; it must still get the plan,
  // and must not resume the chat thread the task started from.
  it('treats the fresh launch as not yet prompted', async () => {
    state.tasks.t1.promptedAgentIds = ['a1', 'a2'];
    state.tasks.t1.codexChatHandoff = { threadId: 'thread-1' };
    await implementPlanInFreshSession('t1');
    expect(state.tasks.t1.promptedAgentIds).toEqual(['a2']);
    expect(state.tasks.t1.codexChatHandoff).toBeUndefined();
  });

  // Codex picks its own session ids, so the planner's is read from the transcripts.
  it('looks up a Codex planning session from the session history', async () => {
    state.agents.a1.def.command = 'codex';
    state.tasks.t1.agentSessionIds = {};
    mockListResumableSessions.mockResolvedValue([{ id: PLANNING }]);
    await implementPlanInFreshSession('t1');
    expect(mockListResumableSessions).toHaveBeenCalledWith('t1', 'codex');
    expect(state.tasks.t1.planHandoff).toEqual({ sessionId: PLANNING, command: 'codex' });
  });

  // The project folder holds other tasks' and the user's own sessions too.
  it('does not guess the Codex planner outside a worktree of its own', async () => {
    state.agents.a1.def.command = 'codex';
    state.tasks.t1.agentSessionIds = {};
    state.tasks.t1.gitIsolation = 'direct';
    mockListResumableSessions.mockResolvedValue([{ id: PLANNING }]);
    expect(await implementPlanInFreshSession('t1')).not.toBeNull();
    expect(mockRestartAgent).not.toHaveBeenCalled();
  });

  // Guessing could later reopen another pane's conversation; without the
  // planner's session there is no way back, so nothing changes.
  it('refuses when two panes run the same CLI and the planner is unknown', async () => {
    state.agents = { a1: { def: { command: 'codex' } }, a2: { def: { command: 'codex' } } };
    state.tasks.t1.agentIds = ['a1', 'a2'];
    state.tasks.t1.agentSessionIds = {};
    expect(await implementPlanInFreshSession('t1')).toBe(
      'Could not tell which session the plan was made in, so nothing was changed. Close other panes running the same agent and try again.',
    );
    expect(mockListResumableSessions).not.toHaveBeenCalled();
    expect(mockRestartAgent).not.toHaveBeenCalled();
    expect(state.tasks.t1.initialPrompt).toBeUndefined();
  });

  it('refuses for CLIs whose planning session cannot be reopened', async () => {
    state.agents.a1.def.command = 'opencode';
    expect(await implementPlanInFreshSession('t1')).toBe(
      'Only available for Claude Code and Codex, whose planning session can be reopened.',
    );
    expect(mockRestartAgent).not.toHaveBeenCalled();
  });

  // Handing over again from the implementing session must keep Back pointing
  // at the conversation the plan was made in.
  it('keeps the original planning session when handing over again', async () => {
    const IMPLEMENTING = '99999999-8888-4777-8666-555555555555';
    state.tasks.t1.planHandoff = { sessionId: PLANNING, command: 'claude' };
    state.tasks.t1.agentSessionIds = { a1: IMPLEMENTING };
    await implementPlanInFreshSession('t1');
    expect(state.tasks.t1.planHandoff).toEqual({ sessionId: PLANNING, command: 'claude' });
    expect(mockRestartAgent).toHaveBeenCalledWith('a1', false);
  });

  it('leaves the planning session alone when text is typed into the terminal', async () => {
    state.tasks.t1.terminalInputPending = true;
    expect(await implementPlanInFreshSession('t1')).not.toBeNull();
    expect(mockRestartAgent).not.toHaveBeenCalled();
  });

  it('leaves the planning session alone when a draft is in the way', async () => {
    state.tasks.t1.promptDraft = 'half typed';
    expect(await implementPlanInFreshSession('t1')).toBe(
      'Send or clear the text in the prompt box first; it would block the plan.',
    );
    expect(mockRestartAgent).not.toHaveBeenCalled();
    expect(state.tasks.t1.initialPrompt).toBeUndefined();
  });

  it('gives up if the user starts typing during the session lookup', async () => {
    state.agents.a1.def.command = 'codex';
    state.tasks.t1.agentSessionIds = {};
    mockListResumableSessions.mockImplementation(async () => {
      state.tasks.t1.promptDraft = 'typed meanwhile';
      return [{ id: PLANNING }];
    });
    expect(await implementPlanInFreshSession('t1')).not.toBeNull();
    expect(mockRestartAgent).not.toHaveBeenCalled();
  });
});

describe('returnToPlanningSession', () => {
  const FRESH = '99999999-8888-4777-8666-555555555555';

  beforeEach(() => {
    state.tasks.t1.planHandoff = { sessionId: PLANNING, command: 'claude' };
    state.tasks.t1.agentSessionIds = { a1: FRESH };
  });

  it('reopens the planning session and drops a plan that is still queued', () => {
    state.tasks.t1.initialPrompt = EXPECTED_PROMPT;
    returnToPlanningSession('t1');
    expect(mockResumeAgentSession).toHaveBeenCalledWith('t1', 'a1', PLANNING);
    expect(state.tasks.t1.initialPrompt).toBeUndefined();
    expect(state.tasks.t1.planHandoff).toBeUndefined();
  });

  // The restart would discard what the user typed into the agent's terminal.
  it('refuses while text typed into the terminal is unsent', () => {
    state.tasks.t1.terminalInputPending = true;
    expect(returnToPlanningSession('t1')).toBe(
      'Send or clear the text typed into the agent first; the restart would discard it.',
    );
    expect(mockResumeAgentSession).not.toHaveBeenCalled();
    expect(state.tasks.t1.planHandoff).toEqual({ sessionId: PLANNING, command: 'claude' });
  });

  it('is not offered once the pane runs a different CLI', () => {
    state.agents.a1.def.command = 'codex';
    expect(planningSessionToReturnTo('t1')).toBeUndefined();
  });

  it('is not offered while the pane is already in the planning session', () => {
    state.tasks.t1.agentSessionIds = { a1: PLANNING };
    expect(planningSessionToReturnTo('t1')).toBeUndefined();
  });
});
