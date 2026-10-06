import { expectDefined } from '../store/test-helpers';
import { For, Show, createEffect, createSignal, onCleanup, type ComponentProps } from 'solid-js';
import { render } from 'solid-js/web';
import { createStore } from 'solid-js/store';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskPanel } from './TaskPanel';
import { IPC } from '../../electron/ipc/channels';
import type { CommitInfo } from '../ipc/types';
import { invoke } from '../lib/ipc';
import {
  openCanvasReasoning,
  openCanvasMindMap,
  activateCanvasTab,
  showNotification,
  toggleFocusMode,
  setTaskFocusedPanel,
} from '../store/store';
import { GIST_LABEL } from '../lib/understanding-tour';
import type { Task } from '../store/types';
import type { FinishDialog } from './FinishDialog';
import { UNCOMMITTED_SELECTION } from './CommitNavBar';
import type { DiffViewerDialog } from './DiffViewerDialog';
import type { TaskNotesBody } from './TaskNotesBody';
import type { UnderstandingTourDialog } from './UnderstandingTourDialog';

// Understanding tours stream through Channel, so the panel's ipc mock provides one.
const fileInventory = vi.hoisted(() => ({
  report: (_count: number) => {},
  mounts: 0,
  disposals: 0,
}));

const channels = vi.hoisted(
  () =>
    [] as {
      onmessage: ((message: { type: string; text?: string; exitCode?: number }) => void) | null;
      dispose: () => void;
    }[],
);

vi.mock('../store/store', () => {
  const [store, setStore] = createStore({
    activeTaskId: 'other-task',
    focusMode: false,
    themePreset: 'obsidian',
    showPlans: true,
    focusedPanel: { task: 'prompt' },
    showPromptInput: true,
    taskGitStatus: {},
    taskViewportVisibility: {},
    askCodeProvider: 'minimax',
    agentEnvFiles: {},
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
    setTaskFocusedPanel: vi.fn((_taskId: string, panel: string) =>
      setStore('focusedPanel', 'task', panel),
    ),
    triggerFocus: vi.fn(),
    setActiveTask: (id: string) => setStore('activeTaskId', id),
    activateTaskFromPointer: (id: string) => setStore('activeTaskId', id),
    toggleFocusMode: (on?: boolean) => setStore('focusMode', on ?? !store.focusMode),
  };
});
vi.mock('../lib/theme', () => ({ theme: {} }));
vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
  Channel: class {
    onmessage = null;
    dispose = vi.fn();
    constructor() {
      channels.push(this);
    }
  },
}));
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
vi.mock('./FinishDialog', () => ({
  FinishDialog: (props: ComponentProps<typeof FinishDialog>) => (
    <Show when={props.open}>
      <button
        class="test-evidence-review"
        onClick={() => {
          props.onClose();
          props.onDiffFileClick({
            path: 'src/earlier.ts',
            status: 'M',
            lines_added: 1,
            lines_removed: 0,
            committed: true,
          });
        }}
      >
        Review evidence file
      </button>
    </Show>
  ),
}));
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
      <button
        class="test-diff-uncommitted"
        onClick={() => props.onCommitNavigate?.(UNCOMMITTED_SELECTION)}
      >
        Select uncommitted changes
      </button>
      <button class="test-diff-close" onClick={() => props.onClose()}>
        Close
      </button>
    </div>
  ),
}));
vi.mock('./PlanViewerDialog', () => ({ PlanViewerDialog: () => null }));
vi.mock('./EditProjectDialog', () => ({ EditProjectDialog: () => null }));
vi.mock('./TaskTitleBar', () => ({
  TaskTitleBar: (props: { onFinish: () => void }) => (
    <button class="test-finish-open" onClick={() => props.onFinish()}>
      Finish
    </button>
  ),
}));
vi.mock('./TaskBranchInfoBar', () => ({ TaskBranchInfoBar: () => null }));
vi.mock('./TaskBranchAdoptionBanner', () => ({ TaskBranchAdoptionBanner: () => null }));
vi.mock('./TaskSuperProductivityBanner', () => ({ TaskSuperProductivityBanner: () => null }));
vi.mock('./TaskNotesBody', () => ({
  TaskNotesBody: (props: ComponentProps<typeof TaskNotesBody>) => (
    <div>
      <textarea class="test-notes" />
      <button class="test-plan-tour" onClick={() => props.onPlanTour()}>
        Take Tour
      </button>
      <Show when={props.task.agentTour}>
        <button class="test-agent-tour" onClick={() => props.onAgentTour?.()}>
          Agent Tour
        </button>
      </Show>
    </div>
  ),
}));
vi.mock('./UnderstandingTourDialog', () => ({
  UnderstandingTourDialog: (props: ComponentProps<typeof UnderstandingTourDialog>) => (
    <div
      class="test-understanding"
      data-open={props.open}
      data-subject={props.tour.subject()}
      data-kind={props.tour.kind() ?? ''}
      data-gist={props.tour.tour()?.cards[props.tour.step()]?.title ?? ''}
    >
      <button class="test-understanding-close" onClick={() => props.onClose()}>
        Close
      </button>
    </div>
  ),
}));
vi.mock('./TaskChangedFilesSection', () => ({
  TaskChangedFilesSection: (props: {
    onFileCountChange?: (count: number) => void;
    commitList: CommitInfo[];
  }) => {
    fileInventory.mounts++;
    createEffect(() => {
      fileInventory.report = props.onFileCountChange ?? (() => {});
    });
    onCleanup(() => fileInventory.disposals++);
    return (
      <div class="test-files">
        <For each={props.commitList}>
          {(commit) => <span data-commit-hash={commit.hash}>{commit.message}</span>}
        </For>
      </div>
    );
  },
}));
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
  dispose?.();
  toggleFocusMode(false);
  setTaskFocusedPanel('task', 'prompt');
  document.body.replaceChildren();
  channels.length = 0;
  vi.mocked(showNotification).mockClear();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.useRealTimers();
});

const tourCard = (title: string, label = 'KEY DECISION') => ({
  label,
  title,
  body: 'Body text.',
  tone: 'neutral',
});
const TOUR_JSON = JSON.stringify({
  gist: tourCard('Gist title', GIST_LABEL),
  cards: [tourCard('One'), tourCard('Two')],
});

/** Drains the microtask queue the tour controller awaits. */
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function finishTourStream() {
  channels[0]?.onmessage?.({ type: 'chunk', text: TOUR_JSON });
  channels[0]?.onmessage?.({ type: 'done', exitCode: 0 });
}

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
      // Saved notes keep the support panel open; empty ones would collapse it.
      notes: 'Saved notes',
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

function mountPlanTask() {
  const [task, setTask] = createStore<Task>({
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
    planContent: '# Plan',
    planFileName: 'plan.md',
  });
  const container = document.createElement('div');
  document.body.append(container);
  dispose = render(() => <TaskPanel task={task} isActive />, container);
  return {
    setTask,
    container,
    // Collapsing a task unmounts its panel; expanding it mounts a fresh one.
    remount: () => {
      dispose?.();
      dispose = render(() => <TaskPanel task={task} isActive />, container);
    },
    click: (selector: string) =>
      expectDefined(container.querySelector<HTMLButtonElement>(selector)).click(),
    tourState: () =>
      expectDefined(container.querySelector<HTMLElement>('.test-understanding')).dataset,
  };
}

it('generates a plan tour in the background and opens it on the next click', async () => {
  const { click, tourState } = mountPlanTask();

  expect(tourState().subject).toBe('');
  expect(tourState().open).toBe('false');

  click('.test-plan-tour');
  await flush();
  // Generation runs behind the panel: the dialog stays closed.
  expect(tourState().subject).toBe('plan.md');
  expect(tourState().kind).toBe('plan');
  expect(tourState().open).toBe('false');
  expect(showNotification).not.toHaveBeenCalled();

  finishTourStream();
  await flush();
  expect(showNotification).toHaveBeenCalledWith('Tour ready: plan.md');
  expect(tourState().open).toBe('false');

  click('.test-plan-tour');
  expect(tourState().open).toBe('true');
});

it('reports a failed tour without opening the dialog', async () => {
  const { click, tourState } = mountPlanTask();

  click('.test-plan-tour');
  await flush();
  channels[0]?.onmessage?.({ type: 'chunk', text: 'not json' });
  channels[0]?.onmessage?.({ type: 'done', exitCode: 0 });
  await flush();

  expect(tourState().open).toBe('false');
  expect(vi.mocked(showNotification).mock.calls[0][0]).toContain('Tour failed:');
});

it('opens a tour the agent published and keeps it reachable after closing', () => {
  const card = { label: 'KEY DECISION', title: 'One idea', body: 'Body text.' };
  const payload = {
    subject: 'the retry bug',
    gist: { ...card, title: 'Retries hide the failure' },
    cards: [card],
    context: 'The agent read the retry loop.',
  };
  const { setTask, click, tourState, container } = mountPlanTask();

  expect(container.querySelector('.test-agent-tour')).toBeNull();
  setTask('agentTour', { revision: 1, payload });
  expect(tourState().open).toBe('true');
  expect(tourState().kind).toBe('agent');
  expect(tourState().subject).toBe('the retry bug');
  expect(tourState().gist).toBe('Retries hide the failure');
  // Publishing calls no provider, so nothing streams and nothing is notified as failed.
  expect(channels).toHaveLength(0);
  expect(showNotification).toHaveBeenCalledWith('Tour ready: the retry bug');

  click('.test-understanding-close');
  expect(tourState().open).toBe('false');
  click('.test-agent-tour');
  expect(tourState().open).toBe('true');
  expect(tourState().gist).toBe('Retries hide the failure');
});

it('does not reopen a dismissed agent tour when the panel remounts', () => {
  const card = { label: 'KEY DECISION', title: 'One idea', body: 'Body text.' };
  const payload = { subject: 'the retry bug', gist: card, cards: [card] };
  const { setTask, click, tourState, remount } = mountPlanTask();

  setTask('agentTour', { revision: 1, payload });
  expect(tourState().open).toBe('true');
  click('.test-understanding-close');

  remount();
  expect(tourState().open).toBe('false');

  setTask('agentTour', { revision: 2, payload });
  expect(tourState().open).toBe('true');
});

it('reports a published tour with a card the validator rejects', () => {
  const { setTask, tourState } = mountPlanTask();
  setTask('agentTour', {
    revision: 1,
    payload: {
      subject: 'the retry bug',
      gist: { label: 'GIST', title: 'Title', body: 'Body.' },
      cards: [{ label: 'KEY', title: 'One idea', body: '' }],
    },
  });
  expect(tourState().open).toBe('false');
  expect(vi.mocked(showNotification).mock.calls[0][0]).toContain('Tour rejected:');
});

// A plan tour survives diff navigation: its identity is the task, not the diff.
it('keeps a plan tour while browsing commits and drops it when the task changes', async () => {
  const { setTask, click, tourState } = mountPlanTask();

  click('.test-plan-tour');
  await flush();
  finishTourStream();
  await flush();
  click('.test-plan-tour');
  expect(tourState().subject).toBe('plan.md');
  expect(tourState().open).toBe('true');

  click('.test-diff-select');
  expect(tourState().subject).toBe('plan.md');
  expect(tourState().open).toBe('true');

  setTask('id', 'task-2');
  expect(tourState().subject).toBe('');
  expect(tourState().kind).toBe('');
  expect(tourState().open).toBe('false');
});

function mountEmptyTask() {
  const [task, setTask] = createStore<Task>({
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
  });
  const container = document.createElement('div');
  document.body.append(container);
  dispose = render(() => <TaskPanel task={task} isActive />, container);
  return { container, setTask };
}

it('preserves commit rows on unchanged polls and updates changed messages, order and length', async () => {
  vi.useFakeTimers();
  let commits: CommitInfo[] = [
    { hash: 'a', message: 'First' },
    { hash: 'b', message: 'Second' },
  ];
  vi.mocked(invoke).mockImplementation(async (cmd) =>
    cmd === IPC.GetBranchCommits ? commits.map((commit) => ({ ...commit })) : undefined,
  );
  const { container } = mountEmptyTask();
  await flush();
  const rows = () => [...container.querySelectorAll<HTMLElement>('[data-commit-hash]')];
  const initial = rows();
  expect(initial.map((row) => row.textContent)).toEqual(['First', 'Second']);

  await vi.advanceTimersByTimeAsync(5000);
  expect(rows()[0]).toBe(initial[0]);
  expect(rows()[1]).toBe(initial[1]);

  commits = [{ hash: 'a', message: 'Reworded' }, commits[1]];
  await vi.advanceTimersByTimeAsync(5000);
  expect(rows().map((row) => row.textContent)).toEqual(['Reworded', 'Second']);
  commits = [commits[1], commits[0]];
  await vi.advanceTimersByTimeAsync(5000);
  expect(rows().map((row) => row.dataset.commitHash)).toEqual(['b', 'a']);
  commits = [commits[0]];
  await vi.advanceTimersByTimeAsync(5000);
  expect(rows()).toHaveLength(1);
  commits = [{ hash: 'c', message: 'New hash' }];
  await vi.advanceTimersByTimeAsync(5000);
  expect(rows()[0].dataset.commitHash).toBe('c');
});

it('collapses empty support panels without disposing file watching or terminal state', () => {
  const mounts = fileInventory.mounts;
  const disposals = fileInventory.disposals;
  const { container } = mountEmptyTask();
  const terminal = expectDefined(container.querySelector('.test-terminal'));
  const prompt = expectDefined(container.querySelector<HTMLTextAreaElement>('.test-prompt'));
  prompt.value = 'Unsent prompt';
  const toggle = () =>
    expectDefined(container.querySelector<HTMLButtonElement>('.task-support-toggle'));
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('.test-notes')).toBeNull();
  expect(fileInventory.mounts).toBe(mounts + 1);
  expect(fileInventory.disposals).toBe(disposals);
  toggle().click();
  const notes = expectDefined(container.querySelector('.test-notes'));
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  toggle().click();
  expect(container.querySelector('.test-notes')).toBeNull();
  fileInventory.report(2);
  expect(container.querySelector('.test-notes')).toBe(notes);
  expect(container.querySelector('.test-files')).not.toBeNull();
  expect(container.querySelector('.task-support-toggle')).toBeNull();
  expect(container.querySelector('.test-terminal')).toBe(terminal);
  expect(container.querySelector('.test-prompt')).toBe(prompt);
  expect(prompt.value).toBe('Unsent prompt');
  expect(fileInventory.mounts).toBe(mounts + 1);
  expect(fileInventory.disposals).toBe(disposals);
});

it.each(['notes', 'changed-files'])(
  'reveals compact support when keyboard navigation targets %s',
  (panel) => {
    const { container } = mountEmptyTask();
    expect(container.querySelector('.test-notes')).toBeNull();
    setTaskFocusedPanel('task', panel);
    expect(container.querySelector('.test-notes')).not.toBeNull();
    expect(container.querySelector('.task-support-toggle')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
  },
);

it('keeps plans, steps and shells visible even with no notes or files', () => {
  const { container, setTask } = mountEmptyTask();
  const isCollapsed = () =>
    container.querySelector('.task-support-toggle')?.getAttribute('aria-expanded') === 'false';
  expect(isCollapsed()).toBe(true);
  setTask('planContent', '# Plan');
  expect(isCollapsed()).toBe(false);
  expect(container.querySelector('.test-notes')).not.toBeNull();
  setTask('planContent', undefined);
  expect(isCollapsed()).toBe(true);
  setTask('stepsEnabled', true);
  expect(isCollapsed()).toBe(false);
  setTask('stepsEnabled', false);
  setTask('shellAgentIds', ['shell']);
  expect(isCollapsed()).toBe(false);
  setTask('shellAgentIds', []);
  expect(isCollapsed()).toBe(true);
});

it('keeps prompt focus when incoming files reopen the supporting column', async () => {
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  try {
    toggleFocusMode(true);
    const { container } = mountEmptyTask();
    const prompt = expectDefined(container.querySelector<HTMLTextAreaElement>('.test-prompt'));
    prompt.value = 'Keep typing';
    prompt.focus();
    fileInventory.report(1);
    await flush();
    expect(document.activeElement).toBe(prompt);
    expect(prompt.value).toBe('Keep typing');
    expect(container.querySelector('.test-files')).not.toBeNull();
  } finally {
    width.mockRestore();
  }
});

it.each([
  ['.test-diff-select', 'old-commit'],
  ['.test-diff-uncommitted', UNCOMMITTED_SELECTION],
])('opens evidence in the cumulative diff after selecting %s', (selectionButton, selection) => {
  const { container } = mountEmptyTask();
  const click = (selector: string) =>
    expectDefined(container.querySelector<HTMLButtonElement>(selector)).click();
  const diff = () => expectDefined(container.querySelector<HTMLElement>('.test-diff'));
  click('.test-chat-review');
  click(selectionButton);
  expect(diff().dataset.commit).toBe(selection);
  click('.test-diff-close');
  click('.test-finish-open');
  click('.test-evidence-review');
  expect(diff().dataset.open).toBe('true');
  expect(diff().dataset.file).toBe('src/earlier.ts');
  expect(diff().dataset.commit).toBe('all');
  expect(container.querySelector('.test-evidence-review')).toBeNull();
});
