import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefined, type MockStoreHarness } from './test-helpers';

type MockStore = {
  activeTaskId: string | null;
  activeAgentId: string | null;
  tasks: Record<string, MockTask>;
  terminals: Record<string, Record<string, unknown>>;
  taskOrder: string[];
  projects: Array<{ id: string; terminalBookmarks?: Array<{ id: string; command: string }> }>;
  focusedPanel: Record<string, string>;
  sidebarFocused: boolean;
  sidebarFocusedProjectId: string | null;
  sidebarFocusedTaskId: string | null;
  placeholderFocused: boolean;
  placeholderFocusedButton: 'add-task' | 'add-terminal';
  showNewTaskPanel: boolean;
  newTaskPanelFocused: boolean;
  showHelpDialog: boolean;
  showSettingsDialog: boolean;
  showPromptInput: boolean;
  sidebarVisible: boolean;
  taskSplitMode: Record<string, boolean>;
  pendingAction: { type: 'close' | 'finish'; taskId: string } | null;
};

type MockTask = {
  id: string;
  name: string;
  projectId: string;
  agentIds: string[];
  shellAgentIds: string[];
  collapsed?: boolean;
  [key: string]: unknown;
};

let mockStore: MockStore;
const core = vi.hoisted(() => ({
  harness: undefined as MockStoreHarness<MockStore> | undefined,
}));

vi.mock('solid-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('solid-js')>()),
  batch: (fn: () => void) => fn(),
}));

vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness<MockStore>({} as MockStore);
  return core.harness.moduleMock();
});

vi.mock('./navigation', () => ({
  openPanelOrder: () => mockStore.taskOrder,
  setActiveTask: vi.fn((id: string) => {
    mockStore.activeTaskId = id;
    mockStore.activeAgentId = mockStore.tasks[id]?.agentIds?.[0] ?? null;
  }),
}));

vi.mock('./notification', () => ({
  showNotification: vi.fn(),
}));

vi.mock('./sidebar-order', () => ({
  computeSidebarTaskOrder: vi.fn(() => mockStore.taskOrder),
}));

vi.mock('./tasks', () => ({
  uncollapseTask: vi.fn((id: string) => {
    if (mockStore.tasks[id]) mockStore.tasks[id].collapsed = false;
  }),
}));

import {
  navigateColumn,
  navigateRow,
  navigateTask,
  isPanelFocused,
  registerAction,
  registerFocusFn,
  scrollTaskElementIntoView,
  setPendingAction,
  setTaskFocusedPanel,
  triggerAction,
  triggerFocus,
  unregisterAction,
  unregisterFocusFn,
} from './focus';
import { showNotification } from './notification';

function setTask(id: string, overrides: Record<string, unknown> = {}): void {
  mockStore.tasks[id] = {
    id,
    name: id,
    projectId: 'project-1',
    agentIds: ['agent-1'],
    shellAgentIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const harness = expectDefined(core.harness, 'mock store harness');
  mockStore = harness.reset({
    activeTaskId: 'task-1',
    activeAgentId: 'agent-1',
    tasks: {},
    terminals: {},
    taskOrder: ['task-1'],
    projects: [{ id: 'project-1', terminalBookmarks: [] }],
    focusedPanel: {},
    sidebarFocused: false,
    sidebarFocusedProjectId: null,
    sidebarFocusedTaskId: null,
    placeholderFocused: false,
    placeholderFocusedButton: 'add-task',
    showNewTaskPanel: false,
    newTaskPanelFocused: false,
    showHelpDialog: false,
    showSettingsDialog: false,
    showPromptInput: true,
    sidebarVisible: true,
    taskSplitMode: {},
    pendingAction: null,
  });

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('document', { querySelector: () => null });
  vi.stubGlobal('CSS', { escape: (value: string) => value });
});

afterEach(() => {
  unregisterFocusFn('new-task');
  vi.unstubAllGlobals();
});

describe('focus and action registries', () => {
  it('lets a replacement keep the key when the component it replaced cleans up', () => {
    const oldFocus = vi.fn();
    const newFocus = vi.fn();
    const oldSend = vi.fn();
    const newSend = vi.fn();
    registerFocusFn('task-1:prompt', oldFocus);
    registerAction('task-1:send-prompt', oldSend);
    // Two composers share a task's keys; whichever registers last is the visible one.
    registerFocusFn('task-1:prompt', newFocus);
    registerAction('task-1:send-prompt', newSend);

    unregisterFocusFn('task-1:prompt', oldFocus);
    unregisterAction('task-1:send-prompt', oldSend);

    triggerFocus('task-1:prompt');
    triggerAction('task-1:send-prompt');
    expect(newFocus).toHaveBeenCalledOnce();
    expect(newSend).toHaveBeenCalledOnce();
    expect(oldFocus).not.toHaveBeenCalled();
    expect(oldSend).not.toHaveBeenCalled();

    unregisterFocusFn('task-1:prompt', newFocus);
    unregisterAction('task-1:send-prompt', newSend);
    triggerFocus('task-1:prompt');
    triggerAction('task-1:send-prompt');
    expect(newFocus).toHaveBeenCalledOnce();
    expect(newSend).toHaveBeenCalledOnce();
  });
});

describe('focus navigation neighbor map', () => {
  it('includes an open new-task panel after the last task', () => {
    setTask('task-1');
    mockStore.showNewTaskPanel = true;
    const focusDraft = vi.fn();
    registerFocusFn('new-task', focusDraft);

    navigateColumn('right');

    expect(focusDraft).toHaveBeenCalledOnce();
    expect(mockStore.placeholderFocused).toBe(false);
    expect(mockStore.newTaskPanelFocused).toBe(true);
    expect(isPanelFocused('task-1', 'ai-terminal:agent-1')).toBe(false);
  });

  it('returns from the new-task panel to the last task', () => {
    setTask('task-1');
    setTask('task-2');
    mockStore.taskOrder = ['task-1', 'task-2'];
    mockStore.showNewTaskPanel = true;
    mockStore.newTaskPanelFocused = true;

    navigateTask('left');

    expect(mockStore.activeTaskId).toBe('task-2');
    expect(mockStore.focusedPanel['task-2']).toBe('ai-terminal:agent-1');
  });

  it('keeps row navigation inside the new-task draft', () => {
    setTask('task-1');
    mockStore.focusedPanel['task-1'] = 'notes';
    mockStore.showNewTaskPanel = true;
    mockStore.newTaskPanelFocused = true;

    navigateRow('down');
    navigateRow('up');

    // Row keys are global, so without a guard they reach the background task and
    // pull focus out of the half-typed prompt.
    expect(mockStore.newTaskPanelFocused).toBe(true);
    expect(mockStore.focusedPanel['task-1']).toBe('notes');
  });

  it('includes an open new-task panel in direct next-task navigation', () => {
    setTask('task-1');
    mockStore.showNewTaskPanel = true;
    const focusDraft = vi.fn();
    registerFocusFn('new-task', focusDraft);

    navigateTask('right');

    expect(focusDraft).toHaveBeenCalledOnce();
  });

  describe.each([false, true])('canvas navigation (split: %s)', (split) => {
    beforeEach(() => {
      setTask('task-1', { canvasOpen: true });
      mockStore.taskSplitMode['task-1'] = split;
    });

    it('enters the visible canvas from the right edge and returns left', () => {
      mockStore.focusedPanel['task-1'] = 'changed-files';
      navigateColumn('right');
      expect(mockStore.focusedPanel['task-1']).toBe('canvas');
      expect(mockStore.placeholderFocused).toBe(false);
      navigateColumn('left');
      expect(mockStore.focusedPanel['task-1']).toBe('changed-files');
    });

    it('enters the canvas from a lower row before crossing to the next task', () => {
      setTask('task-2');
      mockStore.taskOrder.push('task-2');
      mockStore.focusedPanel['task-1'] = split ? 'shell-toolbar:0' : 'prompt';
      navigateColumn('right');
      expect(mockStore.focusedPanel['task-1']).toBe('canvas');
      expect(mockStore.activeTaskId).toBe('task-1');
      navigateColumn('right');
      expect(mockStore.activeTaskId).toBe('task-2');
    });

    it('keeps down in the full-height canvas and moves up to the title', () => {
      mockStore.focusedPanel['task-1'] = 'canvas';
      navigateRow('down');
      expect(mockStore.focusedPanel['task-1']).toBe('canvas');
      navigateRow('up');
      expect(mockStore.focusedPanel['task-1']).toBe('title');
    });

    it('keeps vertical navigation in the main panels', () => {
      mockStore.focusedPanel['task-1'] = 'changed-files';
      navigateRow('down');
      expect(mockStore.focusedPanel['task-1']).toBe(split ? 'notes' : 'shell-toolbar:0');
    });

    it('includes restored tabs even without the explicit open flag', () => {
      setTask('task-1', { canvasTabs: [{ kind: 'markdown', path: 'README.md' }] });
      mockStore.focusedPanel['task-1'] = 'changed-files';
      navigateColumn('right');
      expect(mockStore.focusedPanel['task-1']).toBe('canvas');
    });

    it('skips a closed canvas and recovers stale canvas focus', () => {
      setTask('task-1');
      mockStore.focusedPanel['task-1'] = 'changed-files';
      navigateColumn('right');
      expect(mockStore.placeholderFocused).toBe(true);
      mockStore.placeholderFocused = false;
      mockStore.focusedPanel['task-1'] = 'canvas';
      navigateRow('up');
      expect(mockStore.focusedPanel['task-1']).not.toBe('canvas');
    });
  });

  it('moves down through stacked layout using explicit neighbors', () => {
    setTask('task-1');
    mockStore.focusedPanel['task-1'] = 'notes';

    navigateRow('down');

    expect(mockStore.focusedPanel['task-1']).toBe('shell-toolbar:0');
  });

  it('always enters the top-right panel when moving right from ai-terminal in split mode', () => {
    setTask('task-1');
    mockStore.taskSplitMode['task-1'] = true;
    mockStore.focusedPanel['task-1'] = 'ai-terminal';

    navigateColumn('right');

    expect(mockStore.focusedPanel['task-1']).toBe('changed-files');
  });

  it('falls into the top-right panel when split-mode ai-terminal has no lower left neighbor', () => {
    setTask('task-1', {
      shellAgentIds: ['shell-1'],
    });
    mockStore.taskSplitMode['task-1'] = true;
    mockStore.showPromptInput = false;
    mockStore.focusedPanel['task-1'] = 'ai-terminal';

    navigateRow('down');

    expect(mockStore.focusedPanel['task-1']).toBe('changed-files');
  });

  it('falls back from vanished focused panels before navigating', () => {
    setTask('task-1');
    mockStore.focusedPanel['task-1'] = 'removed-panel';

    navigateRow('down');

    expect(mockStore.focusedPanel['task-1']).toBe('prompt');
  });

  it('preserves cross-task row alignment when exiting to the right', () => {
    setTask('task-1');
    setTask('task-2');
    mockStore.taskOrder = ['task-1', 'task-2'];
    mockStore.focusedPanel['task-1'] = 'changed-files';

    navigateColumn('right');

    expect(mockStore.activeTaskId).toBe('task-2');
    expect(mockStore.focusedPanel['task-2']).toBe('notes');
  });

  it('enters the leftmost task when moving right from the sidebar, ignoring the highlighted task', () => {
    setTask('task-1');
    setTask('task-2');
    setTask('task-3');
    mockStore.taskOrder = ['task-1', 'task-2', 'task-3'];
    mockStore.activeTaskId = 'task-2';
    mockStore.sidebarFocused = true;
    mockStore.sidebarFocusedTaskId = 'task-3';

    navigateColumn('right');

    expect(mockStore.activeTaskId).toBe('task-1');
    expect(mockStore.sidebarFocused).toBe(false);
    expect(mockStore.focusedPanel['task-1']).toBe('ai-terminal:agent-1');
  });

  it('clamps split shell-toolbar down-moves to the last available shell', () => {
    setTask('task-1', {
      shellAgentIds: ['shell-1'],
    });
    mockStore.projects[0].terminalBookmarks = [
      { id: 'bookmark-1', command: 'npm test' },
      { id: 'bookmark-2', command: 'npm run lint' },
    ];
    mockStore.taskSplitMode['task-1'] = true;
    mockStore.focusedPanel['task-1'] = 'shell-toolbar:2';

    navigateRow('down');

    expect(mockStore.focusedPanel['task-1']).toBe('shell:0');
  });
});

describe('setPendingAction', () => {
  it('shows feedback instead of queuing finish for a direct task', () => {
    setTask('task-1', { gitIsolation: 'direct' });

    setPendingAction({ type: 'finish', taskId: 'task-1' });

    expect(showNotification).toHaveBeenCalledWith('Finish is only available for worktree tasks');
    expect(mockStore.pendingAction).toBeNull();
  });

  it('queues git actions for worktree tasks', () => {
    setTask('task-1', { gitIsolation: 'worktree' });

    setPendingAction({ type: 'finish', taskId: 'task-1' });

    expect(showNotification).not.toHaveBeenCalled();
    expect(mockStore.pendingAction).toEqual({ type: 'finish', taskId: 'task-1' });
  });
});

describe('scrollTaskElementIntoView', () => {
  it('reveals the focused canvas instead of aligning the whole task to its left edge', () => {
    setTask('task-1');
    const canvas = { scrollIntoView: vi.fn() };
    const task = { querySelector: vi.fn(() => canvas), scrollIntoView: vi.fn() };
    vi.stubGlobal('document', { querySelector: () => task });

    setTaskFocusedPanel('task-1', 'canvas');

    expect(task.querySelector).toHaveBeenCalledWith('.task-canvas-panel');
    expect(canvas.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    });
    expect(task.scrollIntoView).not.toHaveBeenCalled();
  });

  function createScroller(
    overrides: Partial<HTMLElement> & { taskEls?: HTMLElement[] } = {},
  ): HTMLElement {
    const { taskEls = [], ...rest } = overrides;
    return {
      scrollLeft: 200,
      clientWidth: 300,
      scrollWidth: 1_000,
      getBoundingClientRect: vi.fn(function (this: HTMLElement) {
        return { left: 0, right: this.clientWidth };
      }),
      scrollTo: vi.fn(),
      querySelectorAll: vi.fn(() => taskEls),
      ...rest,
    } as unknown as HTMLElement;
  }

  function createItem(overrides: Partial<HTMLElement> & { left?: number } = {}): HTMLElement {
    const { left = 0, ...rest } = overrides;
    return {
      offsetWidth: 100,
      getBoundingClientRect: vi.fn(function (this: HTMLElement) {
        return { left, right: left + this.offsetWidth };
      }),
      scrollIntoView: vi.fn(),
      ...rest,
    } as unknown as HTMLElement;
  }

  it('delegates normal tasks to native scrollIntoView, scrolling only the strip', () => {
    const scroller = createScroller();
    const el = createItem();

    scrollTaskElementIntoView(scroller, el);

    expect(el.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'instant',
    });
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });

  it('passes the requested behavior through to scrollIntoView', () => {
    const scroller = createScroller();
    const el = createItem();

    scrollTaskElementIntoView(scroller, el, 'smooth');

    expect(el.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    });
  });

  it('falls back to native scrollIntoView when there is no strip scroller', () => {
    const el = createItem();

    scrollTaskElementIntoView(null, el, 'smooth');

    expect(el.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    });
  });

  it('pins a very wide task to the left preview boundary instead of native nearest', () => {
    const scroller = createScroller();
    // clientWidth 300 - 2*64 = 172 available; a 400px-wide task overflows it.
    const el = createItem({ offsetWidth: 400, left: 250 });

    scrollTaskElementIntoView(scroller, el);

    // scrollLeft 200 + (itemLeft 250 - scrollerLeft 0) - 64 preview = 386.
    expect(scroller.scrollTo).toHaveBeenCalledWith({ left: 386, behavior: 'instant' });
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });

  it('clamps the very-wide-task target to the available scroll range', () => {
    const scroller = createScroller();
    const el = createItem({ offsetWidth: 400, left: 900 });

    scrollTaskElementIntoView(scroller, el);

    // 200 + 900 - 64 = 1036, clamped to scrollWidth - clientWidth = 700.
    expect(scroller.scrollTo).toHaveBeenCalledWith({ left: 700, behavior: 'instant' });
  });

  it('snaps the last task flush to the right edge of the strip', () => {
    const el = createItem();
    const scroller = createScroller({ taskEls: [el] });

    scrollTaskElementIntoView(scroller, el);

    expect(scroller.scrollTo).toHaveBeenCalledWith({
      left: scroller.scrollWidth - scroller.clientWidth,
      behavior: 'instant',
    });
    expect(el.scrollIntoView).not.toHaveBeenCalled();
  });

  it('passes the requested behavior through when snapping the last task', () => {
    const el = createItem();
    const scroller = createScroller({ taskEls: [el] });

    scrollTaskElementIntoView(scroller, el, 'smooth');

    expect(scroller.scrollTo).toHaveBeenCalledWith({
      left: scroller.scrollWidth - scroller.clientWidth,
      behavior: 'smooth',
    });
  });

  it('smooth-scrolls via native scrollIntoView when focusing a panel in a task', () => {
    setTask('task-1');
    setTask('task-2');
    mockStore.taskOrder = ['task-1', 'task-2'];
    mockStore.activeTaskId = 'task-2';
    const scroller = createScroller();
    const el = createItem({ closest: vi.fn(() => scroller) } as Partial<HTMLElement>);
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => el),
    });

    setTaskFocusedPanel('task-2', 'ai-terminal');

    expect(el.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'smooth',
    });
  });
});
