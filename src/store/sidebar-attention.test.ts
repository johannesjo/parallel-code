import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefined, type MockStoreHarness } from './test-helpers';
import type { TaskOpenQuestion } from './taskStatus';

type MockTask = { agentIds?: string[]; shellAgentIds?: string[]; collapsed?: boolean };

type MockStore = {
  tasks: Record<string, MockTask>;
  taskOrder: string[];
  collapsedTaskOrder: string[];
};

const core = vi.hoisted(() => ({
  harness: undefined as MockStoreHarness<MockStore> | undefined,
}));

const status = vi.hoisted(() => ({
  questions: new Map<string, TaskOpenQuestion>(),
}));

vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness<MockStore>({
    tasks: {},
    taskOrder: [],
    collapsedTaskOrder: [],
  });
  return core.harness.moduleMock();
});

vi.mock('./taskStatus', () => ({
  getTaskOpenQuestion: (taskId: string) => status.questions.get(taskId) ?? null,
}));

// Panel id construction stays real — the tests assert on the ids themselves —
// while the focus side effects are spied so `jumpToWaitingTask` is observable.
const nav = vi.hoisted(() => ({
  setTaskFocusedPanel: vi.fn(),
  getTaskFocusedPanel: vi.fn(() => 'ai-terminal:last-focused'),
  setActiveTask: vi.fn(),
  unfocusSidebar: vi.fn(),
  uncollapseTask: vi.fn(),
}));

vi.mock('./focused-panel', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('./focused-panel');
  return {
    ...actual,
    setTaskFocusedPanel: nav.setTaskFocusedPanel,
    getTaskFocusedPanel: nav.getTaskFocusedPanel,
  };
});
vi.mock('./navigation', () => ({ setActiveTask: nav.setActiveTask }));
vi.mock('./focus', () => ({ unfocusSidebar: nav.unfocusSidebar }));
vi.mock('./tasks', () => ({ uncollapseTask: nav.uncollapseTask }));

import { computeNeedsInputTasks, jumpToWaitingTask } from './sidebar-attention';
import { shellPanelId, shellPanelIndex } from './focused-panel';

let mockStore: MockStore;

beforeEach(() => {
  const harness = expectDefined(core.harness, 'mock store harness');
  mockStore = harness.reset({ tasks: {}, taskOrder: [], collapsedTaskOrder: [] });
  status.questions.clear();
  for (const fn of Object.values(nav)) fn.mockClear();
});

/** Register a task plus the question its agent is asking, in one step. */
function askingTask(taskId: string, task: MockTask, question: TaskOpenQuestion | null): void {
  mockStore.tasks[taskId] = { agentIds: [], shellAgentIds: [], ...task };
  if (question) status.questions.set(taskId, question);
}

describe('computeNeedsInputTasks', () => {
  it('returns only tasks waiting on an answer, newest question first', () => {
    mockStore.taskOrder = ['task-1', 'task-2', 'task-3'];
    askingTask('task-1', { agentIds: ['agent-1'] }, { agentId: 'agent-1', since: 1_000 });
    askingTask('task-2', { agentIds: ['agent-2'] }, null);
    askingTask('task-3', { agentIds: ['agent-3'] }, { agentId: 'agent-3', since: 5_000 });

    expect(computeNeedsInputTasks()).toEqual([
      { taskId: 'task-3', since: 5_000, panel: 'ai-terminal:agent-3' },
      { taskId: 'task-1', since: 1_000, panel: 'ai-terminal:agent-1' },
    ]);
  });

  // The collapsed sweep is inert in the real app (collapsing kills the agents),
  // so this pins the sweep itself rather than a state a user can reach.
  it('sweeps collapsed order too, keeping newest-first across both lists', () => {
    mockStore.taskOrder = ['task-1'];
    mockStore.collapsedTaskOrder = ['task-2'];
    askingTask('task-1', { agentIds: ['agent-1'] }, { agentId: 'agent-1', since: 1_000 });
    askingTask('task-2', { agentIds: ['agent-2'] }, { agentId: 'agent-2', since: 9_000 });

    expect(computeNeedsInputTasks()).toEqual([
      { taskId: 'task-2', since: 9_000, panel: 'ai-terminal:agent-2' },
      { taskId: 'task-1', since: 1_000, panel: 'ai-terminal:agent-1' },
    ]);
  });

  it('skips ids with no task and never lists a task twice', () => {
    mockStore.taskOrder = ['task-1', 'ghost'];
    mockStore.collapsedTaskOrder = ['task-1'];
    askingTask('task-1', { agentIds: ['agent-1'] }, { agentId: 'agent-1', since: 42 });
    status.questions.set('ghost', { agentId: 'ghost-agent', since: 99 });

    expect(computeNeedsInputTasks()).toEqual([
      { taskId: 'task-1', since: 42, panel: 'ai-terminal:agent-1' },
    ]);
  });

  // `getTaskOpenQuestion` is mocked here, so these pin `panelForAskingAgent`'s
  // resolution, not the error/review masking — that regression is covered for
  // real against the live question detector in taskStatus.test.ts.
  it('resolves the panel of an asker that is not the first agent', () => {
    mockStore.taskOrder = ['task-1'];
    askingTask(
      'task-1',
      { agentIds: ['agent-first', 'agent-asking'] },
      { agentId: 'agent-asking', since: 7_000 },
    );

    expect(computeNeedsInputTasks()).toEqual([
      { taskId: 'task-1', since: 7_000, panel: 'ai-terminal:agent-asking' },
    ]);
  });

  it('targets the asking shell by its panel index', () => {
    mockStore.taskOrder = ['task-1'];
    askingTask(
      'task-1',
      { agentIds: ['agent-1'], shellAgentIds: ['shell-a', 'shell-b'] },
      { agentId: 'shell-b', since: 3_000 },
    );

    expect(computeNeedsInputTasks()[0].panel).toBe('shell:1');
  });

  // Guard, not a reachable state: the real `getTaskOpenQuestion` draws its
  // agent from the same two arrays `panelForAskingAgent` searches, so the panel
  // always resolves. Pinned so an unplaceable agent degrades to a listed row
  // rather than a dropped question.
  it('degrades to a listed row when the asking agent cannot be placed', () => {
    mockStore.taskOrder = ['task-1'];
    askingTask('task-1', { agentIds: ['agent-1'] }, { agentId: 'agent-gone', since: 3_000 });

    expect(computeNeedsInputTasks()).toEqual([{ taskId: 'task-1', since: 3_000, panel: null }]);
  });
});

describe('jumpToWaitingTask', () => {
  it('focuses the asking AI terminal rather than the last focused panel', () => {
    askingTask('task-1', { agentIds: ['agent-1', 'agent-2'] }, null);

    jumpToWaitingTask('task-1', 'ai-terminal:agent-2');

    expect(nav.setTaskFocusedPanel).toHaveBeenCalledWith('task-1', 'ai-terminal:agent-2');
    expect(nav.getTaskFocusedPanel).not.toHaveBeenCalled();
  });

  it('focuses the asking shell by its panel index', () => {
    askingTask('task-1', { agentIds: ['agent-1'], shellAgentIds: ['shell-a', 'shell-b'] }, null);

    jumpToWaitingTask('task-1', 'shell:1');

    expect(nav.setTaskFocusedPanel).toHaveBeenCalledWith('task-1', 'shell:1');
  });

  it('falls back to the last focused panel when the asking agent has no panel', () => {
    askingTask('task-1', { agentIds: ['agent-1'] }, null);

    jumpToWaitingTask('task-1', null);

    expect(nav.setTaskFocusedPanel).toHaveBeenCalledWith('task-1', 'ai-terminal:last-focused');
  });

  it('selects the task before focusing the panel, so the asking tab wins', () => {
    // `setActiveTask` derives its own agent from the recorded focused panel, so
    // focusing last is what brings a non-selected agent's tab to the front.
    askingTask('task-1', { agentIds: ['agent-1', 'agent-2'] }, null);

    jumpToWaitingTask('task-1', 'ai-terminal:agent-2');

    const selected = nav.setActiveTask.mock.invocationCallOrder[0];
    const focused = nav.setTaskFocusedPanel.mock.invocationCallOrder[0];
    expect(selected).toBeLessThan(focused);
  });

  it('uncollapses a collapsed task before opening it', () => {
    askingTask('task-1', { agentIds: ['agent-1'], collapsed: true }, null);

    jumpToWaitingTask('task-1', 'ai-terminal:agent-1');

    expect(nav.uncollapseTask).toHaveBeenCalledWith('task-1');
    expect(nav.unfocusSidebar).toHaveBeenCalled();
  });

  it('leaves an expanded task alone', () => {
    askingTask('task-1', { agentIds: ['agent-1'] }, null);

    jumpToWaitingTask('task-1', 'ai-terminal:agent-1');

    expect(nav.uncollapseTask).not.toHaveBeenCalled();
  });
});

describe('jumpToWaitingTask panel validation', () => {
  // Unreachable today, but this is the one guard that would fail hard rather
  // than degrade: `uncollapseTask` mints fresh agent ids, so a panel captured
  // before an uncollapse names an agent that no longer exists.
  it('falls back when the panel names an agent the task no longer has', () => {
    askingTask('task-1', { agentIds: ['agent-1'] }, null);

    jumpToWaitingTask('task-1', 'ai-terminal:agent-gone');

    expect(nav.setTaskFocusedPanel).toHaveBeenCalledWith('task-1', 'ai-terminal:last-focused');
  });

  it('falls back when the shell index is out of range', () => {
    askingTask('task-1', { agentIds: ['agent-1'], shellAgentIds: ['shell-a'] }, null);

    jumpToWaitingTask('task-1', 'shell:3');

    expect(nav.setTaskFocusedPanel).toHaveBeenCalledWith('task-1', 'ai-terminal:last-focused');
  });

  it('keeps a non-terminal panel as-is', () => {
    askingTask('task-1', { agentIds: ['agent-1'] }, null);

    jumpToWaitingTask('task-1', 'notes');

    expect(nav.setTaskFocusedPanel).toHaveBeenCalledWith('task-1', 'notes');
  });
});

describe('shell panel id parsing', () => {
  it('round-trips a built id', () => {
    expect(shellPanelIndex(shellPanelId(3))).toBe(3);
  });

  // `Number('')` is 0 and `Number('1e2')` is 100, so a loose parse would let
  // these validate as real panels in `panelIsLive`.
  it.each(['shell:', 'shell:1e2', 'shell:-0', 'shell:1.5', 'shell: 1', 'ai-terminal:a'])(
    'rejects %s',
    (panel) => {
      expect(shellPanelIndex(panel)).toBeNull();
    },
  );

  it('falls back rather than focusing a malformed shell panel', () => {
    askingTask('task-1', { agentIds: ['agent-1'], shellAgentIds: ['shell-a'] }, null);

    jumpToWaitingTask('task-1', 'shell:');

    expect(nav.setTaskFocusedPanel).toHaveBeenCalledWith('task-1', 'ai-terminal:last-focused');
  });
});
