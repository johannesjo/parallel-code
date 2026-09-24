import { reconcile } from 'solid-js/store';
import { createMindMap } from '../graph/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../ipc/types';
import type { PersistedTask } from './types';
import { emptyWorkspace, updateDraft } from '../investigation/editing';

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: mockInvoke,
}));

import { loadState, resolveIncomingPanelUserSize, saveState } from './persistence';
import { setStore, store } from './core';
import { setAskCodeProvider } from './ui';
import { IPC } from '../../electron/ipc/channels';

function agentDef(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    args: [],
    resume_args: ['resume', '--last'],
    skip_permissions_args: [],
    description: 'Codex',
    ...overrides,
  };
}

function persistedTask(def: AgentDef): PersistedTask {
  return {
    id: 'task-1',
    name: 'Task',
    projectId: 'project-1',
    branchName: 'task/task-1',
    worktreePath: '/repo/.worktrees/task-1',
    notes: '',
    lastPrompt: '',
    shellCount: 0,
    agentDef: def,
    gitIsolation: 'worktree',
  };
}

async function loadPersistedAgent(def: AgentDef): Promise<AgentDef> {
  mockInvoke.mockResolvedValueOnce(
    JSON.stringify({
      projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
      lastProjectId: 'project-1',
      lastAgentId: null,
      taskOrder: ['task-1'],
      collapsedTaskOrder: [],
      tasks: {
        'task-1': persistedTask(def),
      },
      activeTaskId: 'task-1',
      sidebarVisible: true,
    }),
  );

  await loadState();

  const agentId = store.tasks['task-1']?.agentIds[0];
  expect(agentId).toBeTruthy();
  return store.agents[agentId as string].def;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(undefined);
  setStore('projects', []);
  setStore('lastProjectId', null);
  setStore('lastAgentId', null);
  setStore('taskOrder', []);
  setStore('collapsedTaskOrder', []);
  setStore('tasks', {});
  setStore('agents', {});
  setStore('activeTaskId', null);
  setStore('activeAgentId', null);
  setStore('availableAgents', []);
  setStore('customAgents', []);
  setStore('coordinatorControlHintDismissed', false);
  setStore('autoStartRemoteAccess', false);
  setStore('terminalScreenReaderMode', false);
});

describe('resolveIncomingPanelUserSize', () => {
  it('prefers panelUserSize when both new and legacy are present', () => {
    const result = resolveIncomingPanelUserSize({ 'tiling:a': 200 }, { 'tiling:a': 999 }, true);
    expect(result).toEqual({ 'tiling:a': 200 });
  });

  it('falls back to legacy panelSizes when new field is missing', () => {
    const result = resolveIncomingPanelUserSize(undefined, { 'sidebar:width': 280 }, true);
    expect(result).toEqual({ 'sidebar:width': 280 });
  });

  it('returns empty when neither source is a string->number record', () => {
    expect(resolveIncomingPanelUserSize(null, null, true)).toEqual({});
    expect(resolveIncomingPanelUserSize('nope', 42, true)).toEqual({});
    expect(resolveIncomingPanelUserSize({ x: 'string' }, null, true)).toEqual({});
  });

  it('wipes task:* entries on first v2 migration but keeps tiling:/sidebar: pins', () => {
    const result = resolveIncomingPanelUserSize(
      {
        'task:abc:ai-terminal': 400,
        'task:abc:shell-section': 300,
        'tiling:uuid-1': 520,
        'sidebar:width': 240,
      },
      undefined,
      undefined,
    );
    expect(result).toEqual({
      'tiling:uuid-1': 520,
      'sidebar:width': 240,
    });
  });

  it('passes task:* entries through once the v2 flag is set', () => {
    const result = resolveIncomingPanelUserSize(
      { 'task:abc:prompt': 120, 'tiling:x': 500 },
      undefined,
      true,
    );
    expect(result).toEqual({ 'task:abc:prompt': 120, 'tiling:x': 500 });
  });

  it('migrates legacy panelSizes values too (drops task:* unless flag is set)', () => {
    const result = resolveIncomingPanelUserSize(
      undefined,
      { 'task:xyz:ai-terminal': 300, 'tiling:p': 480 },
      undefined,
    );
    expect(result).toEqual({ 'tiling:p': 480 });
  });

  it('rejects records containing non-finite numbers (NaN / Infinity)', () => {
    const result = resolveIncomingPanelUserSize(
      { 'tiling:a': Number.NaN, 'tiling:b': 200 },
      undefined,
      true,
    );
    expect(result).toEqual({});
  });

  it('rejects records containing negative or absurdly large values', () => {
    expect(resolveIncomingPanelUserSize({ 'tiling:a': -5 }, undefined, true)).toEqual({});
    expect(resolveIncomingPanelUserSize({ 'tiling:a': 1_000_000 }, undefined, true)).toEqual({});
  });

  it('keeps reasonable pixel values through the validator', () => {
    const result = resolveIncomingPanelUserSize(
      { 'tiling:a': 0, 'sidebar:width': 240, 'tiling:b': 15_000 },
      undefined,
      true,
    );
    expect(result).toEqual({
      'tiling:a': 0,
      'sidebar:width': 240,
      'tiling:b': 15_000,
    });
  });
});

describe('loadState agent definition migrations', () => {
  it('migrates persisted Codex --full-auto skip-permissions args', async () => {
    const restored = await loadPersistedAgent(
      agentDef({
        skip_permissions_args: ['--full-auto', '--stale-extra'],
      }),
    );

    expect(restored.skip_permissions_args).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });

  it('leaves non-Codex --full-auto skip-permissions args unchanged', async () => {
    const restored = await loadPersistedAgent(
      agentDef({
        id: 'custom-agent',
        name: 'Custom Agent',
        command: 'custom',
        skip_permissions_args: ['--full-auto'],
      }),
    );

    expect(restored.skip_permissions_args).toEqual(['--full-auto']);
  });

  it('leaves current Codex skip-permissions args unchanged', async () => {
    const restored = await loadPersistedAgent(
      agentDef({
        skip_permissions_args: ['--dangerously-bypass-approvals-and-sandbox'],
      }),
    );

    expect(restored.skip_permissions_args).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
  });
});

describe('landing state persistence', () => {
  it('hydrates landed metadata and verification fields', async () => {
    const def = agentDef();
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        lastProjectId: 'project-1',
        lastAgentId: null,
        taskOrder: ['task-1'],
        collapsedTaskOrder: [],
        tasks: {
          'task-1': {
            ...persistedTask(def),
            coordinatedBy: 'coord-1',
            needsReview: true,
            verification: {
              checks: [{ name: 'test', command: 'npm test', result: 'passed' }],
            },
            landingState: 'landed_pending_review',
            landedMetadata: {
              taskId: 'task-1',
              taskName: 'Task',
              coordinatorTaskId: 'coord-1',
              targetBranch: 'main',
              landedCommit: 'abc123',
              landedAt: '2026-05-24T00:00:00Z',
              landedOrder: 1,
              verification: {
                checks: [{ name: 'test', command: 'npm test', result: 'passed' }],
              },
            },
          },
        },
        activeTaskId: 'task-1',
        sidebarVisible: true,
      }),
    );

    await loadState();

    expect(store.tasks['task-1'].landingState).toBe('landed_pending_review');
    expect(store.tasks['task-1'].landedMetadata?.landedCommit).toBe('abc123');
    expect(store.tasks['task-1'].verification?.checks[0].result).toBe('passed');
  });

  it('keeps finished verification runs but drops one that was still running', async () => {
    const def = agentDef();
    const finished = {
      command: 'npm test',
      status: 'failed',
      exitCode: 1,
      headSha: 'abc123',
      dirty: false,
      startedAt: '2026-09-03T10:00:00Z',
      finishedAt: '2026-09-03T10:01:00Z',
      outputTail: '1 failed\n',
    };
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        lastProjectId: 'project-1',
        lastAgentId: null,
        taskOrder: ['task-1', 'task-2'],
        collapsedTaskOrder: [],
        tasks: {
          'task-1': { ...persistedTask(def), verificationRun: finished },
          'task-2': {
            ...persistedTask(def),
            id: 'task-2',
            verificationRun: { ...finished, status: 'running', exitCode: null, finishedAt: null },
          },
        },
        activeTaskId: 'task-1',
        sidebarVisible: true,
      }),
    );

    await loadState();

    expect(store.tasks['task-1'].verificationRun).toEqual(finished);
    expect(store.tasks['task-2'].verificationRun).toBeUndefined();
  });
});

describe('coordinator concurrency limit persistence', () => {
  function stateWithTasks(tasks: Record<string, unknown>): string {
    return JSON.stringify({
      projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
      lastProjectId: 'project-1',
      lastAgentId: null,
      taskOrder: Object.keys(tasks),
      collapsedTaskOrder: [],
      tasks,
      activeTaskId: 'task-1',
      sidebarVisible: true,
    });
  }

  it('round-trips maxConcurrentTasks through load and save', async () => {
    const def = agentDef();
    mockInvoke.mockResolvedValueOnce(
      stateWithTasks({ 'task-1': { ...persistedTask(def), maxConcurrentTasks: 5 } }),
    );
    await loadState();
    expect(store.tasks['task-1'].maxConcurrentTasks).toBe(5);

    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const lastCall = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1];
    const saved = JSON.parse(lastCall[1].json);
    expect(saved.tasks['task-1'].maxConcurrentTasks).toBe(5);
  });

  it('clamps out-of-range values and drops non-numbers from hand-edited state', async () => {
    const def = agentDef();
    mockInvoke.mockResolvedValueOnce(
      stateWithTasks({
        'task-1': { ...persistedTask(def), maxConcurrentTasks: 99 },
        'task-2': {
          ...persistedTask(def),
          id: 'task-2',
          branchName: 'task/task-2',
          worktreePath: '/repo/.worktrees/task-2',
          maxConcurrentTasks: 'lots',
        },
      }),
    );
    await loadState();
    expect(store.tasks['task-1'].maxConcurrentTasks).toBe(20);
    expect(store.tasks['task-2'].maxConcurrentTasks).toBeUndefined();
  });
});

describe('Super Productivity link persistence', () => {
  function stateWith(
    tasks: Record<string, unknown>,
    projectExtra: Record<string, unknown>,
  ): string {
    return JSON.stringify({
      projects: [
        {
          id: 'project-1',
          name: 'Repo',
          path: '/repo',
          color: 'hsl(0, 70%, 75%)',
          ...projectExtra,
        },
      ],
      lastProjectId: 'project-1',
      lastAgentId: null,
      taskOrder: Object.keys(tasks),
      collapsedTaskOrder: [],
      tasks,
      activeTaskId: 'task-1',
      sidebarVisible: true,
    });
  }

  it('round-trips task links and the project mapping', async () => {
    const def = agentDef();
    mockInvoke.mockResolvedValueOnce(
      stateWith(
        {
          'task-1': {
            ...persistedTask(def),
            superProductivity: { taskId: 'sp_task-1', syncedTitle: 'Fix login' },
          },
        },
        { superProductivityProjectId: 'INBOX_PROJECT' },
      ),
    );
    await loadState();
    expect(store.tasks['task-1'].superProductivity).toEqual({
      taskId: 'sp_task-1',
      syncedTitle: 'Fix login',
    });
    expect(store.projects[0].superProductivityProjectId).toBe('INBOX_PROJECT');

    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const lastCall = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1];
    const saved = JSON.parse(lastCall[1].json);
    expect(saved.tasks['task-1'].superProductivity).toEqual({
      taskId: 'sp_task-1',
      syncedTitle: 'Fix login',
    });
    expect(saved.projects[0].superProductivityProjectId).toBe('INBOX_PROJECT');
  });

  it('drops malformed links from hand-edited state', async () => {
    const def = agentDef();
    mockInvoke.mockResolvedValueOnce(
      stateWith(
        {
          'task-1': {
            ...persistedTask(def),
            superProductivity: { taskId: '../x', syncedTitle: 'x' },
          },
        },
        { superProductivityProjectId: 42 },
      ),
    );
    await loadState();
    expect(store.tasks['task-1'].superProductivity).toBeUndefined();
    expect(store.projects[0].superProductivityProjectId).toBeUndefined();
  });
});

describe('collapsed session ownership persistence', () => {
  const session = 'fb4f2bc6-62d9-4b29-a795-240caf2fc459';
  it.each([
    { saved: [session, null, session], expected: [session, null, session] },
    { saved: [session, '--unsafe-flag', 42, session], expected: [session, null, null] },
    { saved: { 0: session }, expected: undefined },
    { saved: undefined, expected: undefined },
  ])('validates and round-trips saved sessions: $saved', async ({ saved, expected }) => {
    const def = agentDef();
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'blue' }],
        taskOrder: [],
        collapsedTaskOrder: ['task-1'],
        tasks: {
          'task-1': {
            ...persistedTask(def),
            collapsed: true,
            agentDefs: [def, def, def],
            savedAgentSessionIds: saved,
          },
        },
      }),
    );
    await loadState();
    expect(store.tasks['task-1'].savedAgentSessionIds).toEqual(expected);
    mockInvoke.mockClear();
    mockInvoke.mockResolvedValue(undefined);
    await saveState();
    const call = mockInvoke.mock.calls.find(([channel]) => channel === IPC.SaveAppState);
    const persisted = JSON.parse(call?.[1].json);
    expect(persisted.tasks['task-1'].savedAgentSessionIds).toEqual(expected);
  });
});

describe('reasoning profile persistence', () => {
  it.each(['architecture', 'research', 'explanation', undefined, 'unknown'])(
    'restores and saves %s for active and collapsed tasks',
    async (profile) => {
      mockInvoke.mockResolvedValueOnce(
        JSON.stringify({
          projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'blue' }],
          taskOrder: ['task-1'],
          collapsedTaskOrder: ['task-2'],
          activeTaskId: 'task-1',
          tasks: {
            'task-1': { ...persistedTask(agentDef()), reasoningProfile: profile },
            'task-2': {
              ...persistedTask(agentDef()),
              id: 'task-2',
              collapsed: true,
              reasoningProfile: profile,
            },
          },
        }),
      );
      await loadState();
      const expected =
        profile === 'architecture' || profile === 'research' || profile === 'explanation'
          ? profile
          : 'investigation';
      expect(store.tasks['task-1'].reasoningProfile).toBe(expected);
      expect(store.tasks['task-2'].reasoningProfile).toBe(expected);
      mockInvoke.mockClear();
      mockInvoke.mockResolvedValueOnce(undefined);
      await saveState();
      const call = mockInvoke.mock.calls.find(([channel]) => channel === IPC.SaveAppState);
      expect(call).toBeDefined();
      const saved = JSON.parse(call?.[1].json);
      expect(saved.tasks['task-1'].reasoningProfile).toBe(expected);
      expect(saved.tasks['task-2'].reasoningProfile).toBe(expected);
    },
  );
});

it('never writes a tour the agent published: it is runtime state only', async () => {
  mockInvoke.mockResolvedValueOnce(
    JSON.stringify({
      projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'blue' }],
      taskOrder: ['task-1'],
      tasks: { 'task-1': persistedTask(agentDef()) },
    }),
  );
  await loadState();
  setStore('tasks', 'task-1', 'agentTour', {
    revision: 1,
    payload: { subject: 'the retry bug', gist: {}, cards: [{}] },
  });
  mockInvoke.mockClear();
  mockInvoke.mockResolvedValueOnce(undefined);
  await saveState();
  const call = mockInvoke.mock.calls.find(([channel]) => channel === IPC.SaveAppState);
  expect(JSON.parse(call?.[1].json).tasks['task-1']).not.toHaveProperty('agentTour');
});

describe('mind map persistence', () => {
  it('keeps an unreadable map on disk, tells the user once, and keeps the task', async () => {
    const broken = { version: 1, revision: 'x', records: 'nope' };
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'blue' }],
        taskOrder: ['task-1'],
        tasks: { 'task-1': { ...persistedTask(agentDef()), name: 'Broken map', mindMap: broken } },
      }),
    );
    await loadState();
    expect(store.tasks['task-1'].mindMap).toBeUndefined();
    expect(store.notification).toContain('Broken map');
    expect(store.notification).toContain('kept on disk');
    mockInvoke.mockClear();
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const call = mockInvoke.mock.calls.find(([channel]) => channel === IPC.SaveAppState);
    expect(JSON.parse(call?.[1].json).tasks['task-1'].mindMap).toEqual(broken);
  });

  it('treats a null map as absent', async () => {
    setStore('notification', null);
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'blue' }],
        taskOrder: ['task-1'],
        tasks: { 'task-1': { ...persistedTask(agentDef()), mindMap: null } },
      }),
    );
    await loadState();
    expect(store.tasks['task-1'].mindMap).toBeUndefined();
    expect(store.tasks['task-1'].mindMapUnreadable).toBeUndefined();
    expect(store.notification ?? '').not.toContain('mind map');
  });

  it.each([false, true])(
    'round-trips map documents and tabs (collapsed: %s)',
    async (collapsed) => {
      const document = createMindMap('Saved topic');
      mockInvoke.mockResolvedValueOnce(
        JSON.stringify({
          projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'blue' }],
          taskOrder: collapsed ? [] : ['task-1'],
          collapsedTaskOrder: collapsed ? ['task-1'] : [],
          tasks: {
            'task-1': {
              ...persistedTask(agentDef()),
              collapsed,
              mindMap: document,
              canvasTabs: [{ kind: 'mindmap' }],
              canvasActiveTab: 'mindmap',
            },
          },
        }),
      );
      await loadState();
      expect(store.tasks['task-1'].mindMap).toEqual(document);
      expect(store.tasks['task-1'].canvasActiveTab).toBe('mindmap');
      mockInvoke.mockClear();
      mockInvoke.mockResolvedValueOnce(undefined);
      await saveState();
      const call = mockInvoke.mock.calls.find(([channel]) => channel === IPC.SaveAppState);
      expect(JSON.parse(call?.[1].json).tasks['task-1'].mindMap).toEqual(document);
    },
  );
});

describe('reasoning workspace persistence', () => {
  it('restores and saves user drafts for active and collapsed tasks, dropping malformed runs', async () => {
    const workspace = updateDraft(emptyWorkspace(), 'goal', {
      title: 'Unfinished edit',
      detail: '',
      base: { title: 'Goal', detail: '' },
      question: 'Investigate this',
    });
    const workspaces = { 'task/agent/run': workspace };
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'blue' }],
        taskOrder: ['task-1'],
        collapsedTaskOrder: ['task-2'],
        activeTaskId: 'task-1',
        tasks: {
          'task-1': {
            ...persistedTask(agentDef()),
            reasoningWorkspaces: { ...workspaces, broken: { edits: false } },
          },
          'task-2': {
            ...persistedTask(agentDef()),
            id: 'task-2',
            collapsed: true,
            reasoningWorkspaces: workspaces,
          },
        },
      }),
    );
    await loadState();
    for (const id of ['task-1', 'task-2'])
      expect(store.tasks[id].reasoningWorkspaces).toEqual(workspaces);
    mockInvoke.mockClear();
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const call = mockInvoke.mock.calls.find(([channel]) => channel === IPC.SaveAppState);
    expect(call).toBeDefined();
    const saved = JSON.parse(call?.[1].json);
    for (const id of ['task-1', 'task-2'])
      expect(saved.tasks[id].reasoningWorkspaces).toEqual(workspaces);
  });
});

describe('PR URL persistence', () => {
  it('persists task PR URLs', async () => {
    setStore('taskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task',
        projectId: 'project-1',
        branchName: 'task/task-1',
        worktreePath: '/repo/.worktrees/task-1',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        gitIsolation: 'worktree',
        prUrl: 'https://github.com/acme/app/pull/12',
      },
    });
    mockInvoke.mockResolvedValueOnce(undefined);

    await saveState();

    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.tasks['task-1'].prUrl).toBe('https://github.com/acme/app/pull/12');
  });

  it('restores canvas tabs, turning a pre-tabs canvasPath into one tab', async () => {
    const def = agentDef();
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        lastProjectId: 'project-1',
        lastAgentId: null,
        taskOrder: ['task-1', 'task-2'],
        collapsedTaskOrder: [],
        tasks: {
          'task-1': { ...persistedTask(def), canvasPath: 'docs/old.md' },
          'task-2': {
            ...persistedTask(def),
            id: 'task-2',
            canvasTabs: [
              { kind: 'reasoning' },
              { kind: 'markdown', path: 'a.md' },
              { kind: 'browser', url: 'x' },
            ],
            canvasActiveTab: 'markdown:gone.md',
          },
        },
        activeTaskId: 'task-1',
        sidebarVisible: true,
      }),
    );

    await loadState();

    expect(store.tasks['task-1']).toMatchObject({
      canvasTabs: [{ kind: 'markdown', path: 'docs/old.md' }],
      canvasActiveTab: 'markdown:docs/old.md',
    });
    // Unknown kinds are dropped and a stale active key falls back to the first tab.
    expect(store.tasks['task-2']).toMatchObject({
      canvasTabs: [{ kind: 'reasoning' }, { kind: 'markdown', path: 'a.md' }],
      canvasActiveTab: 'reasoning',
    });
  });

  it('restores task PR URLs', async () => {
    const def = agentDef();
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        lastProjectId: 'project-1',
        lastAgentId: null,
        taskOrder: ['task-1'],
        collapsedTaskOrder: [],
        tasks: {
          'task-1': {
            ...persistedTask(def),
            prUrl: 'https://github.com/acme/app/pull/12',
          },
        },
        activeTaskId: 'task-1',
        sidebarVisible: true,
      }),
    );

    await loadState();

    expect(store.tasks['task-1'].prUrl).toBe('https://github.com/acme/app/pull/12');
  });
});

describe('prompt draft persistence', () => {
  it('persists an unsent prompt draft on an active task', async () => {
    setStore('taskOrder', ['task-1']);
    setStore('collapsedTaskOrder', []);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task',
        projectId: 'project-1',
        branchName: 'task/task-1',
        worktreePath: '/repo/.worktrees/task-1',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        gitIsolation: 'worktree',
        promptDraft: 'remember to check the migration',
      },
    });
    mockInvoke.mockResolvedValueOnce(undefined);

    await saveState();

    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.tasks['task-1'].promptDraft).toBe('remember to check the migration');
  });

  it('restores an unsent prompt draft', async () => {
    const def = agentDef();
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        lastProjectId: 'project-1',
        lastAgentId: null,
        taskOrder: ['task-1'],
        collapsedTaskOrder: [],
        tasks: {
          'task-1': {
            ...persistedTask(def),
            promptDraft: 'remember to check the migration',
          },
        },
        activeTaskId: 'task-1',
        sidebarVisible: true,
      }),
    );

    await loadState();

    expect(store.tasks['task-1'].promptDraft).toBe('remember to check the migration');
  });

  it('restores an unsent prompt draft on a collapsed task', async () => {
    const def = agentDef();
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        lastProjectId: 'project-1',
        lastAgentId: null,
        taskOrder: [],
        collapsedTaskOrder: ['task-1'],
        tasks: {
          'task-1': {
            ...persistedTask(def),
            collapsed: true,
            promptDraft: 'draft on a collapsed task',
          },
        },
        activeTaskId: null,
        sidebarVisible: true,
      }),
    );

    await loadState();

    expect(store.tasks['task-1'].promptDraft).toBe('draft on a collapsed task');
  });

  it('ignores a non-string promptDraft from a corrupt file', async () => {
    const def = agentDef();
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        lastProjectId: 'project-1',
        lastAgentId: null,
        taskOrder: ['task-1'],
        collapsedTaskOrder: [],
        tasks: {
          'task-1': { ...persistedTask(def), promptDraft: 42 },
        },
        activeTaskId: 'task-1',
        sidebarVisible: true,
      }),
    );

    await loadState();

    expect(store.tasks['task-1'].promptDraft).toBeUndefined();
  });
});

describe('AI terminal layout persistence', () => {
  it('persists a task tabbed layout choice', async () => {
    setStore('taskOrder', ['task-1']);
    setStore('tasks', {
      'task-1': {
        id: 'task-1',
        name: 'Task',
        projectId: 'project-1',
        branchName: 'task/task-1',
        worktreePath: '/repo/.worktrees/task-1',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        gitIsolation: 'worktree',
        aiTerminalLayout: 'tabs',
      },
    });
    mockInvoke.mockResolvedValueOnce(undefined);

    await saveState();

    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.tasks['task-1'].aiTerminalLayout).toBe('tabs');
  });

  it('restores a tabbed layout and defaults the rest to split (undefined)', async () => {
    const def = agentDef();
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        lastProjectId: 'project-1',
        lastAgentId: null,
        taskOrder: ['task-1', 'task-2'],
        collapsedTaskOrder: [],
        tasks: {
          'task-1': { ...persistedTask(def), aiTerminalLayout: 'tabs' },
          'task-2': { ...persistedTask(def), id: 'task-2', aiTerminalLayout: 'nonsense' },
        },
        activeTaskId: 'task-1',
        sidebarVisible: true,
      }),
    );

    await loadState();

    expect(store.tasks['task-1'].aiTerminalLayout).toBe('tabs');
    // Unknown/absent values fall back to the default (split → undefined).
    expect(store.tasks['task-2'].aiTerminalLayout).toBeUndefined();
  });

  it('restores a tabbed layout for a collapsed task', async () => {
    const def = agentDef();
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        lastProjectId: 'project-1',
        lastAgentId: null,
        taskOrder: [],
        collapsedTaskOrder: ['task-1'],
        tasks: {
          'task-1': { ...persistedTask(def), collapsed: true, aiTerminalLayout: 'tabs' },
        },
        activeTaskId: null,
        sidebarVisible: true,
      }),
    );

    await loadState();

    expect(store.tasks['task-1'].aiTerminalLayout).toBe('tabs');
  });
});

// Minimal valid payload — no theme fields — used as a base for theme migration tests.
function basePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    projects: [{ id: 'p1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
    lastProjectId: 'p1',
    lastAgentId: null,
    taskOrder: [],
    collapsedTaskOrder: [],
    tasks: {},
    activeTaskId: null,
    sidebarVisible: true,
    ...overrides,
  });
}

describe('loadState theme persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStore('projects', []);
    setStore('taskOrder', []);
    setStore('collapsedTaskOrder', []);
    setStore('tasks', {});
    setStore('agents', {});
    setStore('activeTaskId', null);
    setStore('activeAgentId', null);
    setStore('availableAgents', []);
    setStore('customAgents', []);
  });

  it('defaults to dark mode with obsidian/islands-light when no theme fields saved', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload());
    await loadState();

    expect(store.appearanceMode).toBe('dark');
    expect(store.darkThemePreset).toBe('obsidian');
    expect(store.lightThemePreset).toBe('islands-light');
    expect(store.darkThemeCustomId).toBeNull();
    expect(store.lightThemeCustomId).toBeNull();
  });

  it('restores explicit appearanceMode values', async () => {
    for (const mode of ['light', 'dark', 'system'] as const) {
      mockInvoke.mockResolvedValueOnce(basePayload({ appearanceMode: mode }));
      await loadState();
      expect(store.appearanceMode).toBe(mode);
    }
  });

  it('falls back to dark for an invalid appearanceMode value', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ appearanceMode: 'solarized' }));
    await loadState();
    expect(store.appearanceMode).toBe('dark');
  });

  it('restores a valid darkThemePreset', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({ appearanceMode: 'dark', darkThemePreset: 'classic' }),
    );
    await loadState();
    expect(store.darkThemePreset).toBe('classic');
  });

  it('falls back to obsidian for an invalid darkThemePreset', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({ appearanceMode: 'dark', darkThemePreset: 'not-a-theme' }),
    );
    await loadState();
    expect(store.darkThemePreset).toBe('obsidian');
  });

  it.each(['dark', 'light', 'system'])(
    'preserves an omitted legacy dark slot in %s mode',
    async (appearanceMode) => {
      mockInvoke.mockResolvedValueOnce(basePayload({ appearanceMode }));
      await loadState();
      expect(store.darkThemePreset).toBe('islands-dark');
    },
  );

  it('saves and restores Obsidian explicitly when using the new default', async () => {
    setStore('darkThemePreset', 'obsidian');
    setStore('themePreset', 'obsidian');
    setStore('appearanceMode', 'dark');
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const savedCall = mockInvoke.mock.calls.find(([channel]) => channel === IPC.SaveAppState);
    const json = (savedCall?.[1] as { json: string }).json;
    expect(JSON.parse(json).darkThemePreset).toBe('obsidian');
    setStore('darkThemePreset', 'classic');
    mockInvoke.mockResolvedValueOnce(json);
    await loadState();
    expect(store.darkThemePreset).toBe('obsidian');
  });

  it('restores a valid lightThemePreset', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({ appearanceMode: 'light', lightThemePreset: 'islands-light' }),
    );
    await loadState();
    expect(store.lightThemePreset).toBe('islands-light');
  });

  it('saves the light slot explicitly so a new default cannot replace it', async () => {
    setStore('lightThemePreset', 'islands-light');
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const savedCall = mockInvoke.mock.calls.find(([channel]) => channel === IPC.SaveAppState);
    const json = (savedCall?.[1] as { json: string }).json;
    expect(JSON.parse(json).lightThemePreset).toBe('islands-light');
  });

  it('falls back to islands-light for an invalid lightThemePreset', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({ appearanceMode: 'light', lightThemePreset: 'bogus' }),
    );
    await loadState();
    expect(store.lightThemePreset).toBe('islands-light');
  });

  it('restores customId strings and nulls non-strings', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({
        appearanceMode: 'dark',
        darkThemeCustomId: 'my-custom',
        lightThemeCustomId: 42,
      }),
    );
    await loadState();
    expect(store.darkThemeCustomId).toBe('my-custom');
    expect(store.lightThemeCustomId).toBeNull();
  });

  it('backward compat: old themePreset=islands-light migrates to light mode', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ themePreset: 'islands-light' }));
    await loadState();
    expect(store.appearanceMode).toBe('light');
    expect(store.lightThemePreset).toBe('islands-light');
  });

  it('backward compat: old themePreset=classic (dark) migrates to dark mode', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ themePreset: 'classic' }));
    await loadState();
    expect(store.appearanceMode).toBe('dark');
    expect(store.darkThemePreset).toBe('classic');
  });

  it('backward compat: invalid old themePreset leaves dark mode with obsidian', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ themePreset: 'legacy-unknown' }));
    await loadState();
    expect(store.appearanceMode).toBe('dark');
    expect(store.darkThemePreset).toBe('obsidian');
  });
});

describe('terminal screen reader mode persistence', () => {
  it('defaults to false when absent from saved state', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload());

    await loadState();

    expect(store.terminalScreenReaderMode).toBe(false);
  });

  it('restores an enabled screen reader mode', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ terminalScreenReaderMode: true }));

    await loadState();

    expect(store.terminalScreenReaderMode).toBe(true);
  });

  it.each(['true', 1, null])('rejects a non-boolean persisted value (%s)', async (value) => {
    setStore('terminalScreenReaderMode', true);
    mockInvoke.mockResolvedValueOnce(basePayload({ terminalScreenReaderMode: value }));

    await loadState();

    expect(store.terminalScreenReaderMode).toBe(false);
  });

  it('omits the disabled default when saving', async () => {
    setStore('terminalScreenReaderMode', false);
    mockInvoke.mockResolvedValueOnce(undefined);

    await saveState();

    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.terminalScreenReaderMode).toBeUndefined();
  });

  it('persists the enabled setting', async () => {
    setStore('terminalScreenReaderMode', true);
    mockInvoke.mockResolvedValueOnce(undefined);

    await saveState();

    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.terminalScreenReaderMode).toBe(true);
  });
});

describe('coordinator control hint persistence', () => {
  it('does not persist dismissed=false', async () => {
    setStore('coordinatorControlHintDismissed', false);
    mockInvoke.mockResolvedValueOnce(undefined);

    await saveState();

    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.coordinatorControlHintDismissed).toBeUndefined();
  });

  it('persists dismissed=true', async () => {
    setStore('coordinatorControlHintDismissed', true);
    mockInvoke.mockResolvedValueOnce(undefined);

    await saveState();

    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.coordinatorControlHintDismissed).toBe(true);
  });

  it('restores dismissed=true from saved state', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [],
        taskOrder: [],
        collapsedTaskOrder: [],
        tasks: {},
        coordinatorControlHintDismissed: true,
      }),
    );

    await loadState();

    expect(store.coordinatorControlHintDismissed).toBe(true);
  });

  it('defaults to false when not in saved state', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [],
        taskOrder: [],
        collapsedTaskOrder: [],
        tasks: {},
      }),
    );

    await loadState();

    expect(store.coordinatorControlHintDismissed).toBe(false);
  });
});

describe('auto-start remote access persistence', () => {
  it('does not persist autoStartRemoteAccess=false', async () => {
    setStore('autoStartRemoteAccess', false);
    mockInvoke.mockResolvedValueOnce(undefined);

    await saveState();

    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.autoStartRemoteAccess).toBeUndefined();
  });

  it('persists autoStartRemoteAccess=true', async () => {
    setStore('autoStartRemoteAccess', true);
    mockInvoke.mockResolvedValueOnce(undefined);

    await saveState();

    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.autoStartRemoteAccess).toBe(true);
  });

  it('restores the flag and auto-starts the server on load', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({
            projects: [],
            taskOrder: [],
            collapsedTaskOrder: [],
            tasks: {},
            autoStartRemoteAccess: true,
          }),
        );
      }
      if (channel === IPC.StartRemoteServer) {
        return Promise.resolve({
          url: 'http://x/?token=t',
          wifiUrl: null,
          tailscaleUrl: null,
          port: 7777,
        });
      }
      return Promise.resolve(undefined);
    });

    await loadState();

    expect(store.autoStartRemoteAccess).toBe(true);
    expect(mockInvoke.mock.calls.some((c) => c[0] === IPC.StartRemoteServer)).toBe(true);
  });

  it('does not auto-start the server when the flag is absent', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.LoadAppState) {
        return Promise.resolve(
          JSON.stringify({ projects: [], taskOrder: [], collapsedTaskOrder: [], tasks: {} }),
        );
      }
      return Promise.resolve(undefined);
    });

    await loadState();

    expect(store.autoStartRemoteAccess).toBe(false);
    expect(mockInvoke.mock.calls.some((c) => c[0] === IPC.StartRemoteServer)).toBe(false);
  });
});

describe('projects section collapsed persistence', () => {
  it('defaults to expanded when not in saved state', async () => {
    setStore('projectsCollapsed', true);
    mockInvoke.mockResolvedValueOnce(basePayload());

    await loadState();

    expect(store.projectsCollapsed).toBe(false);
  });

  it('restores projectsCollapsed=true from saved state', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ projectsCollapsed: true }));

    await loadState();

    expect(store.projectsCollapsed).toBe(true);
  });

  it.each([
    ['string', 'yes'],
    ['number', 1],
    ['null', null],
    ['object', { collapsed: true }],
  ])('ignores a non-boolean projectsCollapsed value (%s)', async (_label, value) => {
    setStore('projectsCollapsed', true);
    mockInvoke.mockResolvedValueOnce(basePayload({ projectsCollapsed: value }));

    await loadState();

    expect(store.projectsCollapsed).toBe(false);
  });

  it('persists the collapsed flag through saveState', async () => {
    setStore('projectsCollapsed', true);
    mockInvoke.mockResolvedValueOnce(undefined);

    await saveState();

    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.projectsCollapsed).toBe(true);
  });
});

describe('project task group collapsed persistence', () => {
  it('restores boolean state and rejects malformed values', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({
        projects: [
          { id: 'p1', name: 'Repo', path: '/repo', color: '#abc', tasksCollapsed: true },
          { id: 'p2', name: 'Other', path: '/other', color: '#def', tasksCollapsed: 'yes' },
        ],
      }),
    );

    await loadState();

    expect(store.projects[0].tasksCollapsed).toBe(true);
    expect(store.projects[1].tasksCollapsed).toBeUndefined();
  });

  it('persists collapsed task groups with their projects', async () => {
    setStore('projects', [
      { id: 'p1', name: 'Repo', path: '/repo', color: '#abc', tasksCollapsed: true },
    ]);
    mockInvoke.mockResolvedValueOnce(undefined);

    await saveState();

    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.projects[0].tasksCollapsed).toBe(true);
  });
});

describe('new task defaults persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStore('defaultStepsEnabled', false);
    setStore('defaultSkipPermissions', false);
    setStore('defaultPropagateSkipPermissions', false);
  });

  // --- defaultStepsEnabled ---

  it('defaults defaultStepsEnabled to false when absent from saved state', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload());
    await loadState();
    expect(store.defaultStepsEnabled).toBe(false);
  });

  it('restores defaultStepsEnabled=true from saved state', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ defaultStepsEnabled: true }));
    await loadState();
    expect(store.defaultStepsEnabled).toBe(true);
  });

  it('does not persist defaultStepsEnabled=false', async () => {
    setStore('defaultStepsEnabled', false);
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.defaultStepsEnabled).toBeUndefined();
  });

  it('persists defaultStepsEnabled=true', async () => {
    setStore('defaultStepsEnabled', true);
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.defaultStepsEnabled).toBe(true);
  });

  it.each([
    ['string', 'yes'],
    ['number', 1],
    ['null', null],
  ])('ignores non-boolean defaultStepsEnabled (%s)', async (_label, value) => {
    setStore('defaultStepsEnabled', true);
    mockInvoke.mockResolvedValueOnce(basePayload({ defaultStepsEnabled: value }));
    await loadState();
    expect(store.defaultStepsEnabled).toBe(false);
  });

  it('invalid present defaultStepsEnabled does not fall back to showSteps=true', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [],
        taskOrder: [],
        collapsedTaskOrder: [],
        tasks: {},
        showSteps: true,
        defaultStepsEnabled: 'yes',
      }),
    );
    await loadState();
    expect(store.defaultStepsEnabled).toBe(false);
  });

  // --- defaultSkipPermissions ---

  it('defaults defaultSkipPermissions to false when absent from saved state', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload());
    await loadState();
    expect(store.defaultSkipPermissions).toBe(false);
  });

  it('restores defaultSkipPermissions=true from saved state', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ defaultSkipPermissions: true }));
    await loadState();
    expect(store.defaultSkipPermissions).toBe(true);
  });

  it('does not persist defaultSkipPermissions=false', async () => {
    setStore('defaultSkipPermissions', false);
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.defaultSkipPermissions).toBeUndefined();
  });

  it('persists defaultSkipPermissions=true', async () => {
    setStore('defaultSkipPermissions', true);
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.defaultSkipPermissions).toBe(true);
  });

  it.each([
    ['string', 'yes'],
    ['number', 1],
    ['null', null],
  ])('ignores non-boolean defaultSkipPermissions (%s)', async (_label, value) => {
    setStore('defaultSkipPermissions', true);
    mockInvoke.mockResolvedValueOnce(basePayload({ defaultSkipPermissions: value }));
    await loadState();
    expect(store.defaultSkipPermissions).toBe(false);
  });

  // --- defaultPropagateSkipPermissions ---

  it('defaults defaultPropagateSkipPermissions to false when absent from saved state', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload());
    await loadState();
    expect(store.defaultPropagateSkipPermissions).toBe(false);
  });

  it('restores defaultPropagateSkipPermissions=true from saved state', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ defaultPropagateSkipPermissions: true }));
    await loadState();
    expect(store.defaultPropagateSkipPermissions).toBe(true);
  });

  it('does not persist defaultPropagateSkipPermissions=false', async () => {
    setStore('defaultPropagateSkipPermissions', false);
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.defaultPropagateSkipPermissions).toBeUndefined();
  });

  it('persists defaultPropagateSkipPermissions=true', async () => {
    setStore('defaultPropagateSkipPermissions', true);
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.defaultPropagateSkipPermissions).toBe(true);
  });

  it.each([
    ['string', 'yes'],
    ['number', 1],
    ['null', null],
  ])('ignores non-boolean defaultPropagateSkipPermissions (%s)', async (_label, value) => {
    setStore('defaultPropagateSkipPermissions', true);
    mockInvoke.mockResolvedValueOnce(basePayload({ defaultPropagateSkipPermissions: value }));
    await loadState();
    expect(store.defaultPropagateSkipPermissions).toBe(false);
  });
});

describe('showSteps → defaultStepsEnabled migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStore('defaultStepsEnabled', false);
  });

  it('migrates legacy showSteps=true to defaultStepsEnabled=true', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [],
        taskOrder: [],
        collapsedTaskOrder: [],
        tasks: {},
        showSteps: true,
      }),
    );
    await loadState();
    expect(store.defaultStepsEnabled).toBe(true);
  });

  it('defaultStepsEnabled wins when both fields are present', async () => {
    // If a user saves with the new field but an old showSteps is also present
    // (e.g. partially migrated state), the explicit new field takes precedence.
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [],
        taskOrder: [],
        collapsedTaskOrder: [],
        tasks: {},
        showSteps: false,
        defaultStepsEnabled: true,
      }),
    );
    await loadState();
    expect(store.defaultStepsEnabled).toBe(true);
  });

  it('explicit defaultStepsEnabled=false is not overridden by showSteps=true', async () => {
    // This is the direction the old || logic got wrong — an explicit false was
    // overridden by a legacy true.  The new presence-check logic must respect
    // the explicit new field even when the legacy field disagrees.
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [],
        taskOrder: [],
        collapsedTaskOrder: [],
        tasks: {},
        showSteps: true,
        defaultStepsEnabled: false,
      }),
    );
    await loadState();
    expect(store.defaultStepsEnabled).toBe(false);
  });

  it('showSteps=false does not set defaultStepsEnabled=true', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [],
        taskOrder: [],
        collapsedTaskOrder: [],
        tasks: {},
        showSteps: false,
      }),
    );
    await loadState();
    expect(store.defaultStepsEnabled).toBe(false);
  });

  it('showSteps is not saved by saveState', async () => {
    setStore('defaultStepsEnabled', true);
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.showSteps).toBeUndefined();
    expect(saved.defaultStepsEnabled).toBe(true);
  });
});

describe('document full width persistence', () => {
  function stateJson(extra: Record<string, unknown>): string {
    return JSON.stringify({
      projects: [],
      lastProjectId: null,
      lastAgentId: null,
      taskOrder: [],
      collapsedTaskOrder: [],
      tasks: {},
      activeTaskId: null,
      sidebarVisible: true,
      ...extra,
    });
  }

  async function lastSaved(): Promise<Record<string, unknown>> {
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const lastCall = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1];
    return JSON.parse(lastCall[1].json) as Record<string, unknown>;
  }

  it('round-trips the preference and leaves the default out of the file', async () => {
    mockInvoke.mockResolvedValueOnce(stateJson({ documentFullWidth: true }));
    await loadState();
    expect(store.documentFullWidth).toBe(true);
    expect((await lastSaved()).documentFullWidth).toBe(true);

    mockInvoke.mockResolvedValueOnce(stateJson({ documentFullWidth: 'yes' }));
    await loadState();
    expect(store.documentFullWidth).toBe(false);
    expect((await lastSaved()).documentFullWidth).toBeUndefined();
  });
});

describe('code Q&A model persistence', () => {
  function stateJson(extra: Record<string, unknown>): string {
    return JSON.stringify({
      projects: [],
      lastProjectId: null,
      lastAgentId: null,
      taskOrder: [],
      collapsedTaskOrder: [],
      tasks: {},
      activeTaskId: null,
      sidebarVisible: true,
      ...extra,
    });
  }

  async function lastSaved(): Promise<Record<string, unknown>> {
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const lastCall = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1];
    return JSON.parse(lastCall[1].json) as Record<string, unknown>;
  }

  it('round-trips a chosen alias and leaves the sonnet default out of the file', async () => {
    mockInvoke.mockResolvedValueOnce(stateJson({ askCodeModel: 'opus' }));
    await loadState();
    expect(store.askCodeModel).toBe('opus');
    expect((await lastSaved()).askCodeModel).toBe('opus');

    mockInvoke.mockResolvedValueOnce(stateJson({ askCodeModel: 'gpt-4' }));
    await loadState();
    expect(store.askCodeModel).toBe('sonnet');
    expect((await lastSaved()).askCodeModel).toBeUndefined();
  });

  it('round-trips a Codex provider with its model slug', async () => {
    mockInvoke.mockResolvedValueOnce(
      stateJson({ askCodeProvider: 'codex', askCodeModel: 'gpt-5.6-luna' }),
    );
    await loadState();
    expect(store.askCodeProvider).toBe('codex');
    expect(store.askCodeModel).toBe('gpt-5.6-luna');
    const saved = await lastSaved();
    expect(saved.askCodeProvider).toBe('codex');
    expect(saved.askCodeModel).toBe('gpt-5.6-luna');
  });

  it('drops a Codex slug that could not be a CLI argument, leaving the CLI default', async () => {
    mockInvoke.mockResolvedValueOnce(
      stateJson({ askCodeProvider: 'codex', askCodeModel: '-- rm -rf /' }),
    );
    await loadState();
    expect(store.askCodeProvider).toBe('codex');
    expect(store.askCodeModel).toBe('');
    expect((await lastSaved()).askCodeModel).toBeUndefined();
  });

  it('replaces a model the newly chosen provider cannot run', async () => {
    mockInvoke.mockResolvedValueOnce(stateJson({ askCodeModel: 'opus' }));
    await loadState();

    setAskCodeProvider('codex');
    expect(store.askCodeModel).toBe('');
    setAskCodeProvider('claude');
    expect(store.askCodeModel).toBe('sonnet');
  });
});

describe('active task repair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStore('tasks', {});
    setStore('taskOrder', []);
    setStore('activeTaskId', 'stale');
    setStore('focusMode', false);
  });

  it('drops an active id that names nothing, such as a workspace agent task', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ activeTaskId: 'doc-agent-docs' }));

    await loadState();

    expect(store.activeTaskId).toBeNull();
  });
});

describe('document terminal persistence', () => {
  it('restores the terminal in the current project folder after a relink', async () => {
    const id = 'doc-agent-docs';
    mockInvoke.mockResolvedValueOnce(
      basePayload({
        projects: [
          {
            id: 'docs',
            name: 'Docs',
            path: '/new/docs',
            color: '',
            kind: 'document',
            documentPath: 'notes.md',
          },
        ],
        tasks: {
          [id]: {
            ...persistedTask(agentDef()),
            id,
            projectId: 'docs',
            worktreePath: '/old/docs',
            agentIds: [id],
          },
        },
        taskOrder: [],
      }),
    );
    await loadState();
    expect(store.tasks[id]?.worktreePath).toBe('/new/docs');
  });

  it('restores document agents and drafts without adding them to the coding task list', async () => {
    const id = 'doc-agent-docs';
    const task = {
      ...persistedTask(agentDef()),
      id,
      projectId: 'docs',
      worktreePath: '/docs',
      gitIsolation: 'none',
      agentIds: [id],
      promptDraft: 'Continue the introduction',
      lastPrompt: 'Revise the introduction',
    };
    mockInvoke.mockResolvedValueOnce(
      basePayload({
        projects: [
          {
            id: 'docs',
            name: 'Docs',
            path: '/docs',
            color: '',
            kind: 'document',
            documentPath: 'notes.md',
          },
        ],
        tasks: { [id]: task },
        taskOrder: [],
        activeTaskId: id,
        focusMode: true,
      }),
    );

    await loadState();

    expect(store.tasks[id]?.promptDraft).toBe(task.promptDraft);
    expect(store.agents[id]?.resumed).toBe(true);
    expect(store.agents[id]?.attachExisting).toBe(true);
    expect(store.taskOrder).toEqual([]);
    expect(store.activeTaskId).toBeNull();
    expect(store.focusMode).toBe(false);

    mockInvoke.mockResolvedValue(undefined);
    await saveState();
    const saved = mockInvoke.mock.calls.findLast(([channel]) => channel === IPC.SaveAppState);
    expect(JSON.parse(saved?.[1].json).tasks[id]).toMatchObject(task);
  });
});

describe('saveState failure reporting', () => {
  it('tells the user when the state file could not be written', async () => {
    vi.useFakeTimers();
    try {
      setStore('notification', null);
      mockInvoke.mockImplementation((channel: string) =>
        channel === IPC.SaveAppState
          ? Promise.reject(new Error('ENOSPC: no space left on device'))
          : Promise.resolve(undefined),
      );
      await saveState();
      expect(store.notification).toContain("Couldn't save app state");
      expect(store.notification).toContain('ENOSPC');
      // Rate-limited: a second failure right away does not re-toast...
      setStore('notification', null);
      await saveState();
      expect(store.notification).toBeNull();
      // ...but the reminder returns once the interval has passed.
      vi.advanceTimersByTime(60_000);
      await saveState();
      expect(store.notification).toContain("Couldn't save app state");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('browser preview persistence', () => {
  it('restores browser tabs and URLs for active and collapsed tasks', async () => {
    const tab = { kind: 'browser', path: 'preview' };
    const task = {
      ...persistedTask(agentDef()),
      canvasTabs: [tab],
      canvasActiveTab: 'browser:preview',
      browserUrl: 'http://localhost:5173/',
    };
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'blue' }],
        taskOrder: ['task-1'],
        collapsedTaskOrder: ['task-2'],
        tasks: { 'task-1': task, 'task-2': { ...task, id: 'task-2', collapsed: true } },
      }),
    );
    await loadState();
    for (const id of ['task-1', 'task-2']) {
      expect(store.tasks[id]).toMatchObject({
        canvasTabs: [tab],
        canvasActiveTab: 'browser:preview',
        browserUrl: task.browserUrl,
      });
    }
    mockInvoke.mockClear();
    await saveState();
    const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
    expect(saved.tasks['task-1'].browserUrl).toBe(task.browserUrl);
    expect(saved.tasks['task-2'].browserUrl).toBe(task.browserUrl);
  });
});

describe('prompt history persistence', () => {
  it.each([false, true])('restores and saves history for collapsed=%s', async (collapsed) => {
    const history = [
      { text: 'First prompt' },
      { text: 'Second\nmultiline prompt', sentAt: 1700000000000, agentId: 'agent-1' },
    ];
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: '#abc' }],
        taskOrder: collapsed ? [] : ['task-1'],
        collapsedTaskOrder: collapsed ? ['task-1'] : [],
        tasks: {
          'task-1': {
            ...persistedTask(agentDef()),
            collapsed,
            promptHistory: [...history, null, { text: 123 }, { text: ' ' }],
          },
        },
        activeTaskId: collapsed ? null : 'task-1',
        sidebarVisible: true,
      }),
    );
    await loadState();
    expect(store.tasks['task-1'].promptHistory).toEqual(history);
    mockInvoke.mockClear();
    await saveState();
    const savedCall = mockInvoke.mock.calls.find(([channel]) => channel === IPC.SaveAppState);
    expect(savedCall).toBeDefined();
    const saved = JSON.parse((savedCall?.[1] as { json: string }).json);
    expect(saved.tasks['task-1'].promptHistory).toEqual(history);
  });
});

it.each([false, true])('round-trips the chat session index (collapsed: %s)', async (collapsed) => {
  const sessions = [
    { threadId: 'saved-chat', provider: 'claude', title: 'Fix search', updatedAt: 1 },
  ];
  mockInvoke.mockResolvedValueOnce(
    JSON.stringify({
      projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
      taskOrder: collapsed ? [] : ['task-1'],
      collapsedTaskOrder: collapsed ? ['task-1'] : [],
      tasks: { 'task-1': { ...persistedTask(agentDef()), chatSessions: sessions } },
      activeTaskId: collapsed ? null : 'task-1',
    }),
  );
  await loadState();
  expect(store.tasks['task-1'].chatSessions).toEqual(sessions);
  mockInvoke.mockClear();
  await saveState();
  const saved = JSON.parse(mockInvoke.mock.calls[0][1].json);
  expect(saved.tasks['task-1'].chatSessions).toEqual(sessions);
});

it('round-trips canvas task links for active and collapsed tasks without reviving closed targets', async () => {
  const links = [
    { canvas: 'mindmap', nodeId: 'node', taskId: 'closed-task', taskName: 'Original task' },
    {
      canvas: 'reasoning',
      agentId: 'owner-agent',
      runId: 'run',
      nodeId: 'node',
      taskId: 'target',
      taskName: 'Work',
    },
  ];
  mockInvoke.mockResolvedValueOnce(
    JSON.stringify({
      projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'blue' }],
      taskOrder: ['task-1'],
      collapsedTaskOrder: ['task-2'],
      activeTaskId: 'task-1',
      tasks: {
        'task-1': { ...persistedTask(agentDef()), canvasTaskLinks: [...links, { broken: true }] },
        'task-2': {
          ...persistedTask(agentDef()),
          id: 'task-2',
          collapsed: true,
          canvasTaskLinks: links,
        },
      },
    }),
  );
  await loadState();
  for (const id of ['task-1', 'task-2']) expect(store.tasks[id].canvasTaskLinks).toEqual(links);
  expect(store.tasks['closed-task']).toBeUndefined();
  mockInvoke.mockClear();
  mockInvoke.mockResolvedValueOnce(undefined);
  await saveState();
  const call = mockInvoke.mock.calls.find(([channel]) => channel === IPC.SaveAppState);
  const saved = JSON.parse(call?.[1].json);
  for (const id of ['task-1', 'task-2']) expect(saved.tasks[id].canvasTaskLinks).toEqual(links);
});

it('restores parent authority before its child and round-trips delegation policy', async () => {
  const parent = { ...persistedTask(agentDef()), delegationParent: true, delegationPaused: true };
  const child = {
    ...persistedTask(agentDef()),
    id: 'child-authority',
    coordinatedBy: parent.id,
    integrationPolicy: 'review' as const,
  };
  mockInvoke.mockResolvedValueOnce(
    JSON.stringify({
      projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: '' }],
      taskOrder: [parent.id, child.id],
      collapsedTaskOrder: [],
      tasks: { 'child-authority': child, [parent.id]: parent },
    }),
  );
  await loadState();
  const registrations = mockInvoke.mock.calls.filter(
    ([channel, args]) => channel === IPC.DelegationRequest && args?.action === 'register',
  );
  expect(registrations.map(([, args]) => args.task.taskId)).toEqual([parent.id, child.id]);
  expect(store.tasks[parent.id].delegationParent).toBe(true);
  expect(store.tasks[parent.id].delegationPaused).toBe(true);
  expect(store.tasks[child.id].integrationPolicy).toBe('review');
  await saveState();
  const save = mockInvoke.mock.calls.findLast(([channel]) => channel === IPC.SaveAppState);
  expect(JSON.parse(save?.[1].json).tasks[child.id].integrationPolicy).toBe('review');
});

it('restores a child with a missing parent independently without losing its work', async () => {
  const child = {
    ...persistedTask(agentDef()),
    id: 'orphan-restore',
    coordinatedBy: 'missing-parent',
    integrationPolicy: 'review',
    mcpConfigPath: '/stale/config.json',
  };
  mockInvoke.mockResolvedValueOnce(
    JSON.stringify({
      projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: '' }],
      taskOrder: [child.id],
      collapsedTaskOrder: [],
      tasks: { [child.id]: child },
    }),
  );
  await loadState();
  expect(store.tasks[child.id]).toMatchObject({
    worktreePath: child.worktreePath,
    delegationPaused: true,
  });
  expect(store.tasks[child.id].coordinatedBy).toBeUndefined();
  expect(store.tasks[child.id].mcpConfigPath).toBeUndefined();
  expect(store.tasks[child.id].integrationPolicy).toBeUndefined();
  const registration = mockInvoke.mock.calls.find(
    ([channel, args]) => channel === IPC.DelegationRequest && args?.action === 'register',
  );
  expect(registration?.[1].task.parentTaskId).toBeUndefined();
});

it.each([
  { directMode: true, expected: 'direct' },
  { directMode: false, expected: 'worktree' },
])(
  'normalizes legacy task isolation before registering authority: $expected',
  async ({ directMode, expected }) => {
    const legacy = {
      ...persistedTask(agentDef()),
      id: 'legacy-authority',
      gitIsolation: undefined,
      directMode,
    };
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: '' }],
        taskOrder: [legacy.id],
        collapsedTaskOrder: [],
        tasks: { [legacy.id]: legacy },
      }),
    );
    await loadState();
    const registration = mockInvoke.mock.calls.find(
      ([channel, args]) => channel === IPC.DelegationRequest && args?.action === 'register',
    );
    expect(registration?.[1].task.gitIsolation).toBe(expected);
    expect(store.tasks[legacy.id].gitIsolation).toBe(expected);
  },
);

describe('MCP orchestration policy persistence', () => {
  beforeEach(() => setStore('tasks', reconcile({})));

  function stateJson(enabled?: unknown): string {
    return JSON.stringify({
      projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: '' }],
      taskOrder: ['task-1'],
      tasks: { 'task-1': persistedTask(agentDef()) },
      mcpOrchestrationEnabled: enabled,
    });
  }

  it('preserves an explicit disabled setting when saving', async () => {
    setStore('mcpOrchestrationEnabled', false);
    await saveState();
    const saved = mockInvoke.mock.calls.find(([channel]) => channel === IPC.SaveAppState);
    expect(saved).toBeDefined();
    expect(JSON.parse(saved?.[1].json).mcpOrchestrationEnabled).toBe(false);
  });

  it('awaits the saved global policy before registering or restoring any task', async () => {
    let acknowledge: (() => void) | undefined;
    mockInvoke.mockImplementation(async (channel, args) => {
      if (channel === IPC.LoadAppState) return stateJson(false);
      if (args?.action === 'orchestrationSetting') {
        await new Promise<void>((resolve) => (acknowledge = resolve));
      }
    });
    const loading = loadState();
    await vi.waitFor(() => expect(acknowledge).toBeDefined());
    expect(Object.keys(store.tasks)).toHaveLength(0);
    expect(mockInvoke).not.toHaveBeenCalledWith(
      IPC.DelegationRequest,
      expect.objectContaining({ action: 'register' }),
    );
    acknowledge?.();
    await loading;
    expect(store.mcpOrchestrationEnabled).toBe(false);
    expect(store.tasks['task-1']).toBeDefined();
    const actions = mockInvoke.mock.calls
      .filter(([channel]) => channel === IPC.DelegationRequest)
      .map(([, args]) => args.action);
    expect(actions).toEqual(['orchestrationSetting', 'projectPolicy', 'register']);
  });

  it.each([undefined, true, 'invalid'])(
    'defaults to enabled unless explicitly opted out (%s)',
    async (enabled) => {
      mockInvoke.mockResolvedValueOnce(stateJson(enabled));
      await loadState();
      expect(store.mcpOrchestrationEnabled).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
        action: 'orchestrationSetting',
        enabled: true,
      });
    },
  );

  it.each([undefined, false])(
    'discards legacy project creation consent without changing the global setting (%s)',
    async (enabled) => {
      const saved = JSON.parse(stateJson(enabled));
      saved.projects[0].allowAgentTaskCreation = false;
      saved.projects[0].allowPeerAccess = true;
      mockInvoke.mockResolvedValueOnce(JSON.stringify(saved));
      await loadState();
      expect(store.mcpOrchestrationEnabled).toBe(enabled !== false);
      expect(store.projects[0]).not.toHaveProperty('allowAgentTaskCreation');
      expect(store.projects[0].allowPeerAccess).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
        action: 'projectPolicy',
        policy: { projectId: 'project-1', allowPeerAccess: true },
      });
      await saveState();
      const persisted = mockInvoke.mock.calls.find(([channel]) => channel === IPC.SaveAppState);
      expect(JSON.parse(persisted?.[1].json).projects[0]).not.toHaveProperty(
        'allowAgentTaskCreation',
      );
    },
  );

  it('aborts restoration when the backend cannot apply the global policy', async () => {
    mockInvoke.mockImplementation(async (channel, args) => {
      if (channel === IPC.LoadAppState) return stateJson(false);
      if (args?.action === 'orchestrationSetting') throw new Error('Policy unavailable');
    });
    await expect(loadState()).rejects.toThrow('Policy unavailable');
    expect(Object.keys(store.tasks)).toHaveLength(0);
    expect(store.notification).toContain('Could not restore MCP settings');
    expect(mockInvoke).not.toHaveBeenCalledWith(
      IPC.DelegationRequest,
      expect.objectContaining({ action: 'register' }),
    );
  });
});

describe('task automation settings persistence', () => {
  it.each([false, true])(
    'round-trips explicit task options for collapsed=%s',
    async (collapsed) => {
      const options = {
        autoMergeChildren: true,
        autoSendChildUpdates: false,
        propagateSkipPermissions: true,
        maxConcurrentTasks: 4,
      };
      mockInvoke.mockResolvedValueOnce(
        JSON.stringify({
          projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: '' }],
          taskOrder: collapsed ? [] : ['task-1'],
          collapsedTaskOrder: collapsed ? ['task-1'] : [],
          tasks: { 'task-1': { ...persistedTask(agentDef()), collapsed, ...options } },
        }),
      );
      await loadState();
      expect(store.tasks['task-1']).toMatchObject(options);
      expect(store.tasks['task-1'].coordinatorMode).toBeUndefined();
      expect(mockInvoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
        action: 'register',
        task: expect.objectContaining(options),
      });
      await saveState();
      const save = mockInvoke.mock.calls.findLast(([channel]) => channel === IPC.SaveAppState);
      expect(JSON.parse(save?.[1].json).tasks['task-1']).toMatchObject(options);
    },
  );

  it('restores legacy task transport while ignoring the retired global coordinator switch', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: '' }],
        coordinatorModeEnabled: true,
        taskOrder: ['task-1'],
        collapsedTaskOrder: [],
        tasks: { 'task-1': { ...persistedTask(agentDef()), coordinatorMode: true } },
      }),
    );
    await loadState();
    expect(store.tasks['task-1']).toMatchObject({
      coordinatorMode: true,
      controlledBy: 'coordinator',
      mcpStartupStatus: 'pending',
    });
    expect(store.tasks['task-1'].autoSendChildUpdates).toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
      action: 'register',
      task: expect.objectContaining({ coordinatorMode: true }),
    });
    expect(
      mockInvoke.mock.calls.some(([channel]) => channel === 'set_coordinator_mode_enabled'),
    ).toBe(false);
    await saveState();
    const save = mockInvoke.mock.calls.findLast(([channel]) => channel === IPC.SaveAppState);
    expect(JSON.parse(save?.[1].json)).not.toHaveProperty('coordinatorModeEnabled');
    expect(JSON.parse(save?.[1].json).tasks['task-1'].coordinatorMode).toBe(true);
  });
});
