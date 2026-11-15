import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../store/types';
import { TaskShellSection, resetBookmarkExpansionForTest } from './TaskShellSection';
import { editAsDocument } from '../documents/store';
import {
  store,
  updateProject,
  runBookmarkInTask,
  spawnShellForTask,
  registerFocusFn,
} from '../store/store';
import { IPC } from '../../electron/ipc/channels';
import type { FileLinkMenu } from './file-link-menu';

const { terminalProps, setShellLayoutOverride, invoke } = vi.hoisted(() => ({
  terminalProps: [] as Record<string, unknown>[],
  setShellLayoutOverride: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('../store/store', () => ({
  store: {
    focusMode: false,
    taskSplitMode: {},
    documentWorkspacesEnabled: true,
    shellLayoutOverride: null,
    taskShellAutoLayout: {},
  },
  getProject: () => ({
    terminalBookmarks: [
      { id: 'test', command: 'npm test' },
      { id: 'typecheck', command: 'npm run typecheck' },
    ],
  }),
  spawnShellForTask: vi.fn(),
  runBookmarkInTask: vi.fn(),
  updateProject: vi.fn(),
  closeShell: vi.fn(),
  markAgentOutput: vi.fn(),
  clearAgentActivity: vi.fn(),
  refreshTaskStatus: vi.fn(),
  registerFocusFn: vi.fn(),
  unregisterFocusFn: vi.fn(),
  setActiveTask: vi.fn(),
  setTaskFocusedPanel: vi.fn(),
  shellPanelId: (index: number) => `shell:${index}`,
  isPanelFocused: () => false,
  isPanelFocusedPrefix: () => false,
  getTaskShellLayout: () => store.shellLayoutOverride ?? 'row',
  setTaskShellAutoLayout: vi.fn(),
  setShellLayoutOverride,
}));

vi.mock('./TerminalView', () => ({
  TerminalView: (props: Record<string, unknown>) => {
    terminalProps.push(props);
    return null;
  },
}));
vi.mock('../documents/store', () => ({ editAsDocument: vi.fn() }));
vi.mock('../lib/ipc', () => ({ invoke }));

const disposers: Array<() => void> = [];

afterEach(() => {
  store.taskSplitMode = {};
  store.shellLayoutOverride = null;
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  terminalProps.length = 0;
  vi.clearAllMocks();
  resetBookmarkExpansionForTest();
});

function makeTask(shellAgentIds: string[] = []): Task {
  return {
    id: 'task-1',
    name: 'Task',
    projectId: 'project-1',
    branchName: 'task/bookmarks',
    worktreePath: '/tmp/task',
    agentIds: [],
    shellAgentIds,
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
  };
}

function bookmarksToggle(): HTMLButtonElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('.shell-toolbar-panel button[aria-controls]'),
  ).find((button) => button.textContent?.startsWith('Bookmarks'));
}

describe('TaskShellSection', () => {
  function openCommandForm() {
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(render(() => <TaskShellSection task={makeTask()} isActive />, container));
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Add command bookmark"]',
    );
    trigger?.click();
    const form = document.querySelector<HTMLFormElement>('form[aria-label="Add command bookmark"]');
    const input = form?.querySelector('input');
    if (!trigger || !form || !input) throw new Error('Command form did not open');
    return { trigger, form, input };
  }

  it('saves a project command without running it and preserves existing bookmarks', async () => {
    const { trigger, form, input } = openCommandForm();
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    expect(form.textContent).toContain('Saved for all tasks in this project.');
    input.value = '  npm run dev  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    // Enter in the single text input submits the form in the browser.
    form.requestSubmit();

    expect(updateProject).toHaveBeenCalledExactlyOnceWith('project-1', {
      terminalBookmarks: [
        { id: 'test', command: 'npm test' },
        { id: 'typecheck', command: 'npm run typecheck' },
        { id: expect.any(String), command: 'npm run dev' },
      ],
    });
    expect(runBookmarkInTask).not.toHaveBeenCalled();
    expect(spawnShellForTask).not.toHaveBeenCalled();
    expect(form.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(bookmarksToggle()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('does not save a duplicate of an existing command', () => {
    const { form, input } = openCommandForm();
    input.value = 'npm test';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();

    expect(updateProject).not.toHaveBeenCalled();
    expect(form.isConnected).toBe(false);
    expect(bookmarksToggle()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the draft open when the window loses focus', async () => {
    const { form, input } = openCommandForm();
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    expect(form.isConnected).toBe(true);

    const outside = document.createElement('button');
    document.body.append(outside);
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
    expect(form.isConnected).toBe(false);
  });

  it('rejects blank commands and dismisses with Escape or an outside click', async () => {
    const { trigger, form, input } = openCommandForm();
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    input.value = '   ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(form.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(updateProject).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(form.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);

    trigger.click();
    expect(document.querySelector('form[aria-label="Add command bookmark"]')).not.toBeNull();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('form[aria-label="Add command bookmark"]')).toBeNull();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('lets a Markdown path printed in a shell be edited as a document', () => {
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(() => <TaskShellSection task={makeTask(['shell-1'])} isActive />, container),
    );

    expect(terminalProps[0]?.onEditAsDocument).toBe(editAsDocument);
  });

  it('offers a clicked shell file link the side panel and the Markdown dialog', async () => {
    invoke.mockResolvedValue('# Plan');
    const onOpenInSidePanel = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => (
          <TaskShellSection
            task={makeTask(['shell-1'])}
            isActive
            onOpenInSidePanel={onOpenInSidePanel}
          />
        ),
        container,
      ),
    );
    const fileLinkMenu = terminalProps[0]?.fileLinkMenu as (
      filePath: string,
      line?: number,
    ) => FileLinkMenu;
    const menu = fileLinkMenu('/tmp/task/docs/plan.md');

    menu.actions.find((a) => a.label === 'Open in side panel')?.run();
    expect(onOpenInSidePanel).toHaveBeenCalledWith('docs/plan.md');
    menu.open?.();
    expect(invoke).toHaveBeenCalledWith(IPC.ReadFileText, { filePath: '/tmp/task/docs/plan.md' });
    await vi.waitFor(() => expect(document.body.textContent).toContain('plan.md'));

    invoke.mockResolvedValueOnce(true);
    const findBareFile = terminalProps[0]?.findBareFile as (name: string) => Promise<unknown>;
    await expect(findBareFile('plan.md')).resolves.toBe('/tmp/task/plan.md');
    expect(invoke).toHaveBeenLastCalledWith(IPC.CheckPathExists, { path: '/tmp/task/plan.md' });
  });

  it('keeps terminal bookmark buttons at their natural width in a horizontally scrollable toolbar', () => {
    const task = makeTask();
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(render(() => <TaskShellSection task={task} isActive />, container));

    const toolbar = container.querySelector<HTMLElement>('.shell-toolbar-panel');
    const buttons = container.querySelectorAll<HTMLElement>(
      '.shell-toolbar-panel > button:not([aria-expanded]), .shell-toolbar-panel [role="group"] > button',
    );

    expect(toolbar?.style.overflowX).toBe('auto');
    expect(toolbar?.style.overflowY).toBe('hidden');
    expect(Array.from(buttons, (button) => button.style.flexShrink)).toEqual(['0', '0', '0']);
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Open terminal');
    expect(buttons[0]?.nextElementSibling?.getAttribute('aria-label')).toBe('Add command bookmark');
  });

  it('collapses saved commands by default and reveals them for keyboard navigation', () => {
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(render(() => <TaskShellSection task={makeTask()} isActive />, container));
    const toggle = bookmarksToggle();
    const group = container.querySelector<HTMLElement>(
      '[role="group"][aria-label="Command bookmarks"]',
    );
    const toolbar = container.querySelector<HTMLElement>('.shell-toolbar-panel');

    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(group?.style.display).toBe('none');
    toggle?.click();
    expect(group?.style.display).toBe('flex');
    group?.querySelector<HTMLButtonElement>('[title="npm test"]')?.click();
    expect(runBookmarkInTask).toHaveBeenCalledExactlyOnceWith('task-1', 'npm test');
    toggle?.click();
    expect(group?.style.display).toBe('none');

    toolbar?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    toggle?.click();
    toolbar?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(spawnShellForTask).toHaveBeenCalledExactlyOnceWith('task-1');
    expect(runBookmarkInTask).toHaveBeenCalledTimes(1);

    const focusBookmark = vi
      .mocked(registerFocusFn)
      .mock.calls.find(([key]) => key === 'task-1:shell-toolbar:2')?.[1];
    expect(focusBookmark).toBeDefined();
    focusBookmark?.();
    expect(group?.style.display).toBe('flex');
  });

  it('keeps bookmarks expanded for the project across remounts', () => {
    const first = document.createElement('div');
    document.body.append(first);
    const disposeFirst = render(() => <TaskShellSection task={makeTask()} isActive />, first);
    bookmarksToggle()?.click();
    disposeFirst();
    first.remove();

    const second = document.createElement('div');
    document.body.append(second);
    disposers.push(render(() => <TaskShellSection task={makeTask()} isActive />, second));
    expect(bookmarksToggle()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('collapsing in one task deselects a hidden bookmark in another task of the project', () => {
    const containers = ['task-1', 'task-2'].map((id) => {
      const container = document.createElement('div');
      document.body.append(container);
      const task = { ...makeTask(), id };
      disposers.push(render(() => <TaskShellSection task={task} isActive />, container));
      return container;
    });
    const toolbarB = containers[1]?.querySelector<HTMLElement>('.shell-toolbar-panel');
    const toggleA = containers[0]?.querySelector<HTMLButtonElement>('button[aria-controls]');

    toolbarB?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(toggleA?.getAttribute('aria-expanded')).toBe('true');
    toggleA?.click();
    toolbarB?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(runBookmarkInTask).not.toHaveBeenCalled();
    expect(spawnShellForTask).toHaveBeenCalledExactlyOnceWith('task-2');
  });

  it('lets a split-column shell fill its wrapper outside focus mode', () => {
    store.focusMode = false;
    store.taskSplitMode = { 'task-1': true };
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(() => <TaskShellSection task={makeTask(['shell-1'])} isActive />, container),
    );

    expect((container.firstElementChild as HTMLElement).style.minHeight).toBe('0');
  });

  it('offers the layout menu only once two shells are open', () => {
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(() => <TaskShellSection task={makeTask(['shell-1'])} isActive />, container),
    );

    expect(container.querySelector('.shell-layout-button')).toBeNull();
  });

  it('stacks shells in one column when Column is pinned', () => {
    store.shellLayoutOverride = 'column';
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => <TaskShellSection task={makeTask(['shell-1', 'shell-2'])} isActive />,
        container,
      ),
    );

    const area = container.querySelector<HTMLElement>('.shell-terminals-row');
    expect(area?.style.gridTemplateColumns).toBe('repeat(1, minmax(0, 1fr))');
    const button = container.querySelector('.shell-layout-button');
    expect(button?.getAttribute('aria-label')).toBe('Terminal layout: Column');
  });

  it('pins a layout from the menu and returns to automatic', () => {
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => <TaskShellSection task={makeTask(['shell-1', 'shell-2'])} isActive />,
        container,
      ),
    );
    const choose = (label: string) => {
      container.querySelector<HTMLButtonElement>('.shell-layout-button')?.click();
      const items = document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
      Array.from(items)
        .find((item) => item.textContent === label)
        ?.click();
    };

    choose('Square grid');
    expect(setShellLayoutOverride).toHaveBeenLastCalledWith('grid');

    choose('Automatic (Row)');
    expect(setShellLayoutOverride).toHaveBeenLastCalledWith(null);
  });
});
