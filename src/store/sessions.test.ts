import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { SessionRecord } from '../../electron/shared/session-record';

const mockInvoke = vi.fn();
const mockRestartAgent = vi.fn();
const mockSaveState = vi.fn();
const mockSetStore = vi.fn();
const state: {
  tasks: Record<
    string,
    {
      worktreePath: string;
      agentIds: string[];
      agentSessionIds?: Record<string, string>;
      codexChatHandoff?: { threadId: string };
      lastPrompt?: string;
      promptHistory?: Array<{ text: string; agentId?: string }>;
    }
  >;
} = { tasks: {} };

vi.mock('../lib/ipc', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
vi.mock('./agents', () => ({ restartAgent: (...args: unknown[]) => mockRestartAgent(...args) }));
vi.mock('./persistence', () => ({ saveState: () => mockSaveState() }));
vi.mock('./core', () => ({
  store: state,
  setStore: (...args: unknown[]) => {
    // Mirror solid's produce form so the module's mutation is observable.
    if (typeof args[0] === 'function') (args[0] as (s: typeof state) => void)(state);
    mockSetStore(...args);
  },
}));

const { listResumableSessions, resumeAgentSession } = await import('./sessions');

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { id: 's1', agent: 'claude', cwd: '/w/alpha', updatedAt: 1, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.tasks = { t1: { worktreePath: '/w/alpha', agentIds: ['a1', 'a2'] } };
});

describe('listResumableSessions', () => {
  it('asks the backend for the task worktree', async () => {
    mockInvoke.mockResolvedValue([]);
    await listResumableSessions('t1', 'claude');
    expect(mockInvoke).toHaveBeenCalledWith(IPC.ListSessions, { cwd: '/w/alpha' });
  });

  // A Claude session id means nothing to Codex; offering it would break the launch.
  it('keeps only sessions this CLI can resume', async () => {
    mockInvoke.mockResolvedValue([
      session({ id: 'claude-1', agent: 'claude' }),
      session({ id: 'codex-1', agent: 'codex' }),
    ]);
    const forClaude = await listResumableSessions('t1', 'claude');
    expect(forClaude.map((s) => s.id)).toEqual(['claude-1']);
    const forCodex = await listResumableSessions('t1', 'codex');
    expect(forCodex.map((s) => s.id)).toEqual(['codex-1']);
  });

  it.each(['gemini', 'opencode', 'agy', 'copilot'])(
    'returns nothing and does not scan for %s',
    async (command) => {
      await expect(listResumableSessions('t1', command)).resolves.toEqual([]);
      expect(mockInvoke).not.toHaveBeenCalled();
    },
  );

  it('returns nothing for an unknown task', async () => {
    await expect(listResumableSessions('missing', 'claude')).resolves.toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // The scan reads the filesystem; a failure leaves the pane on its positional
  // resume rather than surfacing an error the user cannot act on.
  it('resolves empty when the scan fails', async () => {
    mockInvoke.mockRejectedValue(new Error('EACCES'));
    await expect(listResumableSessions('t1', 'claude')).resolves.toEqual([]);
  });
});

describe('resumeAgentSession', () => {
  it('replaces a primary pane chat handoff with the explicitly selected session', () => {
    state.tasks.t1.codexChatHandoff = { threadId: 'old-handoff' };
    resumeAgentSession('t1', 'a1', 'selected-session');
    expect(state.tasks.t1.codexChatHandoff).toBeUndefined();
    expect(state.tasks.t1.agentSessionIds?.a1).toBe('selected-session');
  });

  it('preserves the primary pane handoff when selecting a secondary pane session', () => {
    state.tasks.t1.codexChatHandoff = { threadId: 'primary-handoff' };
    resumeAgentSession('t1', 'a2', 'selected-session');
    expect(state.tasks.t1.codexChatHandoff).toEqual({ threadId: 'primary-handoff' });
  });
  it('drops the pane’s prompts only when picking a different session', () => {
    const history = [
      { text: 'a1 prompt', agentId: 'a1' },
      { text: 'a2 prompt', agentId: 'a2' },
    ];
    state.tasks.t1.promptHistory = history;
    state.tasks.t1.agentSessionIds = { a1: 'current' };
    resumeAgentSession('t1', 'a1', 'current');
    expect(state.tasks.t1.promptHistory).toEqual(history);
    resumeAgentSession('t1', 'a1', 'older');
    expect(state.tasks.t1.promptHistory).toEqual([{ text: 'a2 prompt', agentId: 'a2' }]);
  });

  it('stores the id and restarts with resume', () => {
    resumeAgentSession('t1', 'a1', 'session-42');
    expect(state.tasks.t1.agentSessionIds).toEqual({ a1: 'session-42' });
    expect(mockRestartAgent).toHaveBeenCalledWith('a1', true);
  });

  // Order matters: the relaunch reads the stored id, so a restart before the
  // write would resume the previous session.
  it('writes the id before restarting', () => {
    let seen: Record<string, string> | undefined;
    mockRestartAgent.mockImplementationOnce(() => {
      seen = { ...state.tasks.t1.agentSessionIds };
    });
    resumeAgentSession('t1', 'a1', 'session-42');
    expect(seen).toEqual({ a1: 'session-42' });
  });

  it('persists the choice', () => {
    resumeAgentSession('t1', 'a1', 'session-42');
    expect(mockSaveState).toHaveBeenCalled();
  });

  it('replaces an id the pane already had', () => {
    state.tasks.t1.agentSessionIds = { a1: 'old' };
    resumeAgentSession('t1', 'a1', 'new');
    expect(state.tasks.t1.agentSessionIds).toEqual({ a1: 'new' });
  });

  it('does nothing for an unknown task', () => {
    resumeAgentSession('missing', 'a1', 'session-42');
    expect(mockRestartAgent).not.toHaveBeenCalled();
  });
});
