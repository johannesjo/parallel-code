import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../ipc/types';
import type { PersistedTask } from './types';

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: mockInvoke,
}));

import { loadState, resolveIncomingPanelUserSize, saveState } from './persistence';
import { setStore, store } from './core';
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

  it('defaults to dark mode with islands-dark/islands-light when no theme fields saved', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload());
    await loadState();

    expect(store.appearanceMode).toBe('dark');
    expect(store.darkThemePreset).toBe('islands-dark');
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

  it('falls back to islands-dark for an invalid darkThemePreset', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({ appearanceMode: 'dark', darkThemePreset: 'not-a-theme' }),
    );
    await loadState();
    expect(store.darkThemePreset).toBe('islands-dark');
  });

  it('restores a valid lightThemePreset', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({ appearanceMode: 'light', lightThemePreset: 'islands-light' }),
    );
    await loadState();
    expect(store.lightThemePreset).toBe('islands-light');
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

  it('backward compat: invalid old themePreset leaves dark mode with islands-dark', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ themePreset: 'legacy-unknown' }));
    await loadState();
    expect(store.appearanceMode).toBe('dark');
    expect(store.darkThemePreset).toBe('islands-dark');
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
