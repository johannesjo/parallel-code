import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefined, type MockStoreHarness } from './test-helpers';
import type { TaskOpenQuestion } from './taskStatus';
import type { Task } from './types';
import type { DelegationState, PeerMessage } from '../../electron/shared/delegation-types';

type MockTask = Partial<Task>;

type MockStore = {
  tasks: Record<string, MockTask>;
  agents: Record<string, never>;
  taskOrder: string[];
  collapsedTaskOrder: string[];
};

const core = vi.hoisted(() => ({
  harness: undefined as MockStoreHarness<MockStore> | undefined,
}));

const status = vi.hoisted(() => ({
  questions: new Map<string, TaskOpenQuestion[]>(),
  working: new Set<string>(),
}));

vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness<MockStore>({
    tasks: {},
    agents: {},
    taskOrder: [],
    collapsedTaskOrder: [],
  });
  return core.harness.moduleMock();
});

vi.mock('./taskStatus', () => ({
  getTaskOpenQuestions: (taskId: string) => status.questions.get(taskId) ?? [],
  isTaskWorking: (taskId: string) => status.working.has(taskId),
}));

const delegation = vi.hoisted(() => ({ states: {} as Record<string, DelegationState> }));
vi.mock('./delegation', () => ({ delegationStates: delegation.states }));

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

import {
  computeAttentionEntries,
  getChildAttentionSummary,
  jumpToWaitingTask,
} from './sidebar-attention';

function questionEntries() {
  return computeAttentionEntries()
    .filter((entry) => entry.kind === 'question')
    .map(({ taskId, since, panel }) => ({ taskId, since, panel }));
}
import { shellPanelId, shellPanelIndex } from './focused-panel';

let mockStore: MockStore;

beforeEach(() => {
  const harness = expectDefined(core.harness, 'mock store harness');
  mockStore = harness.reset({ tasks: {}, agents: {}, taskOrder: [], collapsedTaskOrder: [] });
  status.questions.clear();
  status.working.clear();
  for (const id of Object.keys(delegation.states)) delete delegation.states[id];
  for (const fn of Object.values(nav)) fn.mockClear();
});

/** Register a task plus the question its agent is asking, in one step. */
function askingTask(taskId: string, task: MockTask, question: TaskOpenQuestion | null): void {
  mockStore.tasks[taskId] = { agentIds: [], shellAgentIds: [], ...task };
  if (question) status.questions.set(taskId, [question]);
}

describe('questionEntries', () => {
  it('returns only tasks waiting on an answer, newest question first', () => {
    mockStore.taskOrder = ['task-1', 'task-2', 'task-3'];
    askingTask('task-1', { agentIds: ['agent-1'] }, { agentId: 'agent-1', since: 1_000 });
    askingTask('task-2', { agentIds: ['agent-2'] }, null);
    askingTask('task-3', { agentIds: ['agent-3'] }, { agentId: 'agent-3', since: 5_000 });

    expect(questionEntries()).toEqual([
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

    expect(questionEntries()).toEqual([
      { taskId: 'task-2', since: 9_000, panel: 'ai-terminal:agent-2' },
      { taskId: 'task-1', since: 1_000, panel: 'ai-terminal:agent-1' },
    ]);
  });

  it('skips ids with no task and never lists a task twice', () => {
    mockStore.taskOrder = ['task-1', 'ghost'];
    mockStore.collapsedTaskOrder = ['task-1'];
    askingTask('task-1', { agentIds: ['agent-1'] }, { agentId: 'agent-1', since: 42 });
    status.questions.set('ghost', [{ agentId: 'ghost-agent', since: 99 }]);

    expect(questionEntries()).toEqual([
      { taskId: 'task-1', since: 42, panel: 'ai-terminal:agent-1' },
    ]);
  });

  // `getTaskOpenQuestions` is mocked here, so these pin `panelForAskingAgent`'s
  // resolution, not the error/review masking — that regression is covered for
  // real against the live question detector in taskStatus.test.ts.
  it('resolves the panel of an asker that is not the first agent', () => {
    mockStore.taskOrder = ['task-1'];
    askingTask(
      'task-1',
      { agentIds: ['agent-first', 'agent-asking'] },
      { agentId: 'agent-asking', since: 7_000 },
    );

    expect(questionEntries()).toEqual([
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

    expect(questionEntries()[0].panel).toBe('shell:1');
  });

  // Guard, not a reachable state: the real `getTaskOpenQuestions` draws its
  // agent from the same two arrays `panelForAskingAgent` searches, so the panel
  // always resolves. Pinned so an unplaceable agent degrades to a listed row
  // rather than a dropped question.
  it('degrades to a listed row when the asking agent cannot be placed', () => {
    mockStore.taskOrder = ['task-1'];
    askingTask('task-1', { agentIds: ['agent-1'] }, { agentId: 'agent-gone', since: 3_000 });

    expect(questionEntries()).toEqual([{ taskId: 'task-1', since: 3_000, panel: null }]);
  });
});

describe('independent attention reasons', () => {
  it('preserves task order for reviews and questions with the same onset', () => {
    mockStore.taskOrder = ['task-z', 'task-a'];
    for (const taskId of mockStore.taskOrder) {
      askingTask(
        taskId,
        { agentIds: [taskId], needsReview: true },
        { agentId: taskId, since: 100 },
      );
    }
    expect(computeAttentionEntries().map(({ kind, taskId }) => [kind, taskId])).toEqual([
      ['question', 'task-z'],
      ['question', 'task-a'],
      ['review', 'task-z'],
      ['review', 'task-a'],
    ]);
  });

  function seedReview() {
    mockStore.taskOrder = ['task-1'];
    askingTask(
      'task-1',
      {
        agentIds: ['agent-1', 'agent-2'],
        integrationPolicy: 'review',
        needsReview: true,
        signalDoneReceived: true,
        signalDoneAt: '2026-09-26T10:00:00Z',
        signalDoneConsumed: true,
      },
      { agentId: 'agent-1', since: 100 },
    );
  }

  it('keeps every asker and one review despite overlapping completion markers and coordinator acknowledgment', () => {
    seedReview();
    status.questions.set('task-1', [
      { agentId: 'agent-1', since: 100 },
      { agentId: 'agent-2', since: 200 },
    ]);
    const entries = computeAttentionEntries();
    expect(entries.map((entry) => entry.kind)).toEqual(['question', 'question', 'review']);
    expect(entries.map((entry) => entry.panel)).toEqual([
      'ai-terminal:agent-2',
      'ai-terminal:agent-1',
      null,
    ]);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(3);
    status.questions.delete('task-1');
    expect(computeAttentionEntries().map((entry) => entry.kind)).toEqual(['review']);
  });

  it('removes a superseded review and changes its identity on a fresh completion', () => {
    seedReview();
    const key = computeAttentionEntries().find((entry) => entry.kind === 'review')?.key;
    mockStore.tasks['task-1'] = { agentIds: [], shellAgentIds: [], integrationPolicy: 'review' };
    status.questions.clear();
    expect(computeAttentionEntries()).toEqual([]);
    mockStore.tasks['task-1'].signalDoneReceived = true;
    mockStore.tasks['task-1'].signalDoneAt = '2026-09-26T11:00:00Z';
    expect(computeAttentionEntries()[0].key).not.toBe(key);
  });

  it('uses completion identity even when a new completion has the same timestamp', () => {
    seedReview();
    status.questions.clear();
    const task = mockStore.tasks['task-1'];
    const legacyKey = computeAttentionEntries()[0].key;
    const completion = {
      id: '11111111-1111-4111-8111-111111111111',
      completedAt: '2026-09-26T10:00:00.000Z',
      reviewRevision: 1,
      snapshotState: 'unknown' as const,
    };
    task.completion = completion;
    const firstKey = computeAttentionEntries()[0].key;
    expect(firstKey).not.toBe(legacyKey);
    task.completion = {
      ...completion,
      id: '22222222-2222-4222-8222-222222222222',
      reviewRevision: 2,
    };
    expect(computeAttentionEntries()[0].key).not.toBe(firstKey);
    expect(computeAttentionEntries()).toHaveLength(1);
  });

  it('keeps merged results until explicitly reviewed and reports cleanup failures separately', () => {
    seedReview();
    status.questions.clear();
    mockStore.tasks['task-1'].landingState = 'landed_pending_review';
    expect(computeAttentionEntries()[0].label).toBe('Review merged result');
    mockStore.tasks['task-1'].landingState = 'reviewed';
    expect(computeAttentionEntries()).toEqual([]);
    mockStore.tasks['task-1'].landingState = 'landed_cleanup_failed';
    expect(computeAttentionEntries().map((entry) => entry.kind)).toEqual(['integration_issue']);
  });

  it('lists failures before reviews without inventing failure ages, and removes dismissed failures', () => {
    seedReview();
    status.questions.clear();
    const session = {
      agentId: 'agent-1',
      sessionInstanceId: 'session',
      taskId: 'task-1',
      name: 'Task',
      agentLabel: 'Claude',
      branchName: 'task',
      status: 'running',
    };
    const message: PeerMessage = {
      deliveryId: 'delivery',
      sender: session,
      recipient: session,
      prompt: 'Work',
      createdAt: '2026-09-26T09:00:00Z',
      state: 'closed',
      deliveryFailed: true,
    };
    delegation.states['task-1'] = {
      attempts: [{ parentTaskId: 'task-1', requestId: 'request', name: 'Child', status: 'failed' }],
      messages: [
        message,
        { ...message, deliveryId: 'queued', deliveryFailed: false, state: 'waiting' },
      ],
      paused: false,
    };
    expect(computeAttentionEntries().map((entry) => entry.kind)).toEqual([
      'launch_failed',
      'delivery_failed',
      'review',
    ]);
    expect(
      computeAttentionEntries()
        .slice(0, 2)
        .every((entry) => entry.since === undefined),
    ).toBe(true);
    delegation.states['task-1'] = { attempts: [], messages: [], paused: false };
    expect(computeAttentionEntries().map((entry) => entry.kind)).toEqual(['review']);
  });

  it('omits closing or removed tasks', () => {
    seedReview();
    mockStore.tasks['task-1'].closingStatus = 'closing';
    expect(computeAttentionEntries()).toEqual([]);
    mockStore.tasks['task-1'].closingStatus = 'removing';
    expect(computeAttentionEntries()).toEqual([]);
    delete mockStore.tasks['task-1'];
    expect(computeAttentionEntries()).toEqual([]);
  });

  it('counts distinct children and independent working tasks, with failed launches separate', () => {
    seedReview();
    mockStore.tasks['task-1'].coordinatedBy = 'parent';
    mockStore.tasks.detached = { agentIds: [], shellAgentIds: [], needsReview: true };
    mockStore.taskOrder.push('detached');
    mockStore.collapsedTaskOrder = ['task-1'];
    status.working.add('task-1');
    status.working.add('detached');
    delegation.states.parent = {
      attempts: [{ parentTaskId: 'parent', requestId: 'request', name: 'Child', status: 'failed' }],
      messages: [],
      paused: false,
    };
    expect(getChildAttentionSummary('parent')).toBe(
      '1 need attention · 1 working · 1 launch failed',
    );
    mockStore.tasks['task-1'].coordinatedBy = undefined;
    expect(getChildAttentionSummary('parent')).toBe('1 launch failed');
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
