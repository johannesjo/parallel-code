import { beforeEach, describe, expect, it, vi } from 'vitest';

const { typeIntoAgent, spawnProgramForTask } = vi.hoisted(() => ({
  typeIntoAgent: vi.fn(() => Promise.resolve()),
  spawnProgramForTask: vi.fn(() => 'shell-1'),
}));
vi.mock('./tasks', () => ({ typeIntoAgent, spawnProgramForTask }));

import { produce } from 'solid-js/store';
import { setStore, store } from './core';
import {
  cloudHandoffCommand,
  remoteControlAgent,
  runRemoteControl,
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
