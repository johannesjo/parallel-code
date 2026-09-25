import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setupCoordinatorHarness,
  resetCoordinatorMocks,
  mockNotify,
  mockCreateBackendTask,
  mockSpawnAgent,
  mockExecFile,
  mockGitMergeTask,
  mockNotifyRenderer,
  mockAtomicWriteFile,
  mockAtomicWriteFileSync,
  mockDeleteBackendTask,
  mockNextTask,
  mockWriteToAgent,
  mockKillAgent,
  mockGetActiveAgentIds,
  mockGetAgentMeta,
  getOutputCb,
  getSpawnHandler,
  getExitHandler,
} from './coordinator-test-harness.js';

const { Coordinator } = await setupCoordinatorHarness();
const sha = 'a'.repeat(40);
const targetSha = 'b'.repeat(40);
let coordinator: InstanceType<typeof Coordinator>;

function gitResults(dirty = '') {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      args: string[],
      opts: { cwd: string },
      cb: (err: Error | null, out: string, stderr: string) => void,
    ) => {
      const output = args.includes('--abbrev-ref')
        ? 'parent'
        : args[0] === 'status'
          ? dirty
          : opts.cwd === '/parent'
            ? targetSha
            : sha;
      cb(null, output, '');
    },
  );
}
function create(extra: Partial<Parameters<typeof coordinator.createTask>[0]> = {}) {
  return coordinator.createTask({
    name: 'Child',
    prompt: 'Implement the assignment',
    coordinatorTaskId: 'parent',
    integrationPolicy: 'review',
    ...extra,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetCoordinatorMocks();
  coordinator = new Coordinator();
  coordinator.setNotify(mockNotify);
  coordinator.registerCoordinator('parent', 'project', {
    projectRoot: '/project',
    branchName: 'parent',
    worktreePath: '/parent',
    spawnDefaults: { command: 'codex', args: [] },
    agentEnvFile: '/agent.env',
    automaticNotifications: false,
    maxConcurrentTasks: 1,
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('ordinary delegation lifecycle', () => {
  it('distinguishes ordinary parents from legacy coordinator transport ownership', () => {
    expect(coordinator.hasActiveCoordinator()).toBe(true);
    expect(coordinator.hasActiveLegacyCoordinator()).toBe(false);
    coordinator.registerCoordinator('legacy', 'project');
    expect(coordinator.hasActiveLegacyCoordinator()).toBe(true);
    coordinator.deregisterCoordinator('legacy');
    expect(coordinator.hasActiveLegacyCoordinator()).toBe(false);
  });

  it('uses explicit launch context without mutable coordinator defaults', async () => {
    await create();
    expect(mockCreateBackendTask).toHaveBeenCalledWith(
      'Child',
      '/project',
      expect.any(Array),
      'task',
      'parent',
    );
    expect(mockSpawnAgent).toHaveBeenCalledWith(
      mockNotify,
      expect.objectContaining({ command: 'codex', envFile: '/agent.env' }),
      expect.any(Function),
    );
    expect(
      mockAtomicWriteFile.mock.calls.some(
        (call) =>
          String(call[1]).includes('signal_done') && String(call[1]).includes('user reviews'),
      ),
    ).toBe(true);
    expect(coordinator.getTaskStatus('task-1')?.integrationPolicy).toBe('review');
  });

  it('uses per-assignment launch options without mutating the parent defaults', async () => {
    await create({ agentEnvFile: '/selected.env', skipPermissions: true });
    expect(mockSpawnAgent).toHaveBeenLastCalledWith(
      mockNotify,
      expect.objectContaining({
        envFile: '/selected.env',
        args: expect.arrayContaining(['--dangerously-bypass-approvals-and-sandbox']),
      }),
      expect.any(Function),
    );
    coordinator.removeCoordinatedTask('task-1');
    await create();
    expect(mockSpawnAgent).toHaveBeenLastCalledWith(
      mockNotify,
      expect.objectContaining({ envFile: '/agent.env', args: [] }),
      expect.any(Function),
    );
  });

  it('keeps the integration branch separate from the selected creation commit', async () => {
    gitResults();
    const task = await create({ snapshotCommit: targetSha });
    expect(task.baseBranch).toBe('parent');
    expect(mockCreateBackendTask).toHaveBeenCalledWith(
      'Child',
      '/project',
      expect.any(Array),
      'task',
      'parent',
      targetSha,
    );
    await expect(create({ snapshotCommit: sha })).rejects.toThrow('concurrency');
  });

  it('rejects a moved snapshot before any filesystem creation', async () => {
    gitResults();
    await expect(create({ snapshotCommit: sha })).rejects.toThrow('Refresh');
    expect(mockCreateBackendTask).not.toHaveBeenCalled();
  });

  it('rechecks authorization immediately before spawning and cleans up canceled setup', async () => {
    const guard = vi.fn().mockResolvedValue(undefined);
    // Initial admission, before filesystem, before spawn.
    guard
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('Consent revoked');
      });
    await expect(create({ launchGuard: guard })).rejects.toThrow('Consent revoked');
    await Promise.resolve();
    expect(mockSpawnAgent).not.toHaveBeenCalled();
    expect(mockDeleteBackendTask).toHaveBeenCalled();
  });

  it.each(['pause', 'consent'] as const)(
    'rechecks %s at the native launch boundary after asynchronous PTY setup',
    async (change) => {
      let consent = true;
      mockSpawnAgent.mockImplementationOnce(
        async (_window: unknown, _args: unknown, beforeSpawn: () => void) => {
          if (change === 'pause') {
            coordinator.stopChildren('parent');
            coordinator.resumeChildren('parent');
          } else consent = false;
          beforeSpawn();
        },
      );
      await expect(
        create({
          nativeLaunchGuard: () => {
            if (!consent) throw new Error('Consent revoked');
          },
        }),
      ).rejects.toThrow(change === 'pause' ? 'canceled' : 'Consent revoked');
    },
  );

  it('invalidates reserved launches across stop and resume and blocks unsafe detach', async () => {
    let finish:
      | ((value: { id: string; branch_name: string; worktree_path: string }) => void)
      | undefined;
    mockCreateBackendTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = create();
    const assertion = expect(pending).rejects.toThrow('canceled');
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(() => coordinator.detachChildren('parent')).toThrow('settling');
    coordinator.stopChildren('parent');
    coordinator.resumeChildren('parent');
    finish?.({ id: 'task-1', branch_name: 'task/test', worktree_path: '/tmp/test' });
    await assertion;
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('enforces capacity on exited child restarts and pause on all replacements', async () => {
    const child = await create();
    getExitHandler()(child.agentId, { exitCode: 0 });
    mockNextTask({ id: 'task-2' });
    await create();
    expect(() => coordinator.reserveChildRestart(child.id)).toThrow('concurrency');
    coordinator.stopChildren('parent');
    expect(() => coordinator.reserveChildRestart('task-2')).toThrow('paused');
  });

  it('invalidates a restart reservation when stop and resume occur during setup', async () => {
    const child = await create();
    getExitHandler()(child.agentId, { exitCode: 0 });
    const reservation = coordinator.reserveChildRestart(child.id);
    reservation.assertAllowed();
    coordinator.stopChildren('parent');
    coordinator.resumeChildren('parent');
    expect(() => reservation.assertAllowed()).toThrow('canceled');
    reservation();
    reservation();
    const retry = coordinator.reserveChildRestart(child.id);
    retry.assertAllowed();
    retry();
  });

  it('keeps a child slot occupied while a secondary pane survives its primary', async () => {
    const child = await create();
    getExitHandler()(child.agentId, { exitCode: 0 });
    mockGetActiveAgentIds.mockReturnValue(['secondary']);
    mockGetAgentMeta.mockReturnValue({ taskId: child.id });
    mockNextTask({ id: 'task-2' });

    await expect(create()).rejects.toThrow('concurrency');
    // Restarting this same child replaces its existing slot, even at the limit.
    const reservation = coordinator.reserveChildRestart(child.id);
    reservation.assertAllowed();
    reservation();

    mockGetActiveAgentIds.mockReturnValue([]);
    await expect(create()).resolves.toMatchObject({ id: 'task-2' });
  });

  it('keeps unexpected child exits visible even with an active waiter', async () => {
    const child = await create();
    coordinator.markPromptDelivered(child.id);
    const waiting = coordinator.waitForSignalDone('parent');
    getExitHandler()(child.agentId, { exitCode: 1 });
    await expect(waiting).resolves.toMatchObject({ taskId: child.id, status: 'exited' });
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.objectContaining({ automaticNotifications: false }),
    );
  });

  it('detaches children without deleting their worktrees', async () => {
    const child = await create();
    expect(coordinator.detachChildren('parent')).toEqual([child.id]);
    expect(coordinator.getTaskStatus(child.id)).toBeNull();
    expect(mockDeleteBackendTask).not.toHaveBeenCalled();
    await expect(create()).rejects.toThrow('Unknown coordinator');
  });

  it('preserves visible review notifications while the ordinary agent consumes completion', async () => {
    const child = await create();
    const waiting = coordinator.waitForSignalDone('parent');
    coordinator.signalDone(child.id);
    await expect(waiting).resolves.toMatchObject({ taskId: child.id });
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_coordinator_notification_staged',
      expect.objectContaining({ automaticNotifications: false }),
    );
    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_notification_cleared',
      expect.anything(),
    );
    await expect(coordinator.waitForSignalDone('parent')).resolves.toEqual({ remaining: 0 });
  });

  it('automatic delivery never authorizes merging a review-policy child', async () => {
    coordinator.registerCoordinator('updates', 'project', {
      projectRoot: '/project',
      worktreePath: '/parent',
      automaticNotifications: true,
    });
    const child = await create({ coordinatorTaskId: 'updates' });
    coordinator.signalDone(child.id);
    const staged = mockNotifyRenderer.mock.calls.find(
      ([channel]) => channel === 'mcp_coordinator_notification_staged',
    );
    expect(staged?.[1]).toMatchObject({
      automaticNotifications: true,
      text: expect.stringContaining('require explicit user review and approval'),
    });
    expect(staged?.[1].text).not.toContain("commit and merge what's ready");
  });

  it('uses bound child credentials for creation and subsequent config refresh', async () => {
    coordinator.setSessionMcpProvider(() => ({
      token: 'bound-token',
      sessionCapabilities: { profile: 'child-review', canCreate: false, peers: true },
    }));
    coordinator.setMCPServerInfo(
      'parent',
      'http://localhost:1',
      'legacy-parent',
      'legacy-child',
      '/server.cjs',
    );
    await create();
    expect(
      mockAtomicWriteFile.mock.calls.some(
        (call) =>
          String(call[1]).includes('bound-token') && String(call[1]).includes('child-review'),
      ),
    ).toBe(true);
    coordinator.setMCPServerInfo(
      'parent',
      'http://localhost:2',
      'legacy-parent',
      'new-legacy',
      '/server.cjs',
    );
    expect(
      mockAtomicWriteFileSync.mock.calls.some((call) => String(call[1]).includes('bound-token')),
    ).toBe(true);
    coordinator.setSessionMcpProvider(() => ({
      token: 'replacement-token',
      sessionCapabilities: { profile: 'child-review', canCreate: false, peers: true },
    }));
    const launch = coordinator.refreshSessionMcp('task-1', 'codex');
    expect(launch.mcpLaunchArgs?.join(' ')).toContain('--token-file');
    expect(launch.mcpLaunchArgs?.join(' ')).not.toContain('replacement-token');
    expect(launch.mcpLaunchArgs?.join(' ')).not.toContain('PARALLEL_CODE_MCP_DONE_TOKEN');
    expect(JSON.stringify(mockNotifyRenderer.mock.calls)).not.toContain('bound-token');
  });
});

describe('review-required integration', () => {
  it('rejects all agent-accessible integration methods', async () => {
    const child = await create();
    coordinator.signalDone(child.id);
    await expect(coordinator.landSelf(child.id, { verification: { checks: [] } })).rejects.toThrow(
      'user review',
    );
    await expect(coordinator.mergeTask(child.id)).rejects.toThrow('user approval');
    await expect(coordinator.reviewAndMergeTask(child.id)).rejects.toThrow('user approval');
    expect(mockGitMergeTask).not.toHaveBeenCalled();
  });

  it('never autocommits a dirty child when the user approves', async () => {
    const child = await create();
    coordinator.signalDone(child.id);
    gitResults(' M code.ts');
    await expect(
      coordinator.approveAndMergeTask(child.id, {
        expectedCommit: sha,
        expectedTargetBranch: 'parent',
        expectedTargetCommit: targetSha,
      }),
    ).rejects.toThrow('uncommitted');
    expect(
      mockExecFile.mock.calls.some((call) => call[1][0] === 'add' || call[1][0] === 'commit'),
    ).toBe(false);
    expect(mockGitMergeTask).not.toHaveBeenCalled();
  });

  it('passes exact review commits into the locked merge and rejects simultaneous detach', async () => {
    const child = await create();
    coordinator.signalDone(child.id);
    gitResults();
    const approval = {
      expectedCommit: sha,
      expectedTargetBranch: 'parent',
      expectedTargetCommit: targetSha,
    };
    const pending = coordinator.approveAndMergeTask(child.id, approval);
    expect(() => coordinator.detachChildren('parent')).toThrow('integrated');
    await pending;
    expect(mockGitMergeTask).toHaveBeenCalledWith(
      '/project',
      'task/test',
      false,
      null,
      false,
      'parent',
      '/tmp/test',
      '/parent',
      approval,
    );
    expect(
      mockExecFile.mock.calls.some((call) => call[1][0] === 'add' || call[1][0] === 'commit'),
    ).toBe(false);
    expect(coordinator.getTaskStatus(child.id)?.landingState).toBe('reviewed');
  });
});

describe('global agent orchestration switch', () => {
  it('blocks agent mutations without killing an existing child or deleting its work', async () => {
    const child = await create();
    coordinator.setOrchestrationEnabled(false);
    await expect(create()).rejects.toThrow('orchestration is disabled');
    await expect(coordinator.sendPrompt(child.id, 'More work')).rejects.toThrow(
      'orchestration is disabled',
    );
    await expect(coordinator.mergeTask(child.id)).rejects.toThrow('orchestration is disabled');
    await expect(coordinator.landSelf(child.id, { verification: { checks: [] } })).rejects.toThrow(
      'orchestration is disabled',
    );
    await expect(coordinator.closeTask(child.id)).rejects.toThrow('orchestration is disabled');
    expect(mockKillAgent).not.toHaveBeenCalled();
    expect(mockDeleteBackendTask).not.toHaveBeenCalled();
    expect(coordinator.getTaskStatus(child.id)).not.toBeNull();
    expect(coordinator.signalDone(child.id)).toBe(true);
  });

  it('cancels a pending launch even if orchestration is re-enabled before setup finishes', async () => {
    let finish:
      | ((value: { id: string; branch_name: string; worktree_path: string }) => void)
      | undefined;
    mockCreateBackendTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = create();
    const assertion = expect(pending).rejects.toThrow('canceled');
    await vi.waitFor(() => expect(finish).toBeDefined());
    coordinator.setOrchestrationEnabled(false);
    coordinator.setOrchestrationEnabled(true);
    finish?.({ id: 'task-1', branch_name: 'task/test', worktree_path: '/tmp/test' });
    await assertion;
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  it('discards queued prompts and startup timers without replaying them after re-enable', async () => {
    const child = await create();
    await expect(coordinator.sendPrompt(child.id, 'Queued follow-up')).resolves.toEqual({
      queued: true,
    });
    getOutputCb()(Buffer.from('› ').toString('base64'));
    coordinator.setOrchestrationEnabled(false);
    coordinator.setOrchestrationEnabled(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockWriteToAgent).not.toHaveBeenCalled();
    expect(coordinator.getTaskStatus(child.id)?.pendingPromptCount).toBeUndefined();
    expect(mockKillAgent).not.toHaveBeenCalled();
  });

  it('discards restored prompts while disabled rather than replaying them after enable', async () => {
    coordinator.setOrchestrationEnabled(false);
    const restored = {
      id: 'restored-child',
      name: 'Restored',
      projectId: 'project',
      projectRoot: '/project',
      branchName: 'task/restored',
      baseBranch: 'parent',
      worktreePath: '/tmp/restored',
      agentId: 'restored-agent',
      coordinatorTaskId: 'parent',
      initialPrompt: 'Old assignment',
      pendingPrompts: ['Old follow-up'],
      assignedPromptDelivered: false,
    };
    coordinator.hydrateTask(restored);
    expect(coordinator.getTask(restored.id)?.initialPrompt).toBeUndefined();
    expect(coordinator.getTask(restored.id)?.pendingPrompts).toBeUndefined();
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_state_sync',
      expect.objectContaining({ taskId: restored.id, initialPrompt: null, pendingPromptCount: 0 }),
    );
    // A stale renderer retry must also receive the cleared queue state.
    mockNotifyRenderer.mockClear();
    coordinator.hydrateTask(restored);
    expect(mockNotifyRenderer).toHaveBeenCalledWith(
      'mcp_task_state_sync',
      expect.objectContaining({ taskId: restored.id, initialPrompt: null, pendingPromptCount: 0 }),
    );
    coordinator.setOrchestrationEnabled(true);
    getSpawnHandler()(restored.agentId);
    getOutputCb()(Buffer.from('› ').toString('base64'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockWriteToAgent).not.toHaveBeenCalled();
    expect(mockKillAgent).not.toHaveBeenCalled();
  });

  it('does not send Enter or replay a body pasted before disable/re-enable', async () => {
    const child = await create();
    coordinator.markPromptDelivered(child.id);
    const sending = coordinator.sendPrompt(child.id, 'Already pasted');
    const assertion = expect(sending).rejects.toThrow('Enter write failed');
    expect(mockWriteToAgent).toHaveBeenCalledWith(child.agentId, 'Already pasted');
    coordinator.setOrchestrationEnabled(false);
    coordinator.setOrchestrationEnabled(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(mockWriteToAgent).not.toHaveBeenCalledWith(child.agentId, '\r');
    expect(mockWriteToAgent.mock.calls.filter((call) => call[1] === 'Already pasted')).toHaveLength(
      1,
    );
    expect(coordinator.isAutomationWriteInFlight(child.id)).toBe(false);
  });

  it('preserves review notifications and explicit desktop approval while disabled', async () => {
    const child = await create();
    coordinator.signalDone(child.id);
    mockNotifyRenderer.mockClear();
    coordinator.setOrchestrationEnabled(false);
    expect(mockNotifyRenderer).not.toHaveBeenCalledWith(
      'mcp_coordinator_notification_cleared',
      expect.anything(),
    );
    gitResults();
    await coordinator.approveAndMergeTask(child.id, {
      expectedCommit: sha,
      expectedTargetBranch: 'parent',
      expectedTargetCommit: targetSha,
    });
    expect(mockGitMergeTask).toHaveBeenCalledOnce();
  });

  it('permits manual child restart while disabled and treats repeated disable as a no-op', async () => {
    const child = await create();
    getExitHandler()(child.agentId, { exitCode: 0 });
    coordinator.setOrchestrationEnabled(false);
    const reservation = coordinator.reserveChildRestart(child.id);
    coordinator.setOrchestrationEnabled(false);
    expect(() => reservation.assertAllowed()).not.toThrow();
    reservation();
  });

  it('keeps trusted phone creation available without replaying its assignment after enable', async () => {
    coordinator.setDefaultProject('project', '/project', 'parent');
    coordinator.setOrchestrationEnabled(false);
    await expect(create({ coordinatorTaskId: 'api' })).resolves.toMatchObject({ id: 'task-1' });
    expect(mockSpawnAgent).toHaveBeenCalledOnce();
    expect(coordinator.getTask('task-1')?.initialPrompt).toBeUndefined();
    coordinator.setOrchestrationEnabled(true);
    getOutputCb()(Buffer.from('› ').toString('base64'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockWriteToAgent).not.toHaveBeenCalled();
  });
});
