import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { store, setStore } from '../store/core';
import { navigateColumn, navigateTask } from '../store/focus';
import { bringTaskToFront, sendTaskToBack } from '../store/background-tasks';
import { jumpToTask, moveActiveTask, setActiveTask } from '../store/navigation';
import { registerFocusFn, setTaskFocusedPanel, unregisterFocusFn } from '../store/focused-panel';
import { TilingLayout } from './TilingLayout';
import { IPC } from '../../electron/ipc/channels';

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(async (channel: IPC) => {
    if (channel === IPC.DelegationRequest) return { attempts: [], messages: [], paused: false };
    return channel === IPC.GetCoverageSummary ? null : [];
  }),
}));
vi.mock('../documents/DocumentWorkspacePanel', () => ({ DocumentWorkspacePanel: () => null }));
vi.mock('./TerminalView', () => ({ TerminalView: () => null }));

const ids = ['a', 'b', 'c'];
let host: HTMLDivElement;
let dispose: () => void;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let focus: string[];
let scrolls: string[];

function frame() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((cb) => cb(performance.now()));
}

beforeEach(async () => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++nextFrame, cb);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  setStore({
    projects: [{ id: 'p', name: 'Project', path: '/tmp/task-switching', color: '#abc' }],
    tasks: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          id,
          name: id,
          projectId: 'p',
          branchName: '',
          worktreePath: '/tmp/task-switching',
          agentIds: [],
          shellAgentIds: [],
          notes: '',
          lastPrompt: '',
          gitIsolation: 'none' as const,
        },
      ]),
    ),
    taskOrder: [...ids],
    collapsedTaskOrder: [],
    terminals: {},
    activeTaskId: 'a',
    activeAgentId: null,
    activeDocumentProjectId: null,
    focusedPanel: { a: 'ai-terminal', b: 'prompt', c: 'prompt' },
    showNewTaskPanel: false,
    focusMode: false,
    sidebarFocused: false,
    placeholderFocused: false,
    newTaskPanelFocused: false,
    sidebarVisible: true,
  });
  host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <TilingLayout />, host);
  Object.defineProperty(host.querySelector('[data-tiling-strip]'), 'clientWidth', { value: 1400 });
  scrolls = [];
  focus = [];
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
    scrolls.push(this.dataset.taskId ?? 'other');
  });
  for (const id of ids) {
    for (const panel of ['prompt', 'ai-terminal']) {
      registerFocusFn(`${id}:${panel}`, () => focus.push(`${id}:${panel}`));
    }
  }
  await Promise.resolve();
  frame();
  scrolls.length = 0;
  focus.length = 0;
});

afterEach(async () => {
  expect(host.textContent).not.toContain('Panel crashed');
  dispose();
  host.remove();
  await Promise.resolve();
  frame();
  for (const id of ids) {
    for (const panel of ['prompt', 'ai-terminal']) unregisterFocusFn(`${id}:${panel}`);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('focuses only the intended pane and scrolls once when crossing tasks', async () => {
  navigateColumn('right');
  await Promise.resolve();
  frame();
  expect(store.activeTaskId).toBe('b');
  expect(focus).toEqual(['b:ai-terminal']);
  expect(scrolls).toEqual(['b']);
});

it('discards stale scroll targets when direction changes before the next frame', async () => {
  navigateColumn('right');
  navigateColumn('right');
  navigateColumn('left');
  await Promise.resolve();
  frame();
  expect(store.activeTaskId).toBe('b');
  expect(focus).toEqual(['b:ai-terminal']);
  expect(scrolls).toEqual(['b']);
});

it('restores focus when selecting a task without an explicit pane request', async () => {
  setActiveTask('b');
  await Promise.resolve();
  frame();
  expect(focus).toEqual(['b:prompt']);
  expect(scrolls).toEqual(['b']);
});

it('can refocus and reveal an already-selected pane', async () => {
  setTaskFocusedPanel('a', 'ai-terminal');
  await Promise.resolve();
  frame();
  expect(focus).toEqual(['a:ai-terminal']);
  expect(scrolls).toEqual(['a']);
});

it('still reveals the active task after keyboard reordering', async () => {
  moveActiveTask('right');
  await Promise.resolve();
  frame();
  expect(store.taskOrder).toEqual(['b', 'a', 'c']);
  expect(focus).toEqual(['a:ai-terminal']);
  expect(scrolls).toEqual(['a']);
});

it('does not scroll hidden columns in focus mode', async () => {
  setStore('focusMode', true);
  navigateColumn('right');
  await Promise.resolve();
  frame();
  expect(focus).toEqual(['b:ai-terminal']);
  expect(scrolls).toEqual([]);
});

it('does not reclaim focus after navigation reaches the sidebar', async () => {
  navigateColumn('right');
  navigateColumn('left');
  navigateColumn('left');
  await Promise.resolve();
  frame();
  expect(store.sidebarFocused).toBe(true);
  expect(focus).toEqual([]);
  expect(scrolls).toEqual(['a']);
});

it('reveals a selected task while focus stays in the sidebar', async () => {
  setStore('sidebarFocused', true);
  setActiveTask('b');
  await Promise.resolve();
  frame();
  expect(focus).toEqual([]);
  expect(scrolls).toEqual(['b']);
});

it('returns from the add-task placeholder with a numbered task shortcut', async () => {
  navigateColumn('right');
  navigateColumn('right');
  navigateColumn('right');
  await Promise.resolve();
  frame();
  expect(store.placeholderFocused).toBe(true);
  focus.length = 0;
  scrolls.length = 0;
  jumpToTask(0);
  await Promise.resolve();
  frame();
  expect(store.placeholderFocused).toBe(false);
  expect(host.textContent).not.toContain('Panel crashed');
  expect(store.activeTaskId).toBe('a');
  expect(focus).toEqual(['a:ai-terminal']);
  expect(scrolls).toEqual(['a']);
});

it('scrolls the tiled tasks while a draft temporarily opens the focus-mode layout', async () => {
  setStore('focusMode', true);
  setStore('showNewTaskPanel', true);
  await Promise.resolve();
  frame();
  scrolls.length = 0;
  setActiveTask('b');
  await Promise.resolve();
  frame();
  expect(store.activeTaskId).toBe('b');
  expect(scrolls).toEqual(['b']);
});

it('keyboard travel skips a snoozed task instead of waking it', async () => {
  sendTaskToBack('c', 1);
  try {
    navigateColumn('right');
    navigateColumn('right');
    expect(store.placeholderFocused).toBe(true);
    navigateColumn('left');
    expect(store.activeTaskId).toBe('b');
    navigateTask('right');
    expect(store.activeTaskId).toBe('b');
    setStore({ showNewTaskPanel: true, newTaskPanelFocused: true });
    navigateColumn('left');
    expect(store.activeTaskId).toBe('b');
  } finally {
    bringTaskToFront('c');
  }
});

it('entering from the sidebar wakes nothing when every task is snoozed', async () => {
  ids.forEach((id) => sendTaskToBack(id, 1));
  try {
    setStore({ sidebarFocused: true, sidebarFocusedTaskId: null });
    navigateColumn('right');
    expect(store.activeTaskId).toBe(null);
  } finally {
    ids.forEach((id) => bringTaskToFront(id));
  }
});
