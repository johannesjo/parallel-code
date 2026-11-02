import { getLocalDateKey } from '../lib/date';
import { produce, reconcile } from 'solid-js/store';
import { createMindMap } from '../graph/model';
import {
  DEFAULT_INDEPENDENT_TASKS_PER_CREATOR,
  MAX_INDEPENDENT_TASKS_PER_CREATOR,
} from '../lib/coordinator-limits';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(async () => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(undefined);
  // Saving is enabled only after the initial state has been read successfully.
  await loadState();
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
  setStore('keybindingMigrationDismissed', false);
  setStore('featureHintsEnabled', true);
  setStore('seenFeatureHints', []);
  setStore('autoStartRemoteAccess', false);
  setStore('terminalScreenReaderMode', false);
  setStore('preferUiMode', false);
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

  it('keeps the extra flags of a pane across a restart', async () => {
    const restored = await loadPersistedAgent(agentDef({ extra_args: ['--chrome'] }));

    expect(restored.extra_args).toEqual(['--chrome']);
  });

  it('drops malformed extra flags instead of passing them to the CLI', async () => {
    const restored = await loadPersistedAgent(
      agentDef({ extra_args: ['--chrome', 42] as unknown as string[] }),
    );

    expect(restored).not.toHaveProperty('extra_args');
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

describe('background verify persistence', () => {
  function stateWith(project: Record<string, unknown>, tasks: Record<string, unknown>): string {
    return JSON.stringify({
      projects: [
        { id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)', ...project },
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

  it('round-trips the last verify pass and drops a malformed one', async () => {
    const def = agentDef();
    const pass = { command: 'npm test', headSha: 'abc123', finishedAt: '2026-09-03T10:01:00Z' };
    mockInvoke.mockResolvedValueOnce(
      stateWith(
        {},
        {
          'task-1': { ...persistedTask(def), lastVerifyPass: pass },
          'task-2': {
            ...persistedTask(def),
            id: 'task-2',
            branchName: 'task/task-2',
            worktreePath: '/repo/.worktrees/task-2',
            lastVerifyPass: { command: 'npm test', headSha: 7 },
          },
        },
      ),
    );
    await loadState();
    expect(store.tasks['task-1'].lastVerifyPass).toEqual(pass);
    expect(store.tasks['task-2'].lastVerifyPass).toBeUndefined();

    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const lastCall = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1];
    expect(JSON.parse(lastCall[1].json).tasks['task-1'].lastVerifyPass).toEqual(pass);
  });

  it('round-trips review dismissals and drops malformed ones', async () => {
    const def = agentDef();
    const dismissed = { 'risk:no real provider.': { text: 'No real provider.', reason: 'CI' } };
    mockInvoke.mockResolvedValueOnce(
      stateWith(
        {},
        {
          'task-1': { ...persistedTask(def), reviewDismissed: dismissed },
          'task-2': {
            ...persistedTask(def),
            id: 'task-2',
            branchName: 'task/task-2',
            worktreePath: '/repo/.worktrees/task-2',
            reviewDismissed: { 'risk:x': 'not an entry' },
          },
        },
      ),
    );
    await loadState();
    expect(store.tasks['task-1'].reviewDismissed).toEqual(dismissed);
    expect(store.tasks['task-2'].reviewDismissed).toBeUndefined();

    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const lastCall = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1];
    expect(JSON.parse(lastCall[1].json).tasks['task-1'].reviewDismissed).toEqual(dismissed);
  });

  it.each([
    [false, false],
    [true, undefined],
    ['yes', undefined],
  ])('keeps verifyAutoRun only when it is off: %j', async (stored, loaded) => {
    mockInvoke.mockResolvedValueOnce(stateWith({ verifyAutoRun: stored }, {}));
    await loadState();
    expect(store.projects[0].verifyAutoRun).toBe(loaded);
  });

  it('loads a package saved with the removed claim, review and flag fields, then drops them', async () => {
    const def = agentDef();
    const run = {
      checkId: 'verify',
      name: 'Verify',
      kind: 'custom',
      command: 'npm test',
      status: 'running',
      exitCode: null,
      headSha: 'a'.repeat(40),
      dirty: false,
      startedAt: '2026-09-03T10:00:00Z',
      outputTail: 'ok',
    };
    const legacy = {
      id: 'pkg-1',
      createdAt: '2026-09-03T10:00:00Z',
      trigger: 'agent',
      assembling: true,
      scan: { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), dirty: false, files: [] },
      checks: [run],
      skipped: [],
      claim: { summary: 'Done', submittedAt: '2026-09-03T10:00:00Z' },
      review: { status: 'running', provider: 'claude', headSha: 'a'.repeat(40), findings: [] },
      acceptedFlags: { 'flag-1': 'fine' },
      dismissedFindings: ['f1'],
      sentToAgent: ['r1'],
    };
    mockInvoke.mockResolvedValueOnce(
      stateWith(
        { evidenceAutoBuild: true, evidenceModel: { when: 'risky', provider: 'codex' } },
        { 'task-1': { ...persistedTask(def), evidence: legacy } },
      ),
    );
    await loadState();
    const pkg = store.tasks['task-1'].evidence;
    expect(pkg).toMatchObject({ id: 'pkg-1', assembling: false, skipped: [] });
    expect(pkg?.checks[0]).toMatchObject({ checkId: 'verify', status: 'cancelled' });
    expect(store.projects[0]).not.toHaveProperty('evidenceModel');
    expect(store.projects[0]).not.toHaveProperty('evidenceAutoBuild');

    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const lastCall = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1];
    const saved = JSON.parse(lastCall[1].json);
    expect(Object.keys(saved.tasks['task-1'].evidence).sort()).toEqual([
      'assembling',
      'checks',
      'id',
      'scan',
      'skipped',
    ]);
    expect(saved.projects[0]).not.toHaveProperty('evidenceAutoBuild');
  });
});

describe('completion report persistence', () => {
  const completion = {
    id: '11111111-1111-4111-8111-111111111111',
    completedAt: '2026-09-26T10:00:00.000Z',
    reviewRevision: 3,
    sourceCommit: 'a'.repeat(40),
    snapshotState: 'dirty',
    result: {
      summary: 'Implemented the task',
      verification: { checks: [{ name: 'Tests', command: 'npm test', result: 'passed' }] },
      artifacts: [{ path: 'reports/result.txt', label: 'Result' }],
      unresolvedIssues: ['Native smoke check pending'],
    },
  };

  async function restore(value: unknown, reviewRevision: unknown = 3) {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        taskOrder: ['task-1'],
        collapsedTaskOrder: ['task-2'],
        tasks: {
          'task-1': { ...persistedTask(agentDef()), completion: value, reviewRevision },
          'task-2': {
            ...persistedTask(agentDef()),
            id: 'task-2',
            collapsed: true,
            completion: value,
            reviewRevision,
          },
        },
        activeTaskId: 'task-1',
        sidebarVisible: true,
      }),
    );
    await loadState();
  }

  it('round-trips completion reports and revisions for active and collapsed tasks', async () => {
    await restore(completion);
    expect(store.tasks['task-2'].collapsed).toBe(true);
    for (const taskId of ['task-1', 'task-2']) {
      expect(store.tasks[taskId].completion).toEqual(completion);
      expect(store.tasks[taskId].reviewRevision).toBe(3);
    }
    await saveState();
    const savedCall = [...mockInvoke.mock.calls]
      .reverse()
      .find(([channel]) => channel === IPC.SaveAppState);
    expect(savedCall).toBeDefined();
    const saved = JSON.parse(savedCall?.[1].json);
    for (const taskId of ['task-1', 'task-2']) {
      expect(saved.tasks[taskId].completion).toEqual(completion);
      expect(saved.tasks[taskId].reviewRevision).toBe(3);
    }
  });

  it.each([
    undefined,
    null,
    { ...completion, snapshotState: 'invalid' },
    { ...completion, result: { summary: 42 } },
  ])(
    'drops absent or invalid completion data without restoring a previous report: %j',
    async (invalid) => {
      await restore(completion);
      await restore(invalid, -1);
      for (const taskId of ['task-1', 'task-2']) {
        expect(store.tasks[taskId].completion).toBeUndefined();
        expect(store.tasks[taskId].reviewRevision).toBeUndefined();
      }
      await saveState();
      const savedCall = [...mockInvoke.mock.calls]
        .reverse()
        .find(([channel]) => channel === IPC.SaveAppState);
      const saved = JSON.parse(savedCall?.[1].json);
      expect(saved.tasks['task-1']).not.toHaveProperty('completion');
      expect(saved.tasks['task-2']).not.toHaveProperty('completion');
    },
  );
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

describe('agent tour persistence', () => {
  const payload = {
    subject: 'the retry bug',
    gist: { title: 'Retries hide the failure' },
    cards: [{ title: 'One idea' }],
    context: 'The agent read the retry loop.',
  };

  it.each([false, true])(
    'keeps the published tour across a restart without reopening it (collapsed: %s)',
    async (collapsed) => {
      mockInvoke.mockResolvedValueOnce(
        JSON.stringify({
          projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'blue' }],
          taskOrder: collapsed ? [] : ['task-1'],
          collapsedTaskOrder: collapsed ? ['task-1'] : [],
          tasks: { 'task-1': { ...persistedTask(agentDef()), collapsed, agentTour: payload } },
        }),
      );
      await loadState();
      // Revision 0 marks a restored tour, so the panel does not pop it open at startup.
      expect(store.tasks['task-1'].agentTour).toEqual({ revision: 0, payload });
      mockInvoke.mockClear();
      mockInvoke.mockResolvedValueOnce(undefined);
      await saveState();
      const call = mockInvoke.mock.calls.find(([channel]) => channel === IPC.SaveAppState);
      expect(JSON.parse(call?.[1].json).tasks['task-1'].agentTour).toEqual(payload);
    },
  );

  it('drops a saved tour that fails validation', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'blue' }],
        taskOrder: ['task-1'],
        tasks: { 'task-1': { ...persistedTask(agentDef()), agentTour: { subject: '' } } },
      }),
    );
    await loadState();
    expect(store.tasks['task-1']).toBeDefined();
    expect(store.tasks['task-1'].agentTour).toBeUndefined();
  });
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

  it('restores PR babysitting progress and repairs malformed values', async () => {
    const def = agentDef();
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
        lastProjectId: 'project-1',
        lastAgentId: null,
        taskOrder: ['task-1', 'task-2', 'task-3'],
        collapsedTaskOrder: [],
        tasks: {
          'task-1': {
            ...persistedTask(def),
            prBabysit: { attempts: 2, lastSentSha: 'abc', stalled: true },
          },
          'task-2': { ...persistedTask(def), id: 'task-2', prBabysit: { attempts: 'x' } },
          'task-3': { ...persistedTask(def), id: 'task-3' },
        },
        activeTaskId: 'task-1',
        sidebarVisible: true,
      }),
    );

    await loadState();

    expect(store.tasks['task-1'].prBabysit).toEqual({
      attempts: 2,
      lastSentSha: 'abc',
      stalled: true,
    });
    expect(store.tasks['task-2'].prBabysit).toEqual({ attempts: 0 });
    expect(store.tasks['task-3'].prBabysit).toBeUndefined();
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

  it('defaults to dark mode with parallel-code/islands-light when no theme fields saved', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload());
    await loadState();

    expect(store.appearanceMode).toBe('dark');
    expect(store.darkThemePreset).toBe('parallel-code');
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

  it('falls back to parallel-code for an invalid darkThemePreset', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({ appearanceMode: 'dark', darkThemePreset: 'not-a-theme' }),
    );
    await loadState();
    expect(store.darkThemePreset).toBe('parallel-code');
  });

  it.each(['dark', 'light', 'system'])(
    'preserves an omitted legacy dark slot in %s mode',
    async (appearanceMode) => {
      mockInvoke.mockResolvedValueOnce(basePayload({ appearanceMode }));
      await loadState();
      expect(store.darkThemePreset).toBe('islands-dark');
    },
  );

  it('keeps a saved Obsidian preference after the default changed', async () => {
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

  it('backward compat: invalid old themePreset leaves dark mode with parallel-code', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ themePreset: 'legacy-unknown' }));
    await loadState();
    expect(store.appearanceMode).toBe('dark');
    expect(store.darkThemePreset).toBe('parallel-code');
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

    const byId = (id: string) => store.projects.find((p) => p.id === id);
    expect(byId('p1')?.tasksCollapsed).toBe(true);
    expect(byId('p2')?.tasksCollapsed).toBeUndefined();
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

describe('UI mode preference persistence', () => {
  it.each([true, false, undefined, 'true', 1])('restores only boolean true (%s)', async (value) => {
    setStore('preferUiMode', true);
    mockInvoke.mockResolvedValueOnce(basePayload({ preferUiMode: value }));
    await loadState();
    expect(store.preferUiMode).toBe(value === true);
  });

  it.each([true, false])(
    'round-trips the preference (%s) without changing saved task views',
    async (enabled) => {
      setStore('preferUiMode', enabled);
      await saveState();
      const saved = JSON.parse(mockInvoke.mock.calls.at(-1)?.[1].json);
      expect(saved.preferUiMode).toBe(enabled || undefined);
      mockInvoke.mockResolvedValueOnce(
        basePayload({
          ...saved,
          tasks: { 'task-1': { ...persistedTask(agentDef()), mainAgentView: 'terminal' } },
          taskOrder: ['task-1'],
        }),
      );
      await loadState();
      expect(store.preferUiMode).toBe(enabled);
      expect(store.tasks['task-1'].mainAgentView).not.toBe('chat');
    },
  );
});

describe('Claude UI mode switch-off persistence', () => {
  const claude = agentDef({ id: 'claude-code', name: 'Claude Code', command: 'claude' });
  const sessionId = '11111111-2222-4333-8444-555555555555';

  afterEach(() => setStore('disableClaudeUiMode', false));

  it.each([true, false, undefined, 'true'])('restores only boolean true (%s)', async (value) => {
    setStore('disableClaudeUiMode', true);
    mockInvoke.mockResolvedValueOnce(basePayload({ disableClaudeUiMode: value }));
    await loadState();
    expect(store.disableClaudeUiMode).toBe(value === true);
  });

  it('saves the setting only when on', async () => {
    setStore('disableClaudeUiMode', true);
    await saveState();
    expect(JSON.parse(mockInvoke.mock.calls.at(-1)?.[1].json).disableClaudeUiMode).toBe(true);
    setStore('disableClaudeUiMode', false);
    await saveState();
    expect(JSON.parse(mockInvoke.mock.calls.at(-1)?.[1].json).disableClaudeUiMode).toBeUndefined();
  });

  it.each([
    [true, claude, undefined],
    [false, claude, 'chat'],
    [true, agentDef(), 'chat'],
  ] as const)(
    'with chat off: %s, a %s task saved in chat restores to %s',
    async (disabled, def, expected) => {
      mockInvoke.mockResolvedValueOnce(
        basePayload({
          disableClaudeUiMode: disabled,
          tasks: {
            'task-1': {
              ...persistedTask(def),
              mainAgentView: 'chat',
              claudeChatSessionId: sessionId,
            },
          },
          taskOrder: ['task-1'],
        }),
      );
      await loadState();
      const task = store.tasks['task-1'];
      expect(task.mainAgentView).toBe(expected);
      if (expected === undefined) {
        // The terminal resumes the conversation the chat had.
        expect(task.agentSessionIds?.[task.agentIds[0]]).toBe(sessionId);
      }
    },
  );
});

describe('new task defaults persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStore('defaultSkipPermissions', false);
    setStore('defaultPropagateSkipPermissions', false);
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

  // --- maxIndependentTasksPerCreator ---

  it('restores maxIndependentTasksPerCreator and clamps it into range', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload({ maxIndependentTasksPerCreator: 30 }));
    await loadState();
    expect(store.maxIndependentTasksPerCreator).toBe(30);
    mockInvoke.mockResolvedValueOnce(basePayload({ maxIndependentTasksPerCreator: 1000 }));
    await loadState();
    expect(store.maxIndependentTasksPerCreator).toBe(MAX_INDEPENDENT_TASKS_PER_CREATOR);
    mockInvoke.mockResolvedValueOnce(basePayload({ maxIndependentTasksPerCreator: 'many' }));
    await loadState();
    expect(store.maxIndependentTasksPerCreator).toBe(DEFAULT_INDEPENDENT_TASKS_PER_CREATOR);
  });

  it('persists maxIndependentTasksPerCreator only when changed from the default', async () => {
    setStore('maxIndependentTasksPerCreator', DEFAULT_INDEPENDENT_TASKS_PER_CREATOR);
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    expect(JSON.parse(mockInvoke.mock.calls[0][1].json).maxIndependentTasksPerCreator).toBe(
      undefined,
    );
    mockInvoke.mockClear();
    setStore('maxIndependentTasksPerCreator', 25);
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    expect(JSON.parse(mockInvoke.mock.calls[0][1].json).maxIndependentTasksPerCreator).toBe(25);
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

describe('task brief settings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps task briefs off unless they were turned on', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload());
    await loadState();
    expect(store.taskBriefs).toBe(false);
    mockInvoke.mockResolvedValueOnce(basePayload({ taskBriefs: true }));
    await loadState();
    expect(store.taskBriefs).toBe(true);
    mockInvoke.mockResolvedValueOnce(basePayload({ taskBriefs: 'yes' }));
    await loadState();
    expect(store.taskBriefs).toBe(false);
  });

  it('restores the header fields, keeping the default for any missing or malformed one', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload());
    await loadState();
    expect(store.briefBarFields).toEqual({ goal: true, now: false, needsYou: true });
    mockInvoke.mockResolvedValueOnce(
      basePayload({ briefBarFields: { goal: false, now: true, needsYou: 'no' } }),
    );
    await loadState();
    expect(store.briefBarFields).toEqual({ goal: false, now: true, needsYou: true });
  });
});

describe('finish review setting', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the review line on unless it was turned off', async () => {
    mockInvoke.mockResolvedValueOnce(basePayload());
    await loadState();
    expect(store.finishReview).toBe(true);
    mockInvoke.mockResolvedValueOnce(basePayload({ finishReview: false }));
    await loadState();
    expect(store.finishReview).toBe(false);
    mockInvoke.mockResolvedValueOnce(basePayload({ finishReview: 'no' }));
    await loadState();
    expect(store.finishReview).toBe(true);
  });

  it('restores the reviewer model and guidance, but not the old agent rating prompt', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({
        reviewModel: { provider: 'codex', model: 'gpt-5', effort: 'high' },
        reviewGuidance: 'Weigh missing tests heavily.',
        confidencePrompt: 'Run my /confidence skill',
      }),
    );
    await loadState();
    expect(store.reviewModel).toEqual({ provider: 'codex', model: 'gpt-5', effort: 'high' });
    expect(store.reviewGuidance).toBe('Weigh missing tests heavily.');
    mockInvoke.mockResolvedValueOnce(
      basePayload({ reviewModel: 'opus', confidencePrompt: 'Run my /confidence skill' }),
    );
    await loadState();
    expect(store.reviewModel).toEqual({ provider: 'claude', model: 'opus' });
    expect(store.reviewGuidance).toBe('');
  });
});

describe('retired Steps settings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ignores legacy Steps fields and does not write them back', async () => {
    mockInvoke.mockResolvedValueOnce(
      JSON.stringify({
        projects: [],
        taskOrder: [],
        collapsedTaskOrder: [],
        tasks: {},
        showSteps: true,
        defaultStepsEnabled: true,
      }),
    );
    await loadState();
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const saveCall = mockInvoke.mock.calls.findLast((call) => typeof call[1]?.json === 'string');
    const saved = JSON.parse(saveCall?.[1].json);
    expect(saved.showSteps).toBeUndefined();
    expect(saved.defaultStepsEnabled).toBeUndefined();
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

describe('feature tips persistence', () => {
  function stateJson(extra: Record<string, unknown>): string {
    return JSON.stringify({
      projects: [],
      taskOrder: [],
      collapsedTaskOrder: [],
      tasks: {},
      ...extra,
    });
  }

  async function lastSaved(): Promise<Record<string, unknown>> {
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const lastCall = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1];
    return JSON.parse(lastCall[1].json) as Record<string, unknown>;
  }

  it('keeps tips off for an install that predates them', async () => {
    mockInvoke.mockResolvedValueOnce(stateJson({}));
    await loadState();
    expect(store.featureHintsEnabled).toBe(false);
    expect(store.seenFeatureHints).toEqual([]);
    // Stored explicitly, so the next load does not mistake it for an older install.
    expect((await lastSaved()).featureHintsEnabled).toBe(false);
  });

  it('round-trips seen tips and drops unknown ones', async () => {
    mockInvoke.mockResolvedValueOnce(
      stateJson({ featureHintsEnabled: true, seenFeatureHints: ['change-tour', 'retired', 3] }),
    );
    await loadState();
    expect(store.featureHintsEnabled).toBe(true);
    expect(store.seenFeatureHints).toEqual(['change-tour']);
    expect((await lastSaved()).seenFeatureHints).toEqual(['change-tour']);
  });

  it('round-trips board ideas and drops malformed ones', async () => {
    const idea = { id: 'i1', text: 'Dark mode', projectId: null, createdAt: 1 };
    mockInvoke.mockResolvedValueOnce(
      stateJson({ taskIdeas: [idea, { id: 'i2' }], lastIdeaProjectId: 'p1' }),
    );
    await loadState();
    expect(store.taskIdeas).toEqual([idea]);
    expect(store.lastIdeaProjectId).toBe('p1');
    const saved = await lastSaved();
    expect(saved.taskIdeas).toEqual([idea]);
    expect(saved.lastIdeaProjectId).toBe('p1');
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

  it('round-trips a reasoning level per provider and drops one the CLI would reject', async () => {
    mockInvoke.mockResolvedValueOnce(
      stateJson({ askCodeEffort: { claude: 'max', codex: 'minimal', minimax: 'high' } }),
    );
    await loadState();
    expect(store.askCodeEffort).toEqual({ claude: 'max', codex: 'minimal' });
    expect((await lastSaved()).askCodeEffort).toEqual({ claude: 'max', codex: 'minimal' });

    mockInvoke.mockResolvedValueOnce(stateJson({ askCodeEffort: { claude: 'minimal' } }));
    await loadState();
    expect(store.askCodeEffort).toEqual({});
    expect((await lastSaved()).askCodeEffort).toBeUndefined();
  });

  it('replaces a model the newly chosen provider cannot run', async () => {
    mockInvoke.mockResolvedValueOnce(stateJson({ askCodeModel: 'opus' }));
    await loadState();

    setAskCodeProvider('codex');
    expect(store.askCodeModel).toBe('');
    setAskCodeProvider('claude');
    expect(store.askCodeModel).toBe('sonnet');
  });

  it('keeps model task naming off unless it was explicitly enabled', async () => {
    mockInvoke.mockResolvedValueOnce(stateJson({ modelTaskNames: 'yes' }));
    await loadState();
    expect(store.modelTaskNames).toBe(false);

    mockInvoke.mockResolvedValueOnce(stateJson({ modelTaskNames: true }));
    await loadState();
    expect(store.modelTaskNames).toBe(true);
    expect((await lastSaved()).modelTaskNames).toBe(true);
  });

  it('remembers hidden plan card details and shows them otherwise', async () => {
    mockInvoke.mockResolvedValueOnce(stateJson({ kanbanHideDetails: 'yes' }));
    await loadState();
    expect(store.kanbanHideDetails).toBe(false);

    mockInvoke.mockResolvedValueOnce(stateJson({ kanbanHideDetails: true }));
    await loadState();
    expect(store.kanbanHideDetails).toBe(true);
    expect((await lastSaved()).kanbanHideDetails).toBe(true);
  });

  it('keeps a chosen naming model and falls back to Haiku for an unknown one', async () => {
    mockInvoke.mockResolvedValueOnce(stateJson({ taskNameModel: 'luna' }));
    await loadState();
    expect(store.taskNameModel).toBe('luna');
    expect((await lastSaved()).taskNameModel).toBe('luna');

    mockInvoke.mockResolvedValueOnce(stateJson({ taskNameModel: 'gpt-4' }));
    await loadState();
    expect(store.taskNameModel).toBe('haiku');
  });

  it('keeps a chosen brief model and otherwise follows what briefs used before', async () => {
    mockInvoke.mockResolvedValueOnce(stateJson({ briefModel: 'terra', taskNameModel: 'luna' }));
    await loadState();
    expect(store.briefModel).toBe('terra');
    expect((await lastSaved()).briefModel).toBe('terra');

    // Before the setting, Codex naming meant Codex briefs and Claude naming meant Sonnet.
    mockInvoke.mockResolvedValueOnce(stateJson({ taskNameModel: 'luna' }));
    await loadState();
    expect(store.briefModel).toBe('luna');

    mockInvoke.mockResolvedValueOnce(stateJson({ briefModel: 'gpt-4', taskNameModel: 'haiku' }));
    await loadState();
    expect(store.briefModel).toBe('sonnet');
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

describe('GitHub page agent persistence', () => {
  it('restores a code project’s GitHub agent in its checkout, outside the task list', async () => {
    const id = 'gh-agent-code';
    const task = {
      ...persistedTask(agentDef()),
      id,
      projectId: 'code',
      worktreePath: '/old/code',
      gitIsolation: 'none',
      agentIds: [id],
    };
    mockInvoke.mockResolvedValueOnce(
      basePayload({
        projects: [{ id: 'code', name: 'Code', path: '/new/code', color: '' }],
        tasks: { [id]: task },
        taskOrder: [],
      }),
    );

    await loadState();

    expect(store.tasks[id]?.worktreePath).toBe('/new/code');
    expect(store.agents[id]?.resumed).toBe(true);
    expect(store.taskOrder).toEqual([]);

    mockInvoke.mockResolvedValue(undefined);
    await saveState();
    const saved = mockInvoke.mock.calls.findLast(([channel]) => channel === IPC.SaveAppState);
    expect(JSON.parse(saved?.[1].json).tasks[id]).toMatchObject({ id, projectId: 'code' });
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

it('registers delegation authority for page agents but not other hidden agents', async () => {
  const hidden = { ...persistedTask(agentDef()), id: 'doc-agent-project-1' };
  const page = { ...persistedTask(agentDef()), id: 'gh-agent-project-1' };
  const normal = { ...persistedTask(agentDef()), id: 'normal-authority' };
  mockInvoke.mockResolvedValueOnce(
    JSON.stringify({
      projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: '' }],
      taskOrder: [hidden.id, page.id, normal.id],
      collapsedTaskOrder: [],
      tasks: { [hidden.id]: hidden, [page.id]: page, [normal.id]: normal },
    }),
  );
  await loadState();
  const registered = mockInvoke.mock.calls
    .filter(([channel, args]) => channel === IPC.DelegationRequest && args?.action === 'register')
    .map(([, args]) => args.task.taskId);
  expect(registered).not.toContain(hidden.id);
  expect(registered).toContain(page.id);
  expect(registered).toContain(normal.id);
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
    await saveState();
    expect(mockInvoke.mock.calls.some(([channel]) => channel === IPC.SaveAppState)).toBe(false);
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

describe('daily merge count persistence', () => {
  it('round-trips counted PRs and discards them with an old daily count', async () => {
    mockInvoke.mockResolvedValueOnce(
      basePayload({
        completedTaskDate: getLocalDateKey(),
        completedTaskCount: 2,
        countedMergedPrs: ['github.com/acme/app/12', 123],
      }),
    );
    await loadState();
    expect(store.completedTaskCount).toBe(2);
    expect(store.countedMergedPrs).toEqual(['github.com/acme/app/12']);
    await saveState();
    const saved = mockInvoke.mock.calls.findLast(([channel]) => channel === IPC.SaveAppState);
    expect(JSON.parse(saved?.[1].json).countedMergedPrs).toEqual(['github.com/acme/app/12']);

    mockInvoke.mockResolvedValueOnce(
      basePayload({
        completedTaskDate: '2000-01-01',
        completedTaskCount: 2,
        countedMergedPrs: ['github.com/acme/app/12'],
      }),
    );
    await loadState();
    expect(store.completedTaskCount).toBe(0);
    expect(store.countedMergedPrs).toEqual([]);
  });
});

describe('timed snooze persistence', () => {
  function savedSnooze(snoozedUntil: unknown): string {
    return JSON.stringify({
      projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)' }],
      taskOrder: ['task-1'],
      tasks: {
        'task-1': {
          ...persistedTask(agentDef()),
          agentIds: ['agent-1'],
          agentSessionIds: { 'agent-1': 'fb4f2bc6-62d9-4b29-a795-240caf2fc459' },
          snoozedUntil,
        },
      },
      activeTaskId: null,
    });
  }

  it.each([-60_000, 3_600_000])(
    'round-trips an overdue or future deadline (%s)',
    async (offset) => {
      const deadline = Date.now() + offset;
      mockInvoke.mockResolvedValueOnce(savedSnooze(deadline));
      await loadState();
      expect(store.tasks['task-1'].snoozedUntil).toBe(deadline);
      expect(store.tasks['task-1'].agentSessionIds).toEqual({
        'agent-1': 'fb4f2bc6-62d9-4b29-a795-240caf2fc459',
      });
      expect(store.agents['agent-1'].resumed).toBe(true);
      await saveState();
      const savedCall = mockInvoke.mock.calls.findLast(([channel]) => channel === IPC.SaveAppState);
      const saved = JSON.parse(savedCall?.[1].json);
      expect(saved.tasks['task-1'].snoozedUntil).toBe(deadline);

      mockInvoke.mockResolvedValueOnce(JSON.stringify(saved));
      await loadState();
      expect(store.tasks['task-1'].snoozedUntil).toBe(deadline);
    },
  );

  it('round-trips a stopped snooze without starting agents before its deadline', async () => {
    const deadline = Date.now() + 3_600_000;
    const state = JSON.parse(savedSnooze(deadline));
    state.taskOrder = [];
    state.collapsedTaskOrder = ['task-1'];
    state.tasks['task-1'].collapsed = true;
    state.tasks['task-1'].savedAgentSessionIds = ['fb4f2bc6-62d9-4b29-a795-240caf2fc459'];
    mockInvoke.mockResolvedValueOnce(JSON.stringify(state));
    await loadState();
    expect(store.tasks['task-1'].collapsed).toBe(true);
    expect(store.tasks['task-1'].snoozedUntil).toBe(deadline);
    expect(store.tasks['task-1'].agentIds).toEqual([]);
    expect(store.tasks['task-1'].savedAgentDefs).toHaveLength(1);
    await saveState();
    const savedCall = mockInvoke.mock.calls.findLast(([channel]) => channel === IPC.SaveAppState);
    const saved = JSON.parse(savedCall?.[1].json);
    expect(saved.tasks['task-1'].snoozedUntil).toBe(deadline);
    expect(saved.tasks['task-1'].savedAgentSessionIds).toEqual([
      'fb4f2bc6-62d9-4b29-a795-240caf2fc459',
    ]);
    mockInvoke.mockResolvedValueOnce(JSON.stringify(saved));
    await loadState();
    expect(store.tasks['task-1'].snoozedUntil).toBe(deadline);
    expect(store.tasks['task-1'].agentIds).toEqual([]);
  });

  it.each([
    [true, true],
    ['yes', undefined],
  ])('round-trips a CI snooze flag (%s)', async (value, expected) => {
    const state = JSON.parse(savedSnooze(undefined));
    state.tasks['task-1'].snoozedUntilCi = value;
    mockInvoke.mockResolvedValueOnce(JSON.stringify(state));
    await loadState();
    expect(store.tasks['task-1'].snoozedUntilCi).toBe(expected);
    await saveState();
    const savedCall = mockInvoke.mock.calls.findLast(([channel]) => channel === IPC.SaveAppState);
    expect(JSON.parse(savedCall?.[1].json).tasks['task-1'].snoozedUntilCi).toBe(expected);
  });

  it.each([null, 'tomorrow', -1, 0, 1e20])('ignores invalid saved deadlines: %s', async (value) => {
    mockInvoke.mockResolvedValueOnce(savedSnooze(value));
    await loadState();
    expect(store.tasks['task-1'].snoozedUntil).toBeUndefined();
  });
});

describe('board layout persistence', () => {
  function stateWith(extra: Record<string, unknown>): string {
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

  it('round-trips the side panel side', async () => {
    mockInvoke.mockResolvedValueOnce(stateWith({ boardSidePanelLeft: true }));
    await loadState();
    expect(store.boardSidePanelLeft).toBe(true);

    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const saved = JSON.parse(mockInvoke.mock.calls.at(-1)?.[1].json);
    expect(saved.boardSidePanelLeft).toBe(true);
  });

  it('defaults the side panel side for older state', async () => {
    mockInvoke.mockResolvedValueOnce(stateWith({}));
    await loadState();
    expect(store.boardSidePanelLeft).toBe(false);
  });
});

describe('project agent env persistence', () => {
  function stateWith(project: Record<string, unknown>): string {
    return JSON.stringify({
      projects: [
        { id: 'project-1', name: 'Repo', path: '/repo', color: 'hsl(0, 70%, 75%)', ...project },
      ],
      lastProjectId: 'project-1',
      lastAgentId: null,
      taskOrder: ['task-1'],
      collapsedTaskOrder: [],
      tasks: { 'task-1': persistedTask(agentDef()) },
      activeTaskId: 'task-1',
      sidebarVisible: true,
    });
  }

  async function savedProject(): Promise<Record<string, unknown>> {
    mockInvoke.mockResolvedValueOnce(undefined);
    await saveState();
    const saved = mockInvoke.mock.calls.findLast(([channel]) => channel === IPC.SaveAppState);
    return JSON.parse(saved?.[1].json).projects[0];
  }

  it('loads older state without the field unchanged and pushes an empty env', async () => {
    mockInvoke.mockResolvedValueOnce(stateWith({}));
    await loadState();
    expect(store.projects[0].agentEnv).toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledWith(IPC.SetProjectAgentEnv, {
      projectId: 'project-1',
      env: {},
    });
    expect(await savedProject()).not.toHaveProperty('agentEnv');
  });

  it('round-trips the env and drops invalid entries', async () => {
    mockInvoke.mockResolvedValueOnce(
      stateWith({ agentEnv: { CLAUDE_CONFIG_DIR: '~/.claude-work', 'BAD-KEY': 'x', NUM: 1 } }),
    );
    await loadState();
    expect(store.projects[0].agentEnv).toEqual({ CLAUDE_CONFIG_DIR: '~/.claude-work' });
    expect((await savedProject()).agentEnv).toEqual({ CLAUDE_CONFIG_DIR: '~/.claude-work' });
  });

  it('hands the env to the main process before tasks restore', async () => {
    // setStore('tasks', {}) merges, so the shared reset leaves earlier tests' tasks behind.
    setStore(
      produce((s) => {
        s.tasks = {};
      }),
    );
    let tasksAtPush = -1;
    mockInvoke.mockImplementation(async (channel) => {
      if (channel === IPC.LoadAppState) return stateWith({ agentEnv: { A: '1' } });
      if (channel === IPC.SetProjectAgentEnv) tasksAtPush = Object.keys(store.tasks).length;
    });
    await loadState();
    expect(tasksAtPush).toBe(0);
    expect(store.tasks['task-1']).toBeDefined();
    expect(mockInvoke).toHaveBeenCalledWith(IPC.SetProjectAgentEnv, {
      projectId: 'project-1',
      env: { A: '1' },
    });
  });
});
