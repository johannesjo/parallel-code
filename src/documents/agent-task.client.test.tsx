import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { setStore, store } from '../store/core';
import { applyAgentHookEvent, clearAgentHookStatus } from '../store/agentHookStatus';
import { clearAgentActivity } from '../store/taskStatus';
import type { AgentDef } from '../ipc/types';
import type { Project, Task } from '../store/types';
import {
  activateDocumentAgentTask,
  disposeDocumentAgentTask,
  documentAgentTaskId,
  ensureDocumentAgentTask,
  rearmDocumentAgents,
  releaseDocumentAgentTask,
  sendToDocumentAgent,
} from './agent-task';
import { resetWorkspaceUi, setRailTab, workspaceUi } from './workspace-ui';

const { sendPrompt, invoke } = vi.hoisted(() => ({
  sendPrompt: vi.fn(() => Promise.resolve()),
  invoke: vi.fn(() => Promise.resolve()),
}));

vi.mock('../store/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/tasks')>()),
  sendPrompt,
}));
vi.mock('../lib/ipc', () => ({
  invoke,
  Channel: class {
    dispose() {}
  },
}));

afterEach(() => {
  clearAgentActivity(documentAgentTaskId('docs'));
  clearAgentHookStatus(documentAgentTaskId('docs'));
  setStore({
    projects: [],
    availableAgents: [],
    tasks: {},
    agents: {},
    taskOrder: [],
    activeTaskId: null,
    activeAgentId: null,
  });
  resetWorkspaceUi();
  vi.clearAllMocks();
});

const agent = (id: string): AgentDef => ({
  id,
  name: id,
  command: id,
  args: [],
  resume_args: [],
  skip_permissions_args: [],
  description: '',
});

const project: Project = {
  id: 'docs',
  name: 'Docs',
  path: '/projects/docs',
  color: '',
  kind: 'document',
  documentPath: 'notes.md',
  documentTerminalAgentId: 'codex',
};

const codingTask: Task = {
  id: 't1',
  name: 'Task 1',
  projectId: 'code',
  branchName: 'task/t1',
  worktreePath: '/projects/code',
  agentIds: ['a1'],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
};

function install(...ids: string[]): void {
  setStore({ availableAgents: ids.map(agent), projects: [project] });
}

describe('ensureDocumentAgentTask', () => {
  it('creates a hidden task in the checkout whose first agent shares its id', () => {
    install('claude-code', 'codex');

    const task = ensureDocumentAgentTask(project);

    expect(task?.id).toBe(documentAgentTaskId('docs'));
    expect(store.taskOrder).not.toContain(task?.id);
    expect(task?.gitIsolation).toBe('none');
    expect(task?.worktreePath).toBe('/projects/docs');
    expect(task?.agentIds).toEqual([task?.id]);
    expect(task?.aiTerminalLayout).toBe('tabs');
    expect(store.agents[task?.id ?? '']?.def.id).toBe('codex');
    expect(store.agents[task?.id ?? '']?.attachExisting).toBe(true);
  });

  it('returns the existing task as it is', () => {
    install('codex');
    const task = ensureDocumentAgentTask(project);
    const id = task?.id ?? '';
    setStore('agents', id, 'attachExisting', false);

    expect(ensureDocumentAgentTask(project)?.id).toBe(id);
    expect(store.agents[id]?.attachExisting).toBe(false);
  });

  it('falls back to an installed agent, and to none when nothing is installed', () => {
    install('claude-code');
    expect(store.agents[ensureDocumentAgentTask(project)?.id ?? '']?.def.id).toBe('claude-code');

    setStore({ tasks: {}, agents: {}, availableAgents: [] });
    expect(ensureDocumentAgentTask(project)).toBeNull();
  });
});

describe('rearmDocumentAgents', () => {
  it('attaches to a live session again after a restart cleared the flag', () => {
    install('codex');
    const task = ensureDocumentAgentTask(project);
    const id = task?.id ?? '';
    setStore('agents', id, 'attachExisting', false);

    rearmDocumentAgents(store.tasks[id] as Task);

    expect(store.agents[id]?.attachExisting).toBe(true);
    expect(store.agents[id]?.status).toBe('running');
  });

  it('resets an agent that exited, since the mount spawns it afresh', () => {
    install('codex');
    const task = ensureDocumentAgentTask(project);
    const id = task?.id ?? '';
    setStore('agents', id, { status: 'exited', exitCode: 1, lastOutput: ['bye'] });

    rearmDocumentAgents(store.tasks[id] as Task);

    expect(store.agents[id]?.status).toBe('running');
    expect(store.agents[id]?.exitCode).toBeNull();
    expect(store.agents[id]?.lastOutput).toEqual([]);
  });
});

describe('sendToDocumentAgent', () => {
  it('prefills resumed sessions without sending prose into a possible picker', async () => {
    install('codex');
    const task = ensureDocumentAgentTask(project);
    if (!task) throw new Error('Document task was not created');
    setStore('agents', task.agentIds[0], 'resumed', true);
    await sendToDocumentAgent(project, 'Check this first');
    expect(store.tasks[task.id].prefillPrompt).toBe('Check this first');
    expect(store.tasks[task.id].initialPrompt).toBeUndefined();
    expect(sendPrompt).not.toHaveBeenCalled();
    await expect(sendToDocumentAgent(project, 'Another instruction')).rejects.toThrow(
      'existing prompt',
    );
  });

  it('queues the prompt for a first agent that is still starting, on the agent tab', async () => {
    install('codex');
    setRailTab('runs');

    await sendToDocumentAgent(project, 'Tighten the intro.');

    expect(workspaceUi.railTab).toBe('agent');
    expect(store.tasks[documentAgentTaskId('docs')]?.initialPrompt).toBe('Tighten the intro.');
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('types the prompt in when the agent sits at its prompt', async () => {
    install('codex');
    const id = ensureDocumentAgentTask(project)?.id ?? '';
    clearAgentActivity(id);

    await sendToDocumentAgent(project, 'Tighten the intro.');

    expect(sendPrompt).toHaveBeenCalledWith(id, id, 'Tighten the intro.');
  });

  it('holds the instruction while the hooks say a turn is in flight', async () => {
    install('codex');
    const id = ensureDocumentAgentTask(project)?.id ?? '';
    clearAgentActivity(id);
    applyAgentHookEvent({
      agentId: id,
      taskId: id,
      at: Date.now(),
      state: 'working',
      event: 'PreToolUse',
    });

    await sendToDocumentAgent(project, 'Tighten the intro.');

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(store.tasks[id]?.initialPrompt).toBe('Tighten the intro.');
  });

  it('refuses a second instruction while the first still waits', async () => {
    install('codex');
    await sendToDocumentAgent(project, 'Tighten the intro.');

    await expect(sendToDocumentAgent(project, 'Cut the outro.')).rejects.toThrow(
      'The agent has not taken the previous instruction yet.',
    );
    expect(store.tasks[documentAgentTaskId('docs')]?.initialPrompt).toBe('Tighten the intro.');
  });

  it('refuses when no agent is installed', async () => {
    setStore({ projects: [project] });
    await expect(sendToDocumentAgent(project, 'x')).rejects.toThrow('No agent is installed.');
  });
});

describe('active task hand-over', () => {
  it('activates the agent task while the workspace is up and hands back after', () => {
    install('codex');
    setStore({ tasks: { t1: codingTask }, taskOrder: ['t1'], activeTaskId: 't1' });

    activateDocumentAgentTask(project);
    expect(store.activeTaskId).toBe(documentAgentTaskId('docs'));

    releaseDocumentAgentTask('t1');
    expect(store.activeTaskId).toBe('t1');
  });

  it('falls back to the first task, or none, when the previous one is gone', () => {
    install('codex');
    setStore({ tasks: { t1: codingTask }, taskOrder: ['t1'] });
    activateDocumentAgentTask(project);

    releaseDocumentAgentTask('gone');
    expect(store.activeTaskId).toBe('t1');

    activateDocumentAgentTask(project);
    setStore({
      tasks: { [documentAgentTaskId('docs')]: store.tasks[documentAgentTaskId('docs')] },
    });
    setStore({ taskOrder: [] });
    releaseDocumentAgentTask('t1');
    expect(store.activeTaskId).toBeNull();
  });

  it('leaves a task the user picked meanwhile alone', () => {
    install('codex');
    setStore({ tasks: { t1: codingTask }, taskOrder: ['t1'], activeTaskId: 't1' });
    activateDocumentAgentTask(project);
    setStore('activeTaskId', 't1');

    releaseDocumentAgentTask(null);
    expect(store.activeTaskId).toBe('t1');
  });
});

describe('disposeDocumentAgentTask', () => {
  it('kills the sessions, forgets the task and gives up the active slot', async () => {
    install('codex');
    activateDocumentAgentTask(project);
    const id = documentAgentTaskId('docs');

    await disposeDocumentAgentTask('docs');

    expect(invoke).toHaveBeenCalledWith(IPC.KillAgent, { agentId: id });
    expect(store.tasks[id]).toBeUndefined();
    expect(store.agents[id]).toBeUndefined();
    expect(store.activeTaskId).toBeNull();
  });

  it('does nothing for a project that never had one', async () => {
    await disposeDocumentAgentTask('docs');
    expect(invoke).not.toHaveBeenCalledWith(IPC.KillAgent, expect.anything());
  });
});
