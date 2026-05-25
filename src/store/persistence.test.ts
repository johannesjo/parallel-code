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

describe('coordinator control defaults', () => {
  it('restores coordinator tasks to human control when persisted state omits controlledBy', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({
        taskOrder: ['coord-1'],
        tasks: {
          'coord-1': {
            ...persistedTask(agentDef()),
            id: 'coord-1',
            coordinatorMode: true,
          },
        },
        activeTaskId: 'coord-1',
      }),
    );

    await loadState();

    expect(store.tasks['coord-1']?.controlledBy).toBe('human');
  });

  it('restores coordinated child tasks to coordinator control when persisted state omits controlledBy', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({
        taskOrder: ['child-1'],
        tasks: {
          'child-1': {
            ...persistedTask(agentDef()),
            id: 'child-1',
            coordinatedBy: 'coord-1',
          },
        },
        activeTaskId: 'child-1',
      }),
    );

    await loadState();

    expect(store.tasks['child-1']?.controlledBy).toBe('coordinator');
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
