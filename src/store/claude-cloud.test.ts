import { beforeEach, describe, expect, it, vi } from 'vitest';

const { typeIntoAgent, spawnProgramForTask, pushTask } = vi.hoisted(() => ({
  typeIntoAgent: vi.fn(() => Promise.resolve()),
  spawnProgramForTask: vi.fn(() => 'shell-1'),
  pushTask: vi.fn(() => Promise.resolve()),
}));
vi.mock('./tasks', () => ({ typeIntoAgent, spawnProgramForTask, pushTask }));
vi.mock('../lib/ipc', () => ({
  Channel: class {
    dispose = vi.fn();
  },
}));

import { produce } from 'solid-js/store';
import { setStore, store } from './core';
import {
  cloudHandoffCommand,
  cloudHandoffForMobile,
  remoteControlAgent,
  runRemoteControl,
  startCloudHandoffFromMobile,
  startCloudSession,
} from './claude-cloud';
import type { Agent, Task } from './types';

function setup(opts: { command?: string; status?: 'running' | 'exited'; task?: Partial<Task> }) {
  // Replaced, not merged, so one test's fields never leak into the next.
  setStore(
    produce((s) => {
      s.agents['agent-1'] = {
        id: 'agent-1',
        def: { id: 'x', command: opts.command ?? 'claude' },
        status: opts.status ?? 'running',
        generation: 1,
      } as unknown as Agent;
      s.tasks['task-1'] = {
        id: 'task-1',
        name: 'Fix login',
        agentIds: ['agent-1'],
        ...opts.task,
      } as unknown as Task;
    }),
  );
  return store.tasks['task-1'];
}

describe('Remote Control', () => {
  beforeEach(() => typeIntoAgent.mockClear());

  it('is offered only for a running Claude terminal', () => {
    expect(remoteControlAgent(setup({}))?.id).toBe('agent-1');
    expect(remoteControlAgent(setup({ command: 'codex' }))).toBeNull();
    expect(remoteControlAgent(setup({ status: 'exited' }))).toBeNull();
    expect(remoteControlAgent(setup({ task: { dockerMode: true } }))).toBeNull();
    expect(remoteControlAgent(setup({ task: { closingStatus: 'closing' } }))).toBeNull();
  });

  it('connects named after the task, then opens the status panel', async () => {
    setup({});
    await runRemoteControl('task-1');
    await runRemoteControl('task-1');
    expect(typeIntoAgent.mock.calls.map((call) => (call as unknown[])[2])).toEqual([
      '/remote-control Fix login',
      '/remote-control',
    ]);
  });

  it('connects again after the agent restarts', async () => {
    setup({});
    await runRemoteControl('task-1');
    setStore('agents', 'agent-1', 'generation', 2);
    await runRemoteControl('task-1');
    expect((typeIntoAgent.mock.calls[1] as unknown[])[2]).toBe('/remote-control Fix login');
  });
});

it('types nothing while the user has a draft in the agent terminal', async () => {
  typeIntoAgent.mockClear();
  setup({ task: { terminalInputPending: true } });
  await runRemoteControl('task-1');
  expect(typeIntoAgent).not.toHaveBeenCalled();
});

describe('cloud handoff', () => {
  beforeEach(() => spawnProgramForTask.mockClear());

  it("uses the lead agent's own Claude command", () => {
    expect(cloudHandoffCommand(setup({ command: '/opt/bin/claude' }))).toBe('/opt/bin/claude');
  });

  it('is not offered for other agents, Docker tasks or closing tasks', () => {
    expect(cloudHandoffCommand(setup({ command: 'codex' }))).toBeNull();
    expect(cloudHandoffCommand(setup({ task: { dockerMode: true } }))).toBeNull();
    expect(cloudHandoffCommand(setup({ task: { closingStatus: 'closing' } }))).toBeNull();
  });

  it('runs claude --cloud with the prompt in a task terminal', () => {
    setup({});
    setStore('agentEnvFiles', 'x', 'CLAUDE_CONFIG_DIR=/home/me/.claude-work');
    startCloudSession('task-1', ' Keep going ');
    expect(spawnProgramForTask).toHaveBeenCalledWith('task-1', {
      command: 'claude',
      args: ['--cloud=Keep going'],
      envFile: 'CLAUDE_CONFIG_DIR=/home/me/.claude-work',
    });
  });
});

describe('cloud handoff from a phone', () => {
  beforeEach(() => {
    spawnProgramForTask.mockClear();
    pushTask.mockReset();
    pushTask.mockResolvedValue(undefined);
  });

  it('offers the default prompt and a push for a worktree Claude task', () => {
    setup({ task: { branchName: 'task/fix-login', gitIsolation: 'worktree' } });
    expect(cloudHandoffForMobile('task-1')).toEqual({
      available: true,
      prompt: 'Continue this task: Fix login\nThe branch has the work so far.',
      branchName: 'task/fix-login',
      canPush: true,
    });
  });

  it('says why another agent or a missing task cannot continue in the cloud', () => {
    setup({ command: 'codex' });
    expect(cloudHandoffForMobile('task-1').available).toBe(false);
    expect(cloudHandoffForMobile('missing').available).toBe(false);
  });

  it('pushes the branch before starting the session', async () => {
    setup({ task: { gitIsolation: 'worktree' } });
    await startCloudHandoffFromMobile('task-1', { prompt: 'Keep going', push: true });
    expect(pushTask).toHaveBeenCalledWith('task-1', expect.anything());
    expect(spawnProgramForTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ args: ['--cloud=Keep going'] }),
    );
  });

  it('starts nothing when the push fails', async () => {
    setup({ task: { gitIsolation: 'worktree' } });
    pushTask.mockRejectedValueOnce(new Error('rejected (non-fast-forward)'));
    await expect(
      startCloudHandoffFromMobile('task-1', { prompt: 'Keep going', push: true }),
    ).rejects.toThrow('non-fast-forward');
    expect(spawnProgramForTask).not.toHaveBeenCalled();
  });

  it('skips the push when not asked, or for a task without its own branch', async () => {
    setup({ task: { gitIsolation: 'worktree' } });
    await startCloudHandoffFromMobile('task-1', { prompt: 'Keep going', push: false });
    setup({ task: { gitIsolation: 'direct' } });
    await startCloudHandoffFromMobile('task-1', { prompt: 'Keep going', push: true });
    expect(pushTask).not.toHaveBeenCalled();
    expect(spawnProgramForTask).toHaveBeenCalledTimes(2);
  });

  it('refuses a second start while the first push is still running', async () => {
    setup({ task: { gitIsolation: 'worktree' } });
    let finishPush = () => {};
    pushTask.mockImplementationOnce(() => new Promise<void>((resolve) => (finishPush = resolve)));
    const first = startCloudHandoffFromMobile('task-1', { prompt: 'Keep going', push: true });
    await expect(
      startCloudHandoffFromMobile('task-1', { prompt: 'Keep going', push: true }),
    ).rejects.toThrow('already starting');
    finishPush();
    await first;
    expect(spawnProgramForTask).toHaveBeenCalledTimes(1);
  });

  it('refuses a task that cannot continue in the cloud', async () => {
    setup({ task: { dockerMode: true } });
    await expect(
      startCloudHandoffFromMobile('task-1', { prompt: 'Keep going', push: false }),
    ).rejects.toThrow();
    expect(spawnProgramForTask).not.toHaveBeenCalled();
  });
});
