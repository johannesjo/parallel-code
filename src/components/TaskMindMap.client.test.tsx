import { createStore } from 'solid-js/store';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { expectDefined } from '../store/test-helpers';
import { sendPrompt } from '../store/store';
import { setStore } from '../store/core';
import { isAgentIdle } from '../store/taskStatus';
import { replaceUnreadableMindMap, setTaskMindMap } from '../store/canvas';
import type { Task } from '../store/types';
import type { MindMapDocument } from '../graph/model';
import { CANVAS_TOOLS_UNAVAILABLE } from '../investigation/live-activation';
import { TaskMindMap } from './TaskMindMap';

vi.mock('../store/store', () => ({
  store: { canvasOwnershipBadges: true },
  sendPrompt: vi.fn(async () => undefined),
}));
vi.mock('../store/core', () => {
  const [store, setStore] = createStore({
    tasks: {} as Record<string, Task>,
    agents: {} as Record<string, { status: 'running' | 'exited'; canvasTools?: boolean }>,
  });
  return { store, setStore };
});
vi.mock('../store/taskStatus', () => ({
  isAgentIdle: vi.fn(() => true),
  isAgentAskingQuestion: vi.fn(() => false),
}));
vi.mock('../store/agentHookStatus', () => ({ getAgentHookStatus: vi.fn(() => null) }));
vi.mock('../store/canvas', () => ({
  setTaskMindMap: vi.fn(),
  replaceUnreadableMindMap: vi.fn(),
  askCanvasBranch: vi.fn(),
  referenceCanvasNode: vi.fn(),
}));

let container: HTMLDivElement;
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  vi.mocked(sendPrompt).mockClear();
  vi.mocked(isAgentIdle).mockReturnValue(true);
  setStore('agents', 'agent-1', { status: 'running', canvasTools: true });
});
afterEach(() => {
  dispose?.();
  container.remove();
  vi.useRealTimers();
});
function editedMap(): MindMapDocument {
  return {
    version: 1,
    revision: 3,
    relations: [],
    records: [
      { id: 'root', title: 'Root', detail: '' },
      { id: 'a', parent: 'root', title: 'Mine', detail: '', userEdited: ['title'] },
    ],
  };
}
function mount(
  mindMap: MindMapDocument | undefined,
  agentIds = ['agent-1'],
  id = 'task-1',
  mindMapUnreadable?: unknown,
) {
  const [task, setTask] = createStore<Task>({
    id,
    name: 'Task',
    projectId: 'project-1',
    branchName: 'task/map',
    worktreePath: '/tmp/task',
    agentIds,
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
    mindMap,
    mindMapUnreadable,
  });
  vi.mocked(setTaskMindMap).mockImplementation((_id, document) => setTask('mindMap', document));
  dispose = render(() => <TaskMindMap task={task} visible />, container);
  vi.advanceTimersByTime(50);
  return { task, setTask };
}
function sendItem() {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === 'Send changes',
  );
}

it('sends manual mind map changes once per change set and shows ownership marks', async () => {
  const { setTask } = mount(editedMap());
  expect(container.querySelector('.mindmap-ownership')).not.toBeNull();
  expectDefined(sendItem()).click();
  await vi.advanceTimersByTimeAsync(0);
  expect(sendPrompt).toHaveBeenCalledTimes(1);
  const [taskId, agentId, prompt] = vi.mocked(sendPrompt).mock.calls[0];
  expect([taskId, agentId]).toEqual(['task-1', 'agent-1']);
  expect(prompt).toContain('mind map');
  expect(prompt).toContain('mindmap_read');
  expect(sendItem()).toBeUndefined();
  // A further edit produces a new change set worth sending.
  setTask('mindMap', {
    ...editedMap(),
    revision: 4,
    records: [
      ...editedMap().records,
      { id: 'b', parent: 'root', title: 'Also mine', detail: '', userEdited: ['*'] },
    ],
  });
  expect(sendItem()?.disabled).toBe(false);
});

it('disables sending while the agent is busy and without an agent, and hides it without edits', () => {
  vi.mocked(isAgentIdle).mockReturnValue(false);
  // The change set sent for task-1 above stays remembered for the session.
  mount(editedMap(), ['agent-1'], 'task-2');
  expect(sendItem()?.disabled).toBe(true);
  expect(sendItem()?.title).toBe('Wait until the agent is idle.');
  dispose?.();
  mount(editedMap(), [], 'task-3');
  expect(sendItem()?.title).toBe('No agent session available for this task.');
  dispose?.();
  mount(undefined, ['agent-1'], 'task-4');
  expect(setTaskMindMap).toHaveBeenCalledWith('task-4', expect.objectContaining({ version: 1 }));
  expect(sendItem()).toBeUndefined();
});

it('blocks sending for an exited agent and for a session without canvas tools', () => {
  setStore('agents', 'agent-1', 'status', 'exited');
  mount(editedMap(), ['agent-1'], 'task-5');
  expect(sendItem()?.disabled).toBe(true);
  expect(sendItem()?.title).toBe('Start the agent before sending changes.');
  dispose?.();
  setStore('agents', 'agent-1', { status: 'running', canvasTools: false });
  mount(editedMap(), ['agent-1'], 'task-6');
  expect(sendItem()?.disabled).toBe(true);
  expect(sendItem()?.title).toBe(CANVAS_TOOLS_UNAVAILABLE);
});

it('does not replace a saved map that could not be read', () => {
  const { task } = mount(undefined, ['agent-1'], 'task-7');
  expect(setTaskMindMap).toHaveBeenCalledWith('task-7', expect.objectContaining({ version: 1 }));
  dispose?.();
  vi.mocked(setTaskMindMap).mockClear();
  const [broken] = createStore<Task>({ ...task, id: 'task-8', mindMapUnreadable: { nope: true } });
  dispose = render(() => <TaskMindMap task={broken} visible />, container);
  expect(setTaskMindMap).not.toHaveBeenCalled();
});

it('shows an unreadable saved map as a notice and only replaces it on request', () => {
  mount(undefined, ['agent-1'], 'task-7', { version: 99 });
  expect(setTaskMindMap).not.toHaveBeenCalledWith('task-7', expect.anything());
  expect(container.querySelector('.mindmap-editor')).toBeNull();
  const replace = expectDefined(
    [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Replace it'),
    ),
  );
  replace.click();
  expect(replaceUnreadableMindMap).toHaveBeenCalledWith('task-7');
});
