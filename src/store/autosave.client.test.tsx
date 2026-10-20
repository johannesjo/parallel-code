// Scheduling behaviour of the autosave effect. Lives in the client (happy-dom)
// config: the node config compiles solid-js for SSR, where createEffect is a
// no-op, so the effect under test would never run there.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'solid-js';
import { produce } from 'solid-js/store';
import { store, setStore } from './core';
import { setupAutosave, AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS } from './autosave';
import { createAgentRecord, setTaskPromptDraft } from './tasks';
import { restartAgent } from './agents';
import { clearAgentActivity } from './taskStatus';
import { setTaskReasoningWorkspace } from './canvas';
import { emptyWorkspace, updateDraft } from '../investigation/editing';

const { mockSaveState } = vi.hoisted(() => ({ mockSaveState: vi.fn(async () => {}) }));
vi.mock('./persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./persistence')>()),
  saveState: mockSaveState,
}));
describe('setupAutosave scheduling', () => {
  // Real solid-js reactivity over the real store; only the write is mocked.
  beforeEach(() => {
    vi.useFakeTimers();
    mockSaveState.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function withAutosave(run: () => void): void {
    // Effects created inside createRoot run when the root's setup returns, so
    // the scenario must execute after that. The initial effect pass schedules
    // one startup save (as it always has); let it land and discard it so each
    // scenario starts from a quiet, saved state.
    const dispose = createRoot((d) => {
      setupAutosave();
      return d;
    });
    vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
    expect(mockSaveState).toHaveBeenCalledTimes(1);
    mockSaveState.mockClear();
    try {
      run();
    } finally {
      dispose();
    }
  }

  it('debounces a burst of changes into one save after the quiet period', () => {
    withAutosave(() => {
      setStore('showSidebarTips', !store.showSidebarTips);
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1);
      setStore('showSidebarTips', !store.showSidebarTips);
      vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS - 1);
      expect(mockSaveState).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(mockSaveState).toHaveBeenCalledTimes(1);
    });
  });

  it('never postpones a save past the max wait while changes keep arriving', () => {
    withAutosave(() => {
      // Simulate continuous typing: a change every 500ms, never a 1s gap.
      const step = 500;
      const typeFor = (ms: number) => {
        for (let elapsed = 0; elapsed < ms; elapsed += step) {
          setStore('showSidebarTips', !store.showSidebarTips);
          vi.advanceTimersByTime(step);
        }
      };
      typeFor(AUTOSAVE_MAX_WAIT_MS - step);
      expect(mockSaveState).not.toHaveBeenCalled();
      // The forced save lands exactly at the max wait after the burst began...
      typeFor(step);
      expect(mockSaveState).toHaveBeenCalledTimes(1);
      // ...and the next burst gets its own max wait.
      typeFor(AUTOSAVE_MAX_WAIT_MS);
      expect(mockSaveState).toHaveBeenCalledTimes(2);
    });
  });

  it('does not save when nothing persisted changed', () => {
    withAutosave(() => {
      setStore('notification', 'transient toast');
      vi.advanceTimersByTime(AUTOSAVE_MAX_WAIT_MS * 2);
      expect(mockSaveState).not.toHaveBeenCalled();
    });
  });

  it('autosaves a fresh session after restarting an exited pane', () => {
    const id = 'session-autosave';
    const previousOrder = [...store.taskOrder];
    const previousSession = 'fb4f2bc6-62d9-4b29-a795-240caf2fc459';
    setStore('tasks', id, {
      id,
      name: 'Session',
      projectId: 'p1',
      worktreePath: '/session',
      branchName: '',
      agentIds: [id],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
      agentSessionIds: { [id]: previousSession },
    });
    setStore('agents', id, {
      ...createAgentRecord({
        id,
        taskId: id,
        def: {
          id: 'claude',
          name: 'Claude',
          command: 'claude',
          args: [],
          resume_args: ['--continue'],
          skip_permissions_args: [],
          description: '',
        },
      }),
      status: 'exited',
    });
    setStore('taskOrder', [...previousOrder, id]);
    try {
      withAutosave(() => {
        restartAgent(id, false);
        expect(store.tasks[id].agentSessionIds?.[id]).not.toBe(previousSession);
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
        expect(mockSaveState).toHaveBeenCalledTimes(1);
      });
    } finally {
      clearAgentActivity(id);
      setStore('taskOrder', previousOrder);
      setStore(
        produce((state) => {
          delete state.tasks['session-autosave'];
          delete state.agents['session-autosave'];
        }),
      );
    }
  });

  it('autosaves reasoning drafts and retains their deletion for active and collapsed tasks', () => {
    const id = 'reasoning-autosave';
    const previousOrder = [...store.taskOrder];
    const previousCollapsed = [...store.collapsedTaskOrder];
    setStore('tasks', id, {
      id,
      name: 'Graph',
      projectId: 'p1',
      worktreePath: '/graph',
      branchName: '',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
    setStore('taskOrder', [...previousOrder, id]);
    const workspace = updateDraft(emptyWorkspace(), 'goal', {
      title: 'Draft',
      detail: '',
      base: { title: 'Goal', detail: '' },
      question: '',
    });
    try {
      withAutosave(() => {
        setTaskReasoningWorkspace(id, 'run', workspace);
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
        expect(mockSaveState).toHaveBeenCalledTimes(1);
        setStore('taskOrder', previousOrder);
        setStore('collapsedTaskOrder', [...previousCollapsed, id]);
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
        mockSaveState.mockClear();
        setTaskReasoningWorkspace(id, 'run', updateDraft(workspace, 'goal', undefined));
        expect(store.tasks[id].reasoningWorkspaces?.run.drafts).toEqual({});
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
        expect(mockSaveState).toHaveBeenCalledTimes(1);
      });
    } finally {
      setStore('taskOrder', previousOrder);
      setStore('collapsedTaskOrder', previousCollapsed);
      setStore(
        produce((state) => {
          delete state.tasks['reasoning-autosave'];
        }),
      );
    }
  });

  it('autosaves drafts of hidden document tasks after typing settles', () => {
    const id = 'doc-agent-autosave-docs';
    const previousProjects = [...store.projects];
    setStore('projects', [
      ...previousProjects,
      {
        id: 'autosave-docs',
        name: 'Docs',
        path: '/docs',
        color: '',
        kind: 'document',
      },
    ]);
    setStore('tasks', id, {
      id,
      name: 'Docs',
      projectId: 'autosave-docs',
      worktreePath: '/docs',
      branchName: '',
      gitIsolation: 'none',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
    });
    try {
      withAutosave(() => {
        expect(store.taskOrder).not.toContain(id);
        setTaskPromptDraft(id, 'Keep this unfinished thought');
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
        expect(mockSaveState).toHaveBeenCalledTimes(1);
      });
    } finally {
      setStore('projects', previousProjects);
      setStore(
        produce((s) => {
          delete s.tasks['doc-agent-autosave-docs'];
        }),
      );
    }
  });

  it('does not re-serialize large task data on each keystroke, but still saves the text', () => {
    const id = 'typing-autosave';
    const previousOrder = [...store.taskOrder];
    const bigText = 'x'.repeat(100_000);
    setStore('tasks', id, {
      id,
      name: 'Typing',
      projectId: 'p1',
      worktreePath: '/typing',
      branchName: '',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      promptHistory: [{ text: bigText, sentAt: 1 }],
    });
    setStore('taskOrder', [...previousOrder, id]);
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      withAutosave(() => {
        stringify.mockClear();
        for (const text of ['h', 'he', 'hel']) setTaskPromptDraft(id, text);
        for (const text of ['n', 'no']) setStore('tasks', id, 'notes', text);
        const serialized = stringify.mock.results.map((r) => String(r.value));
        expect(serialized.every((s) => s.length < bigText.length)).toBe(true);
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
        expect(mockSaveState).toHaveBeenCalledTimes(1);
      });
    } finally {
      stringify.mockRestore();
      setStore('taskOrder', previousOrder);
      setStore(
        produce((state) => {
          delete state.tasks['typing-autosave'];
        }),
      );
    }
  });

  it('saves a task switch without re-serializing large task data', () => {
    const id = 'switch-autosave';
    const previousOrder = [...store.taskOrder];
    const previousActive = store.activeTaskId;
    const bigText = 'x'.repeat(100_000);
    setStore('tasks', id, {
      id,
      name: 'Switch',
      projectId: 'p1',
      worktreePath: '/switch',
      branchName: '',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      promptHistory: [{ text: bigText, sentAt: 1 }],
    });
    setStore('taskOrder', [...previousOrder, id]);
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      withAutosave(() => {
        stringify.mockClear();
        setStore('activeTaskId', id);
        const serialized = stringify.mock.results.map((r) => String(r.value));
        expect(serialized.every((s) => s.length < bigText.length)).toBe(true);
        vi.advanceTimersByTime(AUTOSAVE_DEBOUNCE_MS);
        expect(mockSaveState).toHaveBeenCalledTimes(1);
      });
    } finally {
      stringify.mockRestore();
      setStore('activeTaskId', previousActive);
      setStore('taskOrder', previousOrder);
      setStore(
        produce((state) => {
          delete state.tasks['switch-autosave'];
        }),
      );
    }
  });
});
