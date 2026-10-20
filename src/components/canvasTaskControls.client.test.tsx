import { produce } from 'solid-js/store';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { createMindMap } from '../graph/model';
import {
  canvasTaskPrompt,
  restoreCanvasTaskLinks,
  type CanvasTaskSource,
} from '../lib/canvas-task-links';
import { invoke } from '../lib/ipc';
import { store, setStore } from '../store/core';
import {
  createCanvasTask,
  canvasTaskPending,
  canvasTaskLink,
  linkCanvasTask,
  unlinkCanvasTask,
} from '../store/canvas-tasks';
import { saveState } from '../store/persistence';
import type { Task } from '../store/types';
import type { CreateTaskOptions } from '../store/tasks';
import { createCanvasTaskControls } from './canvasTaskControls';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../store/persistence', () => ({ saveState: vi.fn() }));

const source: CanvasTaskSource = { taskId: 'parent', canvas: 'mindmap', nodeId: 'work' };
const options: CreateTaskOptions = {
  name: 'Implement work',
  projectId: 'project',
  gitIsolation: 'worktree',
  baseBranch: 'task/parent',
  agentDef: {
    id: 'agent',
    name: 'Agent',
    command: 'agent',
    args: [],
    resume_args: [],
    skip_permissions_args: [],
    description: '',
  },
  initialPrompt: 'Captured assignment',
};
function task(id: string): Task {
  return {
    id,
    name: id,
    projectId: 'project',
    branchName: `task/${id}`,
    worktreePath: `/project/${id}`,
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
  };
}
const map = {
  ...createMindMap(),
  revision: 4,
  records: [
    { id: 'root', title: 'Plan', detail: 'Goal context' },
    { id: 'work', parent: 'root', title: 'Implement work', detail: 'Requirements' },
    { id: 'child', parent: 'work', title: 'Acceptance checks', detail: 'All saved details' },
    { id: 'other', parent: 'root', title: 'Unrelated', detail: '' },
  ],
};
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  setStore({
    tasks: {},
    agents: {},
    taskOrder: [],
    collapsedTaskOrder: [],
    showNewTaskPanel: false,
    newTaskPrefillPrompt: null,
    newTaskDropUrl: null,
  });
  setStore('projects', [{ id: 'project', name: 'Project', path: '/project', color: 'blue' }]);
  setStore('tasks', 'parent', { ...task('parent'), mindMap: structuredClone(map) });
  setStore('tasks', 'existing', task('existing'));
  vi.mocked(invoke).mockImplementation(async (channel) => {
    if (channel === IPC.CreateTask)
      return { id: 'created', branch_name: 'task/created', worktree_path: '/project/created' };
    return undefined;
  });
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
});

it('captures the branch and ancestor notes without including unrelated work or relying on parent MCP access', () => {
  const prompt = canvasTaskPrompt(source, map, map.revision);
  expect(prompt).toContain('Requirements');
  expect(prompt).toContain('All saved details');
  expect(prompt).toContain('Goal context');
  expect(prompt).not.toContain('Unrelated');
  expect(prompt).not.toContain('mindmap_read');
  expect(prompt).toContain('"revision": 4');
});

it('opens an editable task form from either canvas and preserves an already open form', () => {
  const controls = createCanvasTaskControls(() => source);
  controls.actions('work', map)[0].run?.();
  expect(store.showNewTaskPanel).toBe(true);
  expect(store.newTaskPrefillPrompt).toMatchObject({
    name: 'Implement work',
    baseBranch: 'task/parent',
    canvasSource: source,
  });
  const prompt = store.newTaskPrefillPrompt?.prompt;
  const reasoning = createCanvasTaskControls(() => ({
    ...source,
    canvas: 'reasoning',
    agentId: 'owner-agent',
    runId: 'run-1',
  }));
  const action = reasoning.actions('child', map)[0];
  expect(action.disabled).toBe(true);
  action.run?.();
  expect(store.newTaskPrefillPrompt?.prompt).toBe(prompt);
  setStore('showNewTaskPanel', false);
  reasoning.actions('work', map)[0].run?.();
  expect(store.newTaskPrefillPrompt?.canvasSource).toMatchObject({
    canvas: 'reasoning',
    agentId: 'owner-agent',
    runId: 'run-1',
  });
});

it('reserves a node during launch, prevents duplicate tasks, and saves the link after success', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation((channel) =>
    channel === IPC.CreateTask
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(undefined),
  );
  const creation = createCanvasTask(source, options);
  expect(canvasTaskPending(source)).toBe(true);
  await expect(createCanvasTask(source, options)).rejects.toThrow('already being created');
  expect(() => linkCanvasTask(source, 'existing')).toThrow('already being created');
  finish({ id: 'created', branch_name: 'task/created', worktree_path: '/project/created' });
  await expect(creation).resolves.toBe('created');
  expect(canvasTaskPending(source)).toBe(false);
  expect(canvasTaskLink(source)).toMatchObject({ taskId: 'created', taskName: 'Implement work' });
  expect(store.tasks.created.savedInitialPrompt).toBe('Captured assignment');
  expect(saveState).toHaveBeenCalled();
  await expect(createCanvasTask(source, options)).rejects.toThrow('already has a task');
});

it('releases failed launches for retry without leaving a phantom link', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error('Worktree unavailable'));
  await expect(createCanvasTask(source, options)).rejects.toThrow('Worktree unavailable');
  expect(canvasTaskPending(source)).toBe(false);
  expect(canvasTaskLink(source)).toBeUndefined();
  await expect(createCanvasTask(source, options)).resolves.toBe('created');
});

it('does not recreate a source task closed while task creation was in flight', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation((channel) =>
    channel === IPC.CreateTask
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(undefined),
  );
  const creation = createCanvasTask(source, options);
  setStore(
    produce((state) => {
      delete state.tasks.parent;
    }),
  );
  finish({ id: 'created', branch_name: 'task/created', worktree_path: '/project/created' });
  await expect(creation).resolves.toBe('created');
  expect(store.tasks.parent).toBeUndefined();
  expect(store.tasks.created).toBeDefined();
});

it('isolates reasoning runs and rejects self-links and cross-project links', () => {
  const first = { ...source, canvas: 'reasoning' as const, agentId: 'owner-agent', runId: 'first' };
  const second = { ...first, runId: 'second' };
  expect(() => linkCanvasTask(source, 'parent')).toThrow('another available task');
  setStore('tasks', 'foreign', { ...task('foreign'), projectId: 'other' });
  expect(() => linkCanvasTask(source, 'foreign')).toThrow('another available task');
  linkCanvasTask(first, 'existing');
  expect(canvasTaskLink(second)).toBeUndefined();
  expect(canvasTaskLink({ ...first, agentId: 'another-agent' })).toBeUndefined();
  expect(canvasTaskLink(source)).toBeUndefined();
  const saved = restoreCanvasTaskLinks(
    JSON.parse(JSON.stringify(store.tasks.parent.canvasTaskLinks)),
  );
  expect(saved).toEqual([expect.objectContaining({ runId: 'first', taskId: 'existing' })]);
  expect(restoreCanvasTaskLinks([null, {}, { ...saved?.[0], runId: undefined }])).toBeUndefined();
});

it('updates badges from task state, opens tasks, and keeps closed links until explicitly unlinked', () => {
  linkCanvasTask(source, 'existing');
  const controls = createCanvasTaskControls(() => source);
  dispose = render(() => controls.renderBadge('work'), document.body);
  const button = () => document.querySelector<HTMLButtonElement>('button');
  expect(button()?.textContent).toContain('Idle');
  setStore('tasks', 'existing', 'needsReview', true);
  expect(button()?.textContent).toContain('Review');
  button()?.click();
  expect(store.activeTaskId).toBe('existing');
  setStore('tasks', 'existing', 'name', 'Renamed task');
  expect(button()?.textContent).toContain('Renamed task');
  setStore(
    produce((state) => {
      delete state.tasks.existing;
    }),
  );
  expect(button()?.disabled).toBe(true);
  expect(button()?.textContent).toContain('Closed');
  unlinkCanvasTask(source);
  expect(button()).toBeNull();
});

it('switches the badge with reasoning runs and never stops tasks on unlink or node deletion', () => {
  const [runId, setRunId] = createSignal('first');
  const first = { ...source, canvas: 'reasoning' as const, agentId: 'owner-agent', runId: 'first' };
  linkCanvasTask(first, 'existing');
  const controls = createCanvasTaskControls(() => ({ ...first, runId: runId() }));
  dispose = render(() => controls.renderBadge('work'), document.body);
  expect(document.querySelector('button')).not.toBeNull();
  setRunId('second');
  expect(document.querySelector('button')).toBeNull();
  setRunId('first');
  expect(document.querySelector('button')).not.toBeNull();
  unlinkCanvasTask(first);
  setStore('tasks', 'parent', 'mindMap', 'records', []);
  expect(store.tasks.existing).toBeDefined();
  expect(invoke).not.toHaveBeenCalled();
});
