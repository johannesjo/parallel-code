import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));

beforeEach(() => {
  vi.resetModules();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
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

  it('keeps saves disabled if loading the saved state fails', async () => {
    const { loadState, saveState } = await import('./persistence');
    mockInvoke.mockRejectedValueOnce(new Error('State unavailable'));

    await expect(loadState()).rejects.toThrow('State unavailable');
    await saveState();

    expect(mockInvoke.mock.calls.some(([channel]) => channel === IPC.SaveAppState)).toBe(false);
  });
});
