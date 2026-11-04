import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../store/types';
import { TaskShellSection } from './TaskShellSection';
import { editAsDocument } from '../documents/store';
import { store } from '../store/store';
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

describe('TaskShellSection', () => {
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
    const buttons = container.querySelectorAll<HTMLElement>('.shell-toolbar-panel > button');

    expect(toolbar?.style.overflowX).toBe('auto');
    expect(toolbar?.style.overflowY).toBe('hidden');
    expect(Array.from(buttons, (button) => button.style.flexShrink)).toEqual(['0', '0', '0']);
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
