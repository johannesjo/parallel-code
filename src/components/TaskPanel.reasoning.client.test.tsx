import { expectDefined } from '../store/test-helpers';
import { createSignal, type ComponentProps } from 'solid-js';
import { render } from 'solid-js/web';
import { createStore } from 'solid-js/store';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskPanel } from './TaskPanel';
import {
  openCanvasReasoning,
  openCanvasMindMap,
  activateCanvasTab,
  toggleFocusMode,
} from '../store/store';
import type { Task } from '../store/types';
import type { DiffViewerDialog } from './DiffViewerDialog';

vi.mock('../store/store', () => {
  const [store, setStore] = createStore({
    activeTaskId: 'other-task',
    focusMode: false,
    focusedPanel: { task: 'prompt' },
    showPromptInput: true,
    taskGitStatus: {},
    taskViewportVisibility: {},
  });
  return {
    store,
    getProject: () => undefined,
    isPanelFocused: () => false,
    openCanvasReasoning: vi.fn(),
    openCanvasMindMap: vi.fn(),
    openCanvasBrowser: vi.fn(),
    showNotification: vi.fn(),
    registerAction: vi.fn(),
    unregisterAction: vi.fn(),
    activateCanvasTab: vi.fn(),
    isTaskCanvasVisible: () => true,
    getPanelUserSize: () => undefined,
    deletePanelUserSize: vi.fn(),
    setPanelUserSize: vi.fn(),
    setTaskSplitMode: vi.fn(),
    registerFocusFn: vi.fn(),
    unregisterFocusFn: vi.fn(),
    setActiveAgent: vi.fn(),
    setTaskFocusedPanel: vi.fn(),
    triggerFocus: vi.fn(),
    setActiveTask: (id: string) => setStore('activeTaskId', id),
    activateTaskFromPointer: (id: string) => setStore('activeTaskId', id),
    toggleFocusMode: (on?: boolean) => setStore('focusMode', on ?? !store.focusMode),
  };
});
vi.mock('../lib/theme', () => ({ theme: {} }));
vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('./TaskAITerminal', () => ({
  TaskAITerminal: (props: { onReview?: (path?: string) => void }) => (
    <div class="test-terminal">
      Scrollback
      <button
        class="test-chat-review"
        disabled={!props.onReview}
        onClick={() => props.onReview?.()}
      >
        Review
      </button>
      <button class="test-chat-review-file" onClick={() => props.onReview?.('src/app.ts')}>
        Review file
      </button>
    </div>
  ),
}));
vi.mock('./PromptInput', () => ({
  PromptInput: () => <textarea class="test-prompt" value="Draft" />,
}));
vi.mock('./CloseTaskDialog', () => ({ CloseTaskDialog: () => null }));
vi.mock('./MergeDialog', () => ({ MergeDialog: () => null }));
vi.mock('./PushDialog', () => ({ PushDialog: () => null }));
vi.mock('./DiffViewerDialog', () => ({
  DiffViewerDialog: (props: ComponentProps<typeof DiffViewerDialog>) => (
    <div
      class="test-diff"
      data-open={props.scrollToFile !== null}
      data-file={props.scrollToFile}
      data-commit={props.selectedCommit ?? 'all'}
    >
      <button class="test-diff-select" onClick={() => props.onCommitNavigate?.('old-commit')}>
        Select commit
      </button>
      <button class="test-diff-close" onClick={() => props.onClose()}>
        Close
      </button>
    </div>
  ),
}));
vi.mock('./PlanViewerDialog', () => ({ PlanViewerDialog: () => null }));
vi.mock('./EditProjectDialog', () => ({ EditProjectDialog: () => null }));
vi.mock('./TaskTitleBar', () => ({ TaskTitleBar: () => null }));
vi.mock('./TaskBranchInfoBar', () => ({ TaskBranchInfoBar: () => null }));
vi.mock('./TaskBranchAdoptionBanner', () => ({ TaskBranchAdoptionBanner: () => null }));
vi.mock('./TaskNotesBody', () => ({ TaskNotesBody: () => <textarea class="test-notes" /> }));
vi.mock('./TaskChangedFilesSection', () => ({ TaskChangedFilesSection: () => null }));
vi.mock('./TaskShellSection', () => ({ TaskShellSection: () => null }));
vi.mock('./CanvasFilePicker', () => ({ CanvasFilePicker: () => null }));
vi.mock('./TaskCanvasDocument', () => ({
  TaskCanvasDocument: () => <textarea class="test-canvas" />,
}));
vi.mock('./ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('./TaskStepsSection', () => ({ TaskStepsSection: () => null }));
vi.mock('./TaskCurrentStateLine', () => ({ TaskCurrentStateLine: () => null }));
vi.mock('./TaskClosingOverlay', () => ({ TaskClosingOverlay: () => null }));
vi.mock('./SubTaskStrip', () => ({ SubTaskStrip: () => null }));
vi.mock('./TaskReasoningGraphHost', () => ({
  TaskReasoningGraphHost: () => <textarea class="test-graph" />,
}));

let dispose: (() => void) | undefined;
afterEach(() => {
  toggleFocusMode(false);
  dispose?.();
  document.body.replaceChildren();
});

it.each([undefined, 'landed_pending_review'] as const)(
  'opens chat review for active and landed tasks (%s) and resets stale commit filters',
  (landingState) => {
    const task: Task = {
      id: 'task',
      name: 'Task',
      projectId: 'project',
      agentIds: [],
      shellAgentIds: [],
      notes: '',
      gitIsolation: 'worktree',
      branchName: 'task-branch',
      worktreePath: '/tmp/task',
      lastPrompt: '',
      landingState,
    };
    const container = document.createElement('div');
    document.body.append(container);
    dispose = render(() => <TaskPanel task={task} isActive />, container);
    const click = (selector: string) =>
      expectDefined(container.querySelector<HTMLButtonElement>(selector)).click();
    const diff = () => expectDefined(container.querySelector<HTMLElement>('.test-diff'));
    click('.test-chat-review');
    expect(diff().dataset.open).toBe('true');
    expect(diff().dataset.commit).toBe('all');
    click('.test-diff-select');
    expect(diff().dataset.commit).toBe('old-commit');
    click('.test-diff-close');
    expect(diff().dataset.open).toBe('false');
    click('.test-chat-review-file');
    expect(diff().dataset.open).toBe('true');
    expect(diff().dataset.file).toBe('src/app.ts');
    expect(diff().dataset.commit).toBe('all');
  },
);

it.each(['reasoning', 'mindmap'] as const)(
  'gives the %s canvas the larger share in focus mode and keeps every pane',
  (kind) => {
    const [task, setTask] = createStore<Task>({
      id: 'task',
      name: 'Task',
      projectId: 'project',
      agentIds: ['agent'],
      shellAgentIds: [],
      notes: '',
      gitIsolation: 'none',
      branchName: '',
      worktreePath: '/tmp/task',
      lastPrompt: '',
      canvasOpen: true,
      canvasTabs: [{ kind: 'markdown', path: 'notes.md' }],
      canvasActiveTab: 'markdown:notes.md',
    });
    vi.mocked(kind === 'reasoning' ? openCanvasReasoning : openCanvasMindMap).mockImplementation(
      () =>
        setTask({
          canvasTabs: [{ kind: 'markdown', path: 'notes.md' }, { kind }],
          canvasActiveTab: kind,
        }),
    );
    vi.mocked(activateCanvasTab).mockImplementation((_, key) => setTask('canvasActiveTab', key));
    const container = document.createElement('div');
    container.className = 'task-workspace';
    const code = document.createElement('div');
    code.className = 'task-workspace-code';
    container.append(code);
    document.body.append(container);
    const [active, setActive] = createSignal(true);
    dispose = render(() => <TaskPanel task={task} isActive={active()} />, code);
    const terminal = container.querySelector('.test-terminal');
    const prompt = expectDefined(container.querySelector<HTMLTextAreaElement>('.test-prompt'));
    expect(terminal).not.toBeNull();
    prompt.value = 'Draft';
    const notes = expectDefined(container.querySelector<HTMLTextAreaElement>('.test-notes'));
    const canvas = expectDefined(container.querySelector<HTMLTextAreaElement>('.test-canvas'));
    notes.value = 'Unsaved notes';
    canvas.value = 'Unsaved Markdown';
    expectDefined(
      container.querySelector<HTMLButtonElement>('[title="Open another canvas"]'),
    ).click();
    expectDefined(
      [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (button) => button.textContent === (kind === 'reasoning' ? 'Reasoning' : 'Mind map'),
      ),
    ).click();
    const graphSelector = kind === 'reasoning' ? '.test-graph' : '.mindmap-editor';
    const graph = expectDefined(
      container.querySelector<HTMLTextAreaElement>(`.task-canvas-reasoning ${graphSelector}`),
    );
    graph.value = 'Held graph state';
    const canvasCell = expectDefined(graph.closest<HTMLElement>('.rp-cell'));
    const mainCell = expectDefined(
      canvasCell.parentElement?.querySelector<HTMLElement>(':scope > .rp-cell'),
    );
    expect(mainCell).not.toBe(canvasCell);
    expect(canvasCell.style.flexGrow).toBe('0');
    for (let visit = 0; visit < 3; visit++) {
      toggleFocusMode(true);
      expect(canvasCell.style.flexGrow).toBe('2');
      expect(mainCell.style.flexGrow).toBe('1');
      expect(container.querySelector(`.task-canvas-reasoning ${graphSelector}`)).toBe(graph);
      expect(container.querySelector('.test-terminal')).toBe(terminal);
      expect(container.querySelector('.test-prompt')).toBe(prompt);
      prompt.value = 'Edited draft';
      toggleFocusMode(false);
      expect(canvasCell.style.flexGrow).toBe('0');
      expect(container.querySelector('.test-terminal')).toBe(terminal);
      expect(container.querySelector('.test-prompt')).toBe(prompt);
      expect(prompt.value).toBe('Edited draft');
      expect(container.querySelector(`.task-canvas-reasoning ${graphSelector}`)).toBe(graph);
      expect(graph.value).toBe('Held graph state');
      expect(container.querySelector('.test-notes')).toBe(notes);
      expect(container.querySelector('.test-canvas')).toBe(canvas);
      expect(notes.value).toBe('Unsaved notes');
      expect(canvas.value).toBe('Unsaved Markdown');
    }
    // Only the active tile is the whole window; a hidden one keeps its side-panel split.
    toggleFocusMode(true);
    setActive(false);
    expect(canvasCell.style.flexGrow).toBe('0');
    setActive(true);
    expect(canvasCell.style.flexGrow).toBe('2');
    toggleFocusMode(false);
  },
);
