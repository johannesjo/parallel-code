import { randomUUID } from 'crypto';
import os from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setupCoordinatorHarness,
  resetCoordinatorMocks,
  mockReadFileSync,
  mockExistsSync,
  mockUnlinkSync,
  mockAtomicWriteFileSync,
  mockAppendGitInfoExcludeBlock,
  mockNotifyRenderer,
  mockWin,
} from './coordinator-test-harness.js';

const { Coordinator } = await setupCoordinatorHarness();
const fs = await vi.importActual<typeof import('fs')>('fs');

describe('existing Kimi task hydration failure', () => {
  let dir: string;
  let configPath: string;
  let worktreeConfig: string;
  let coordinator: InstanceType<typeof Coordinator>;
  let args: Parameters<InstanceType<typeof Coordinator>['hydrateTask']>[0];

  function getHydratedTask() {
    const task = coordinator.getTask(args.id);
    if (!task) throw new Error('Expected the fixture task to be hydrated');
    return task;
  }

  beforeEach(() => {
    resetCoordinatorMocks();
    dir = fs.mkdtempSync(join(os.tmpdir(), 'kimi-hydration-'));
    fs.mkdirSync(join(dir, '.kimi-code'));
    const id = randomUUID();
    configPath = join(os.tmpdir(), `parallel-code-subtask-${id}.json`);
    worktreeConfig = join(dir, '.kimi-code/mcp.json');
    mockExistsSync.mockImplementation((file) => fs.existsSync(file));
    mockReadFileSync.mockImplementation((file, encoding) => fs.readFileSync(file, encoding));
    mockUnlinkSync.mockImplementation((file) => fs.unlinkSync(file));
    mockAtomicWriteFileSync.mockImplementation((file, data) =>
      fs.writeFileSync(file, data, { mode: 0o600 }),
    );
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.registerCoordinator('coord', 'project');
    coordinator.setMCPServerInfo(
      'coord',
      'http://localhost:3001',
      'coord-token',
      'old-token',
      '/server.js',
    );
    args = {
      id,
      name: 'child',
      projectId: 'project',
      projectRoot: dir,
      branchName: 'task/child',
      worktreePath: dir,
      agentId: 'agent',
      coordinatorTaskId: 'coord',
      agentCommand: 'kimi',
      mcpConfigPath: configPath,
    };
    coordinator.hydrateTask(args);
  });

  afterEach(() => {
    fs.rmSync(configPath, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    resetCoordinatorMocks();
  });

  it.each(['exclude', 'worktree write', 'per-task write'])(
    'preserves both configs and live state after a failed %s, then permits retry',
    (failure) => {
      const task = getHydratedTask();
      // Older persisted tasks can lack a done token; a failed hydration must not
      // publish the newly generated one to just one of the two config files.
      delete task.doneToken;
      const before = { ...task };
      const originalConfig = fs.readFileSync(configPath, 'utf8');
      const originalWorktree = fs.readFileSync(worktreeConfig, 'utf8');
      mockNotifyRenderer.mockClear();
      if (failure === 'exclude') {
        mockAppendGitInfoExcludeBlock.mockReturnValueOnce('failed');
      } else {
        const failingPath = failure === 'worktree write' ? worktreeConfig : configPath;
        mockAtomicWriteFileSync.mockImplementationOnce((file, data) => {
          if (file === failingPath) throw new Error('simulated write failure');
          fs.writeFileSync(file, data, { mode: 0o600 });
          mockAtomicWriteFileSync.mockImplementationOnce(() => {
            throw new Error('simulated write failure');
          });
        });
      }

      expect(() =>
        coordinator.hydrateTask({ ...args, agentCommand: '/usr/local/bin/kimi' }),
      ).toThrow();
      expect(fs.readFileSync(configPath, 'utf8')).toBe(originalConfig);
      expect(fs.readFileSync(worktreeConfig, 'utf8')).toBe(originalWorktree);
      expect(coordinator.getTask(args.id)).toBe(task);
      expect(task).toEqual(before);
      expect(mockNotifyRenderer).not.toHaveBeenCalledWith('mcp_task_state_sync', expect.anything());

      const result = coordinator.hydrateTask({ ...args, agentCommand: '/usr/local/bin/kimi' });
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const worktree = JSON.parse(fs.readFileSync(worktreeConfig, 'utf8'));
      expect(config.mcpServers['parallel-code']).toEqual(worktree.mcpServers['parallel-code']);
      expect(task.agentCommand).toBe('/usr/local/bin/kimi');
      expect(task.doneToken).toBeTruthy();
      expect(result.autoDiscoveredMcpConfig).toEqual(task.autoDiscoveredMcpConfig);
    },
  );

  it('removes only the newly created per-task config when worktree setup fails', () => {
    fs.unlinkSync(configPath);
    const task = getHydratedTask();
    const before = { ...task };
    const originalWorktree = fs.readFileSync(worktreeConfig, 'utf8');
    mockAppendGitInfoExcludeBlock.mockReturnValueOnce('failed');

    expect(() => coordinator.hydrateTask(args)).toThrow('Unable to git-exclude');
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.readFileSync(worktreeConfig, 'utf8')).toBe(originalWorktree);
    expect(task).toEqual(before);
    expect(() => coordinator.hydrateTask(args)).not.toThrow();
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('does not write either config if the previous per-task config cannot be read', () => {
    const task = getHydratedTask();
    const before = { ...task };
    mockAtomicWriteFileSync.mockClear();
    mockReadFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });

    expect(() => coordinator.hydrateTask(args)).toThrow('permission denied');
    expect(mockAtomicWriteFileSync).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it('surfaces a rollback failure without publishing staged task state', () => {
    const task = getHydratedTask();
    delete task.doneToken;
    const before = { ...task };
    mockNotifyRenderer.mockClear();
    mockAppendGitInfoExcludeBlock.mockReturnValueOnce('failed');
    mockAtomicWriteFileSync
      .mockImplementationOnce((file, data) => fs.writeFileSync(file, data, { mode: 0o600 }))
      .mockImplementationOnce(() => {
        throw new Error('rollback write failed');
      });

    expect(() => coordinator.hydrateTask(args)).toThrow(
      'Task hydration failed and the previous per-task MCP config could not be restored.',
    );
    expect(task).toEqual(before);
    expect(mockNotifyRenderer).not.toHaveBeenCalled();
  });

  it('keeps both committed configs and live state consistent if renderer notification fails', () => {
    const task = getHydratedTask();
    delete task.doneToken;
    mockNotifyRenderer.mockImplementationOnce(() => {
      throw new Error('renderer unavailable');
    });

    expect(() => coordinator.hydrateTask(args)).toThrow('renderer unavailable');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const worktree = JSON.parse(fs.readFileSync(worktreeConfig, 'utf8'));
    expect(config.mcpServers['parallel-code']).toEqual(worktree.mcpServers['parallel-code']);
    expect(config.mcpServers['parallel-code'].env.PARALLEL_CODE_MCP_DONE_TOKEN).toBe(
      task.doneToken,
    );
    expect(() => coordinator.hydrateTask(args)).not.toThrow();
  });
});
