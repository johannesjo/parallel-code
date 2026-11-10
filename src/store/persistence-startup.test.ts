import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));

beforeEach(() => {
  vi.resetModules();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

const claudeDef = {
  id: 'claude',
  name: 'Claude Code',
  command: 'claude',
  args: [],
  resume_args: ['--continue'],
  skip_permissions_args: [],
  description: '',
};

function savedTask(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    projectId: 'project-1',
    branchName: `task/${id}`,
    worktreePath: `/repo/.worktrees/${id}`,
    notes: '',
    lastPrompt: '',
    shellCount: 0,
    gitIsolation: 'worktree',
    agentDef: claudeDef,
    agentIds: [`${id}-agent`],
    ...extra,
  };
}

/** Opens the app on a saved workspace of the given tasks. */
async function launch(options: {
  tasks: Record<string, unknown>[];
  state?: Record<string, unknown>;
  /** What the main process answers when asked which agents still have a process. */
  liveAgentIds?: string[] | Error;
}) {
  const ids = options.tasks.map((task) => String(task.id));
  const persisted = JSON.stringify({
    projects: [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'blue' }],
    tasks: Object.fromEntries(options.tasks.map((task) => [task.id, task])),
    taskOrder: ids,
    collapsedTaskOrder: [],
    activeTaskId: null,
    ...options.state,
  });
  mockInvoke.mockImplementation(async (channel) => {
    if (channel === IPC.LoadAppState) return persisted;
    if (channel === IPC.ListRunningAgentIds) {
      if (options.liveAgentIds instanceof Error) throw options.liveAgentIds;
      return options.liveAgentIds ?? [];
    }
    return undefined;
  });
  const { loadState } = await import('./persistence');
  await loadState();
  const { store } = await import('./core');
  const { getTaskAttentionState } = await import('./taskStatus');
  const { isAgentSuspended } = await import('./agent-suspend');
  return {
    agent: (taskId: string) => store.agents[`${taskId}-agent`],
    suspended: (taskId: string) => isAgentSuspended(store.agents[`${taskId}-agent`]),
    attention: getTaskAttentionState,
  };
}

describe('resuming agents on launch', () => {
  it('leaves agents suspended when the setting is off', async () => {
    const app = await launch({
      tasks: [savedTask('one'), savedTask('two')],
      state: { resumeAgentsOnLaunch: false },
    });

    for (const id of ['one', 'two']) {
      expect(app.agent(id)).toMatchObject({
        status: 'exited',
        signal: 'suspended',
        exitCode: null,
      });
      expect(app.suspended(id)).toBe(true);
      // Resume continues the conversation, as launch would have.
      expect(app.agent(id)?.resumed).toBe(true);
      // Neither working, as a started agent is, nor failed.
      expect(app.attention(id)).toBe('idle');
    }
  }, 20_000);

  it('starts every agent when the setting is on, as it is for a state file without the key', async () => {
    const app = await launch({ tasks: [savedTask('one'), savedTask('two')] });

    for (const id of ['one', 'two']) {
      expect(app.agent(id)).toMatchObject({ status: 'running', signal: null, resumed: true });
      expect(app.attention(id)).toBe('active');
    }
  }, 20_000);

  it('reattaches an agent whose process is still alive instead of suspending it', async () => {
    const app = await launch({
      tasks: [savedTask('alive'), savedTask('stopped')],
      state: { resumeAgentsOnLaunch: false },
      liveAgentIds: ['alive-agent'],
    });

    expect(app.agent('alive')).toMatchObject({ status: 'running', attachExisting: true });
    expect(app.attention('alive')).toBe('active');
    expect(app.suspended('stopped')).toBe(true);
  }, 20_000);

  it('starts every agent when it cannot tell which are still alive', async () => {
    const app = await launch({
      tasks: [savedTask('one'), savedTask('two')],
      state: { resumeAgentsOnLaunch: false },
      liveAgentIds: new Error('main process unavailable'),
    });

    for (const id of ['one', 'two']) {
      expect(app.agent(id)).toMatchObject({ status: 'running', signal: null });
    }
  }, 20_000);

  it('still starts a coordinator and its sub-tasks', async () => {
    const app = await launch({
      tasks: [
        savedTask('lead', { coordinatorMode: true }),
        savedTask('child', { coordinatedBy: 'lead' }),
        savedTask('plain'),
      ],
      state: { resumeAgentsOnLaunch: false },
    });

    expect(app.agent('lead')?.status).toBe('running');
    expect(app.agent('child')?.status).toBe('running');
    expect(app.suspended('plain')).toBe(true);
  }, 20_000);

  it('still starts the task that was open when the app closed', async () => {
    const app = await launch({
      tasks: [savedTask('one'), savedTask('open'), savedTask('three')],
      state: { resumeAgentsOnLaunch: false, activeTaskId: 'open' },
    });

    expect(app.agent('open')).toMatchObject({ status: 'running', signal: null });
    expect(app.suspended('one')).toBe(true);
    expect(app.suspended('three')).toBe(true);
  }, 20_000);

  // Focus mode shows one task; with nothing saved as open, launch opens the first.
  it.each([null, 'closed-long-ago'])(
    'starts the task that focus mode opens when the saved one is %s',
    async (activeTaskId) => {
      const app = await launch({
        tasks: [savedTask('first'), savedTask('second')],
        state: { resumeAgentsOnLaunch: false, focusMode: true, activeTaskId },
      });

      expect(app.agent('first')).toMatchObject({ status: 'running', signal: null });
      expect(app.attention('first')).toBe('active');
      expect(app.suspended('second')).toBe(true);
    },
    20_000,
  );

  it('starts every agent when the reply about live ones is not a list', async () => {
    const app = await launch({
      tasks: [savedTask('one')],
      state: { resumeAgentsOnLaunch: false },
      liveAgentIds: 'one-agent' as unknown as string[],
    });

    expect(app.agent('one')).toMatchObject({ status: 'running', signal: null });
  }, 20_000);

  it("leaves a document workspace's agent to start when its pane opens", async () => {
    const { documentAgentTaskId } = await import('../documents/task-id');
    const id = documentAgentTaskId('docs');
    const app = await launch({
      tasks: [],
      state: {
        resumeAgentsOnLaunch: false,
        projects: [{ id: 'docs', name: 'Docs', path: '/docs', color: '', kind: 'document' }],
        tasks: {
          [id]: savedTask(id, {
            projectId: 'docs',
            gitIsolation: 'none',
            agentIds: [`${id}-agent`],
          }),
        },
      },
    });

    expect(app.agent(id)).toMatchObject({ status: 'running', signal: null });
  }, 20_000);
});

describe('startup persistence', () => {
  // The first test imports the whole store graph cold after resetModules, which can take longer
  // than the default 5s on a loaded machine.
  it('preserves the saved workspace when the banner is dismissed before state loading starts', async () => {
    const { loadAgents } = await import('./agents');
    const { loadState, saveState } = await import('./persistence');
    const { dismissMigrationBanner } = await import('./keybindings');
    const { store } = await import('./core');
    const projects = [{ id: 'project-1', name: 'Repo', path: '/repo', color: 'blue' }];
    const tasks = {
      'task-1': {
        id: 'task-1',
        name: 'Saved task',
        projectId: 'project-1',
        branchName: 'task/saved',
        worktreePath: '/repo/.worktrees/saved',
        notes: 'Keep these notes',
        shellCount: 0,
        lastPrompt: '',
        gitIsolation: 'worktree',
      },
    };
    let persisted = JSON.stringify({
      projects,
      tasks,
      taskOrder: ['task-1'],
      collapsedTaskOrder: [],
      keybindingMigrationDismissed: false,
    });
    let resolveLogin: () => void = () => undefined;
    const loginReady = new Promise<void>((resolve) => (resolveLogin = resolve));
    mockInvoke.mockImplementation(async (channel, args) => {
      // Model the main-process gate while App awaits loadAgents before loadState.
      await loginReady;
      if (channel === IPC.ListAgents) return [];
      if (channel === IPC.LoadAppState) return persisted;
      if (channel === IPC.SaveAppState) persisted = args.json;
    });

    const startup = (async () => {
      await loadAgents();
      await loadState();
    })();
    dismissMigrationBanner();
    expect(mockInvoke.mock.calls.some(([channel]) => channel === IPC.SaveAppState)).toBe(false);
    resolveLogin();
    await startup;

    expect(JSON.parse(persisted)).toMatchObject({ projects, tasks });
    expect(store.projects).toMatchObject(projects);
    expect(store.tasks['task-1'].notes).toBe('Keep these notes');

    // Once restored, the same action saves the complete workspace normally.
    dismissMigrationBanner();
    await saveState();
    expect(JSON.parse(persisted)).toMatchObject({
      projects,
      tasks,
      keybindingMigrationDismissed: true,
    });
  }, 20_000);

  it('starts a new install with feature tips on and no shortcut migration notice', async () => {
    const { loadState, saveState } = await import('./persistence');
    const { store } = await import('./core');
    mockInvoke.mockResolvedValue(null);
    await loadState();
    expect(store.featureHintsEnabled).toBe(true);
    expect(store.keybindingMigrationDismissed).toBe(true);
    expect(store.boardView).toBe(true);

    await saveState();
    const saved = mockInvoke.mock.calls.find(([channel]) => channel === IPC.SaveAppState);
    expect(JSON.parse(saved?.[1].json)).toMatchObject({
      featureHintsEnabled: true,
      keybindingMigrationDismissed: true,
    });
  }, 20_000);

  it('allows a first-run save only after the empty state has been loaded', async () => {
    const { loadState, saveState } = await import('./persistence');
    let finishLoad: (state: null) => void = () => undefined;
    mockInvoke.mockReturnValueOnce(new Promise<null>((resolve) => (finishLoad = resolve)));

    const loading = loadState();
    await saveState();
    expect(mockInvoke.mock.calls.some(([channel]) => channel === IPC.SaveAppState)).toBe(false);
    finishLoad(null);
    await loading;
    await saveState();

    expect(mockInvoke).toHaveBeenCalledWith(IPC.SaveAppState, { json: expect.any(String) });
  });

  it('tells an unreadable saved state apart from a new install', async () => {
    const { isStateLoaded, loadState } = await import('./persistence');
    mockInvoke.mockResolvedValueOnce('{not json');
    await loadState();
    expect(isStateLoaded()).toBe(false);

    mockInvoke.mockResolvedValueOnce(null);
    await loadState();
    expect(isStateLoaded()).toBe(true);
  }, 20_000);

  it('keeps saves disabled if loading the saved state fails', async () => {
    const { loadState, saveState } = await import('./persistence');
    mockInvoke.mockRejectedValueOnce(new Error('State unavailable'));

    await expect(loadState()).rejects.toThrow('State unavailable');
    await saveState();

    expect(mockInvoke.mock.calls.some(([channel]) => channel === IPC.SaveAppState)).toBe(false);
  });
});
