import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/dialog', () => ({
  confirm: vi.fn(),
  openDialog: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(),
}));

vi.mock('./tasks', () => ({
  closeTask: vi.fn(),
}));

import { produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { setStore, store } from './core';
import { updateProject } from './projects';
import type { Task } from './types';

describe('updateProject', () => {
  afterEach(() => {
    setStore('projects', []);
  });

  it('clears the configured coverage report path when undefined is provided', () => {
    setStore('projects', [
      {
        id: 'p1',
        name: 'Project',
        path: '/repo',
        color: 'hsl(0, 70%, 75%)',
        coverageReportPath: 'coverage/lcov.info',
      },
    ]);

    updateProject('p1', { coverageReportPath: undefined });

    expect(store.projects[0]?.coverageReportPath).toBeUndefined();
  });

  it('clears the default base branch when undefined is provided', () => {
    setStore('projects', [
      {
        id: 'p1',
        name: 'Project',
        path: '/repo',
        color: 'hsl(0, 70%, 75%)',
        defaultBaseBranch: 'main',
      },
    ]);

    updateProject('p1', { defaultBaseBranch: undefined });

    expect(store.projects[0]?.defaultBaseBranch).toBeUndefined();
  });
});

describe('updateProject verify command', () => {
  const project = (id: string, verifyCommand?: string) => ({
    id,
    name: id,
    path: `/${id}`,
    color: 'hsl(0, 70%, 75%)',
    verifyCommand,
  });
  const coordinator = (
    id: string,
    projectId: string,
    mcpStartupStatus: Task['mcpStartupStatus'],
  ): Task => ({
    id,
    name: id,
    projectId,
    branchName: `task/${id}`,
    worktreePath: `/${projectId}/.worktrees/${id}`,
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
    coordinatorMode: true,
    mcpStartupStatus,
  });

  afterEach(() => {
    setStore('projects', []);
    setStore(
      produce((s) => {
        s.tasks = {};
      }),
    );
    vi.mocked(invoke).mockReset();
  });

  it('pushes a changed command to the ready coordinators of that project only', () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    setStore('projects', [project('p1', 'npm test'), project('p2', 'npm test')]);
    setStore('tasks', {
      ready: coordinator('ready', 'p1', 'ready'),
      pending: coordinator('pending', 'p1', 'pending'),
      other: coordinator('other', 'p2', 'ready'),
      plain: { ...coordinator('plain', 'p1', 'ready'), coordinatorMode: false },
    });

    updateProject('p1', { verifyCommand: undefined });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      IPC.MCP_CoordinatorRegistered,
      expect.objectContaining({ coordinatorTaskId: 'ready', projectId: 'p1', verifyCommand: '' }),
    );
  });

  it('leaves coordinators alone when the command is unchanged', () => {
    setStore('projects', [project('p1', 'npm test')]);
    setStore('tasks', { ready: coordinator('ready', 'p1', 'ready') });

    updateProject('p1', { verifyCommand: 'npm test', name: 'Renamed' });

    expect(invoke).not.toHaveBeenCalled();
  });
});
