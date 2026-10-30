import { Show } from 'solid-js';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { store, setStore } from '../store/core';
import { boardSidePanelOpen } from '../store/project-pages';
import { checksFromUpdate, removePrChecks, setPrChecks } from '../store/pr-checks-state';
import {
  getTaskFocusedPanel,
  navigateColumn,
  registerFocusFn,
  setTaskFocusedPanel,
  unregisterFocusFn,
} from '../store/store';
import { boardHasFocus, navigateBoard, navigateBoardTask } from './task-board-keys';
import { openNextAttentionTask, openPreviousAttentionTask } from './next-attention-task';
import { retryCloseTask } from '../store/tasks';
import { setTaskProjectFilter } from '../store/navigation';
import type { AttentionEntry } from '../store/sidebar-attention';
import type { Task } from '../store/types';
import { BoardSidePanelClose } from './BoardSidePanel';
import { FocusModeTaskIndicators } from './FocusModeTaskIndicators';
import { TaskBoard } from './TaskBoard';
import { WORKING_HOLD_MS } from './task-board-hold';
import { TaskBoardControls } from './TaskBoardControls';
import { WorkspaceControls } from './WorkspaceControls';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock('../store/tasks', () => ({ uncollapseTask: vi.fn(), retryCloseTask: vi.fn() }));
const snoozed = vi.hoisted(() => new Set<string>());
vi.mock('../store/background-tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/background-tasks')>()),
  isTaskBackgrounded: (id: string) => snoozed.has(id),
}));

// Lets a test force a task's attention state; agent activity is otherwise
// too far removed from the board to drive.
const attention = vi.hoisted(() => ({
  force: (_states: Record<string, string>): void => undefined,
}));
vi.mock('../store/taskStatus', async (importOriginal) => {
  const original = await importOriginal<typeof import('../store/taskStatus')>();
  const { createSignal } = await import('solid-js');
  const [forced, setForced] = createSignal<Record<string, string>>({});
  attention.force = setForced;
  return {
    ...original,
    getTaskAttentionState: (id: string) =>
      (forced()[id] as ReturnType<typeof original.getTaskAttentionState> | undefined) ??
      original.getTaskAttentionState(id),
  };
});

// Agent questions are too far removed from the board to drive.
const asking = vi.hoisted(() => ({ entries: [] as AttentionEntry[] }));
vi.mock('../store/sidebar-attention', async (importOriginal) => {
  const original = await importOriginal<typeof import('../store/sidebar-attention')>();
  return {
    ...original,
    computeAttentionEntries: () => [...asking.entries, ...original.computeAttentionEntries()],
  };
});

function task(id: string, name: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    name,
    projectId: 'web',
    branchName: id,
    worktreePath: `/repo/${id}`,
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
    ...extra,
  };
}

/** The board with its tabs in the title bar above it, as the app lays them out. */
function Board() {
  return (
    <>
      <TaskBoardControls />
      <TaskBoard />
    </>
  );
}

let host: HTMLDivElement;
let dispose: () => void;
const lane = (title: string) =>
  [...host.querySelectorAll('.task-board-lane')].find((el) =>
    el.querySelector('h3')?.textContent?.startsWith(title),
  );
const cardNames = (title: string) =>
  [...(lane(title)?.querySelectorAll('.task-board-name') ?? [])].map((el) => el.textContent);

beforeEach(() => {
  setStore(
    'tasks',
    reconcile({
      review: task('review', 'Fix login redirect', { needsReview: true }),
      pr: task('pr', 'Add dark mode', { prUrl: 'https://github.com/o/r/pull/42' }),
      idle: task('idle', 'Update docs'),
    }),
  );
  setStore('agents', reconcile({}));
  setStore('taskGitStatus', reconcile({}));
  setStore('focusedPanel', reconcile({}));
  setStore('projects', [{ id: 'web', name: 'Website', path: '/repo', color: '#0af' }]);
  setStore('taskOrder', ['review', 'pr', 'idle']);
  setStore('collapsedTaskOrder', []);
  setStore('taskProjectFilter', null);
  setStore('activeTaskId', 'idle');
  setStore('focusMode', false);
  setStore('boardView', true);
  setStore('boardPeek', false);
  setStore('showNewTaskPanel', false);
  setStore('boardSidePanelLeft', false);
  host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <Board />, host);
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  attention.force({});
  asking.entries = [];
  vi.useRealTimers();
});

it('sorts tasks into lanes by what they need', () => {
  expect(cardNames('Needs you')).toEqual(['Fix login redirect']);
  expect(cardNames('In pull request')).toEqual(['Add dark mode']);
  expect(cardNames('Stopped')).toEqual(['Update docs']);
  expect(lane('In pull request')?.textContent).toContain('#42');
});

it('offers Babysit beside an open pull request', () => {
  setPrChecks('pr', checksFromUpdate({ overall: 'pending' }));
  const babysit = lane('In pull request')?.querySelector('.task-pr-babysit');
  expect(babysit?.textContent).toContain('Babysit');
  expect(babysit?.getAttribute('aria-pressed')).toBe('false');
  setPrChecks('pr', { ...checksFromUpdate({ overall: 'success' }), merged: true });
  expect(lane('In pull request')?.querySelector('.task-pr-babysit')).toBeNull();
  removePrChecks('pr');
});

it('moves a pull request by what it waits for', () => {
  const at = () =>
    [...host.querySelectorAll('.task-board-lane')]
      .find((el) => cardNamesIn(el).includes('Add dark mode'))
      ?.querySelector('h3')
      ?.textContent?.replace(/\d+$/, '');
  const cardNamesIn = (el: Element) =>
    [...el.querySelectorAll('.task-board-name')].map((n) => n.textContent);
  setPrChecks('pr', checksFromUpdate({ overall: 'pending' }));
  expect(at()).toBe('In pull request');
  setPrChecks('pr', checksFromUpdate({ overall: 'failure' }));
  expect(at()).toBe('Needs you');
  // Babysit hands CI failures to the agent, so the task waits on it, not on you.
  setStore('tasks', 'pr', 'prBabysit', { attempts: 1 });
  expect(at()).toBe('In pull request');
  setPrChecks('pr', checksFromUpdate({ overall: 'success', reviewDecision: 'CHANGES_REQUESTED' }));
  expect(at()).toBe('Needs you');
  setStore('tasks', 'pr', 'prBabysit', undefined);
  setPrChecks('pr', checksFromUpdate({ overall: 'success', mergeable: 'CONFLICTING' }));
  expect(at()).toBe('Needs you');
  setPrChecks('pr', checksFromUpdate({ overall: 'success', reviewDecision: 'REVIEW_REQUIRED' }));
  expect(at()).toBe('In pull request');
  setPrChecks('pr', checksFromUpdate({ overall: 'success', reviewDecision: 'APPROVED' }));
  expect(at()).toBe('Ready to merge');
  removePrChecks('pr');
});

it('puts the lanes that need attention next to each other', () => {
  const titles = [...host.querySelectorAll('.task-board-lane h3')].map((h) =>
    h.textContent?.replace(/\d+$/, ''),
  );
  expect(titles).toEqual(['Needs you', 'Stopped', 'Working', 'In pull request']);
});

it('keeps a card in Working through a short pause in work', () => {
  vi.useFakeTimers();
  attention.force({ idle: 'active' });
  expect(cardNames('Working')).toEqual(['Update docs']);
  attention.force({});
  expect(cardNames('Working')).toEqual(['Update docs']);
  expect(lane('Working')?.querySelector('.task-board-card')?.classList).toContain('state-active');
  vi.advanceTimersByTime(WORKING_HOLD_MS);
  expect(cardNames('Stopped')).toEqual(['Update docs']);
});

it('does not hold work that stopped while the board was closed', () => {
  vi.useFakeTimers();
  attention.force({ idle: 'active' });
  expect(cardNames('Working')).toEqual(['Update docs']);
  dispose();
  attention.force({});
  dispose = render(() => <TaskBoard />, host);
  expect(cardNames('Stopped')).toEqual(['Update docs']);
});

it('says why a stopped card spins when only its terminal is busy', () => {
  const activity = () => lane('Stopped')?.querySelector('.task-board-activity')?.textContent ?? '';
  expect(activity()).not.toContain('Terminal busy');
  attention.force({ idle: 'shell_busy' });
  expect(cardNames('Stopped')).toEqual(['Update docs']);
  expect(lane('Stopped')?.querySelector('.task-board-glyph .status-glyph')).not.toBeNull();
  expect(activity()).toContain('Terminal busy');
});

it("links a task's source issue at the end of its line", () => {
  const links = () =>
    [
      ...(lane('Stopped')?.querySelectorAll<HTMLElement>('.task-board-line .task-board-link') ??
        []),
    ].map((b) => b.title);
  expect(links()).toEqual([]);
  setStore('tasks', 'idle', 'githubUrl', 'https://github.com/o/r/issues/9');
  expect(links()).toEqual(['Open issue #9']);
});

it('shows how many lines a task changed, and nothing for an unchanged one', () => {
  const diff = () => lane('Stopped')?.querySelector('.task-board-meta .task-board-diff');
  expect(diff()).toBeNull();
  setStore('taskGitStatus', 'idle', {
    has_committed_changes: true,
    has_uncommitted_changes: false,
    current_branch: 'task/idle',
    base_branch: 'main',
    lines_added: 120,
    lines_removed: 8,
    refreshedAt: 1,
  });
  expect(diff()?.textContent).toBe('+120 −8');
  setStore('taskGitStatus', 'idle', { lines_added: 0, lines_removed: 0 });
  expect(diff()).toBeNull();
});

it('moves a card into Working while a Finish check runs, with its own spinner', () => {
  setStore('tasks', 'review', 'reviewStatus', { state: 'running', startedAt: 1 });
  expect(cardNames('Working')).toEqual(['Fix login redirect']);
  const card = lane('Working')?.querySelector('.task-board-card');
  expect(card?.querySelector('.task-board-activity')?.textContent).toContain('Reviewing');
  const glyph = card?.querySelector<HTMLElement>('.task-board-glyph .status-glyph');
  expect(glyph?.querySelector('.status-glyph-spinner')).not.toBeNull();
  expect(glyph?.title).toContain('Reviewing');
  setStore('tasks', 'review', 'reviewStatus', undefined);
  expect(cardNames('Needs you')).toEqual(['Fix login redirect']);
});

it('keeps a closing card out of Working while its review runs', () => {
  setStore('tasks', 'idle', { reviewStatus: { state: 'running', startedAt: 1 } });
  setStore('tasks', 'idle', 'closingStatus', 'closing');
  expect(cardNames('Working')).toEqual([]);
  expect(cardNames('Stopped')).toEqual(['Update docs']);
});

it('leaves a card that asks a question in Needs you while its checks run', () => {
  attention.force({ review: 'needs_input' });
  setStore('tasks', 'review', 'reviewStatus', { state: 'running', startedAt: 1 });
  expect(cardNames('Needs you')).toEqual(['Fix login redirect']);
  expect(lane('Needs you')?.querySelector('.task-board-activity')?.textContent).not.toContain(
    'Reviewing',
  );
});

it('marks each card with the status glyph the title-bar pills use', () => {
  const glyph = lane('Needs you')?.querySelector<HTMLElement>('.task-board-title .status-glyph');
  expect(glyph?.title).toContain('Ready for review');
  // The glyph stays out of the card's accessible name.
  expect(host.querySelector('.task-board-title')?.getAttribute('title')).toBe('Fix login redirect');
  expect(glyph?.closest('[aria-hidden="true"]')).not.toBeNull();
});

it('hides the title-bar task pills while the board shows', () => {
  const bar = document.createElement('div');
  document.body.append(bar);
  const disposeBar = render(() => <FocusModeTaskIndicators />, bar);
  expect(bar.querySelector('.focus-mode-task-indicator')).toBeNull();

  setStore('boardView', false);
  expect(bar.querySelectorAll('.focus-mode-task-indicator')).toHaveLength(3);
  disposeBar();
});

it('lists finished work above idle tasks in the stopped lane', () => {
  setStore('tasks', 'done', task('done', 'Add search'));
  setStore('taskGitStatus', 'done', {
    has_committed_changes: true,
    has_uncommitted_changes: false,
    current_branch: 'done',
    base_branch: 'main',
    refreshedAt: Date.now(),
  });
  setStore('taskOrder', ['review', 'pr', 'idle', 'done']);
  expect(cardNames('Stopped')).toEqual(['Add search', 'Update docs']);
  expect(lane('Stopped')?.querySelector('.task-board-card')?.classList).toContain('state-ready');
});

it("keeps the sidebar's project grouping inside a lane", () => {
  setStore('projects', [
    { id: 'api', name: 'API', path: '/api', color: '#fa0' },
    { id: 'web', name: 'Website', path: '/repo', color: '#0af' },
  ]);
  setStore('tasks', 'cache', task('cache', 'Cache tokens', { projectId: 'api' }));
  setStore('taskOrder', ['review', 'pr', 'idle', 'cache']);
  expect(cardNames('Stopped')).toEqual(['Cache tokens', 'Update docs']);
});

it('groups subtasks under their coordinator, naming it once in other lanes', () => {
  const headings = (title: string) =>
    [...(lane(title)?.querySelectorAll('.task-board-family') ?? [])].map((el) => el.textContent);
  setStore('tasks', 'c1', task('c1', 'Theme tokens', { coordinatedBy: 'pr' }));
  setStore(
    'tasks',
    'c2',
    task('c2', 'Toggle', { coordinatedBy: 'pr', prUrl: 'https://x/pull/43' }),
  );
  setStore('taskOrder', ['c1', 'review', 'pr', 'idle', 'c2']);
  expect(cardNames('Stopped')).toEqual(['Theme tokens', 'Update docs']);
  expect(headings('Stopped')).toEqual(['↳ Subtasks of Add dark mode']);
  expect(cardNames('In pull request')).toEqual(['Add dark mode', 'Toggle']);
  expect(headings('In pull request')).toEqual([]);
  // A closed coordinator leaves no heading behind.
  setStore('tasks', 'pr', undefined as unknown as Task);
  expect(headings('Stopped')).toEqual([]);
});

it('filters cards by name or project', () => {
  const search = host.querySelector<HTMLInputElement>('.task-board-search');
  if (!search) throw new Error('missing search');
  search.value = 'dark';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect([...host.querySelectorAll('.task-board-name')].map((el) => el.textContent)).toEqual([
    'Add dark mode',
  ]);
  search.value = 'website';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(host.querySelectorAll('.task-board-name')).toHaveLength(3);
});

it('narrows the cards to the selected project without closing the board', () => {
  setStore('projects', [
    { id: 'web', name: 'Website', path: '/repo', color: '#0af' },
    { id: 'api', name: 'Backend', path: '/api', color: '#fa0' },
  ]);
  setStore('tasks', 'api-task', task('api-task', 'Rate limit', { projectId: 'api' }));
  setStore('taskOrder', ['review', 'pr', 'idle', 'api-task']);
  expect(host.querySelectorAll('.task-board-name')).toHaveLength(4);
  setTaskProjectFilter('api');
  expect([...host.querySelectorAll('.task-board-name')].map((el) => el.textContent)).toEqual([
    'Rate limit',
  ]);
  // Filtering the active task away must not close the board.
  expect(store.boardView).toBe(true);
  setTaskProjectFilter(null);
  expect(host.querySelectorAll('.task-board-name')).toHaveLength(4);
});

it('puts its actions and filter in the title bar while it shows', () => {
  const controls = host.querySelector('.task-board-controls');
  expect(controls?.textContent).toContain('New task');
  expect(host.querySelector('.task-board')?.contains(controls ?? null)).toBe(false);
  expect(controls?.querySelector('.task-board-search')).not.toBeNull();
  setStore('boardView', false);
  expect(host.querySelector('.task-board-controls')).toBeNull();
});

it('starts a reopened board unfiltered', () => {
  dispose();
  dispose = render(
    () => (
      <Show when={store.boardView}>
        <Board />
      </Show>
    ),
    host,
  );
  const input = () => host.querySelector<HTMLInputElement>('.task-board-search');
  const typed = input();
  if (!typed) throw new Error('missing search');
  typed.value = 'dark';
  typed.dispatchEvent(new Event('input', { bubbles: true }));
  expect(host.querySelectorAll('.task-board-name')).toHaveLength(1);
  setStore('boardView', false);
  setStore('boardView', true);
  expect(input()?.value).toBe('');
  expect(host.querySelectorAll('.task-board-name')).toHaveLength(3);
});

it('says why the board is empty', () => {
  const search = host.querySelector<HTMLInputElement>('.task-board-search');
  if (!search) throw new Error('missing search');
  search.value = 'zzz ';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(host.querySelector('.task-board-empty')?.textContent).toBe('No tasks match “zzz”');
  setStore('taskOrder', []);
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(host.querySelector('.task-board-empty strong')?.textContent).toBe('Start a task');
});

it('starts an empty board with the first steps: a new task, or a project first', () => {
  setStore('taskOrder', []);
  const empty = () => host.querySelector('.task-board-empty');
  const action = () => empty()?.querySelector('button');
  expect(action()?.textContent).toContain('New task');
  action()?.click();
  expect(store.showNewTaskPanel).toBe(true);

  setStore('projects', []);
  expect(empty()?.textContent).toContain('Link a project to get started');
  expect(action()?.textContent).toBe('Link a project folder…');
});

it('names the project filter that hid every task, and offers to clear it', () => {
  setStore('projects', [
    { id: 'web', name: 'Website', path: '/repo', color: '#0af' },
    { id: 'api', name: 'Backend', path: '/api', color: '#fa0' },
  ]);
  setTaskProjectFilter('api');
  const empty = () => host.querySelector('.task-board-empty');
  expect(empty()?.textContent).toBe('No running tasks in BackendShow all projects');
  empty()?.querySelector('button')?.click();
  expect(empty()).toBeNull();
  expect(host.querySelectorAll('.task-board-name')).toHaveLength(3);
});

it("marks a card's project with its icon when it has one, else a color bar", () => {
  const project = () => host.querySelector('.lane-stopped .task-board-project');
  expect(project()?.querySelector('i')).not.toBeNull();
  expect(project()?.querySelector('svg')).toBeNull();

  setStore('projects', 0, 'icon', 'terminal');

  const icon = project()?.querySelector<HTMLElement>('.project-swatch-icon');
  expect(icon?.querySelector('svg')).not.toBeNull();
  expect(icon?.style.color).toBe('#0af');
  expect(project()?.querySelector('i')).toBeNull();
});

it('shows the branch when a card has no agent activity', () => {
  const line = host.querySelector('.lane-stopped .task-board-activity');
  expect(line?.textContent).toBe('idle');
  expect(line?.classList.contains('branch')).toBe(true);
});

it('marks a closing task and offers nothing to answer while it closes', () => {
  setStore('tasks', 'review', 'closingStatus', 'closing');
  const card = host.querySelector('[data-board-task-id="review"]');
  expect(card?.classList).toContain('closing');
  expect(card?.querySelector('.task-board-activity')?.textContent).toBe('Closing…');
  expect(card?.querySelector('.task-board-ask')).toBeNull();
});

it('does not read agents killed by a close as a failure', () => {
  setStore('tasks', 'idle', { agentIds: ['a1'], closingStatus: 'closing' });
  setStore('agents', 'a1', {
    id: 'a1',
    taskId: 'idle',
    def: {
      id: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      args: [],
      resume_args: [],
      skip_permissions_args: [],
      description: '',
    },
    resumed: false,
    status: 'exited',
    exitCode: null,
    signal: 'SIGTERM',
    lastOutput: [],
    generation: 0,
  });
  expect(cardNames('Stopped')).toContain('Update docs');
  expect(host.querySelector('[data-board-task-id="idle"]')?.classList).not.toContain('state-error');
});

it('moves a task whose close failed to Needs you, with a retry', () => {
  setStore('tasks', 'pr', { closingStatus: 'error', closingError: 'worktree is locked' });
  expect(cardNames('Needs you')).toContain('Add dark mode');
  // The card's PR row comes first; the close failure has its own ask row.
  const label = host.querySelector('[data-board-task-id="pr"] .task-board-ask-label');
  const ask = label?.closest('.task-board-ask');
  expect(label?.textContent).toBe('Close failed');
  expect(label?.getAttribute('title')).toBe('worktree is locked');
  // The reason is readable without hovering.
  expect(host.querySelector('[data-board-task-id="pr"]')?.textContent).toContain(
    'worktree is locked',
  );
  ask?.querySelector<HTMLButtonElement>('.task-board-act')?.click();
  expect(retryCloseTask).toHaveBeenCalledWith('pr');
});

it('opens a clicked task beside the board and marks its card', () => {
  host.querySelector<HTMLButtonElement>('.lane-pr .task-board-title')?.click();
  expect(store.activeTaskId).toBe('pr');
  expect(boardSidePanelOpen()).toBe(true);
  expect(host.querySelector('.lane-pr .task-board-title')?.getAttribute('aria-current')).toBe(
    'true',
  );

  host.querySelector<HTMLButtonElement>('.lane-stopped .task-board-title')?.click();
  expect(store.activeTaskId).toBe('idle');
  expect(store.boardView).toBe(true);
});

it('marks a click that swaps the open side panel to another task as a task switch', () => {
  const start = vi.fn((arg: (() => void) | { update: () => void }) => {
    (typeof arg === 'function' ? arg : arg.update)();
    return { ready: Promise.resolve(), finished: Promise.resolve() };
  });
  Object.defineProperty(document, 'startViewTransition', { value: start, configurable: true });
  const click = (lane: string) =>
    host.querySelector<HTMLButtonElement>(`.lane-${lane} .task-board-title`)?.click();
  const types = () => (start.mock.lastCall?.[0] as { types?: string[] }).types;
  try {
    click('pr');
    // Opening the panel has its own motion.
    expect(types()).toBeUndefined();
    click('pr');
    expect(types()).toBeUndefined();
    click('stopped');
    expect(types()).toEqual(['task-switch']);
    expect(store.activeTaskId).toBe('idle');
  } finally {
    Reflect.deleteProperty(document, 'startViewTransition');
  }
});

it('folds minimized and snoozed tasks into one lane unless they need you', () => {
  // Before the store changes: the mocked snooze set is not reactive.
  snoozed.add('pr');
  setStore('tasks', 'idle', 'collapsed', true);
  setStore('tasks', 'pr', 'collapsed', true);
  setStore('tasks', 'review', 'collapsed', true);
  setStore('taskOrder', []);
  setStore('collapsedTaskOrder', ['review', 'pr', 'idle']);
  try {
    const rail = host.querySelector<HTMLButtonElement>('.task-board-rail');
    expect(rail?.textContent).toBe('Snoozed & minimized2');
    rail?.click();
    const lane = [...host.querySelectorAll<HTMLElement>('.lane-snoozed [data-board-task-id]')];
    expect(lane.map((el) => el.dataset.boardTaskId)).toEqual(['pr', 'idle']);
    expect(lane[1]?.textContent).toContain('Minimized');
    expect(cardNames('Needs you')).toEqual(['Fix login redirect']);
  } finally {
    snoozed.clear();
  }
});

it('collapses the snoozed lane back to its rail', () => {
  snoozed.add('pr');
  setStore('taskOrder', ['review', 'pr', 'idle']);
  try {
    host.querySelector<HTMLButtonElement>('.task-board-rail')?.click();
    const collapse = host.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse snoozed and minimized tasks"]',
    );
    expect(collapse?.getAttribute('aria-expanded')).toBe('true');
    collapse?.click();
    expect(host.querySelector('.lane-snoozed')).toBeNull();
    const rail = host.querySelector<HTMLButtonElement>('.task-board-rail');
    expect(rail?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(rail);
  } finally {
    snoozed.clear();
  }
});

it('closes the side panel from its edge and keeps the board', () => {
  host.querySelector<HTMLButtonElement>('.lane-pr .task-board-title')?.click();
  const bar = document.createElement('div');
  document.body.append(bar);
  const disposeBar = render(() => <BoardSidePanelClose />, bar);
  bar.querySelector<HTMLButtonElement>('[aria-label="Close side panel"]')?.click();
  expect(boardSidePanelOpen()).toBe(false);
  expect(store.boardView).toBe(true);
  disposeBar();
});

it('starts a new task beside the board', () => {
  [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.textContent?.includes('New task'))
    ?.click();
  expect(store.showNewTaskPanel).toBe(true);
  expect(store.boardView).toBe(true);
  expect(boardSidePanelOpen()).toBe(true);
});

it('switches views from the title-bar toggle in focus, tiles, board order', () => {
  const controls = document.createElement('div');
  document.body.append(controls);
  const disposeControls = render(() => <WorkspaceControls />, controls);
  const buttons = [
    ...controls.querySelectorAll<HTMLButtonElement>('[aria-label="Workspace view"] button'),
  ];
  expect(buttons.map((b) => b.title.split(':')[0])).toEqual(['Focus', 'Tiles', 'Board']);
  expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);

  buttons[0]?.click();
  expect(store.boardView).toBe(false);
  expect(store.focusMode).toBe(true);

  buttons[1]?.click();
  expect(store.focusMode).toBe(false);
  expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
  disposeControls();
});

describe('keyboard', () => {
  const card = (id: string) =>
    host.querySelector<HTMLButtonElement>(`[data-board-task-id="${id}"] .task-board-title`);
  const focusedId = () =>
    document.activeElement?.closest<HTMLElement>('[data-board-task-id]')?.dataset.boardTaskId;
  const press = (key: string, target: Element | null = document.activeElement) =>
    target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  beforeEach(() => {
    snoozed.clear();
    setStore('sidebarVisible', true);
    setStore('sidebarFocused', false);
    setStore('newTaskPanelFocused', false);
  });

  it('puts the keyboard on the active task card when the board opens', () => {
    expect(focusedId()).toBe('idle');
  });

  it('keeps the keyboard on a card that moves to another lane', async () => {
    expect(focusedId()).toBe('idle');
    setStore('tasks', 'idle', { closingStatus: 'error', closingError: 'worktree is locked' });
    expect(cardNames('Needs you')).toContain('Update docs');
    await Promise.resolve();
    expect(focusedId()).toBe('idle');
    expect(store.boardFocused).toBe(true);
  });

  it('moves between cards and lanes with arrows and hjkl', () => {
    setStore('tasks', 'idle2', task('idle2', 'Tidy styles'));
    setStore('taskOrder', ['review', 'idle', 'idle2', 'pr']);
    press('ArrowDown');
    expect(focusedId()).toBe('idle2');
    press('h');
    expect(focusedId()).toBe('review');
    press('ArrowLeft');
    expect(focusedId()).toBe('review');
    press('l');
    press('l');
    expect(focusedId()).toBe('pr');
    press('h');
    press('End');
    expect(focusedId()).toBe('idle2');
    press('Home');
    expect(focusedId()).toBe('idle');
  });

  it('walks stacked lanes as one column on a narrow board', () => {
    setStore('tasks', 'idle2', task('idle2', 'Tidy styles'));
    setStore('taskOrder', ['review', 'idle', 'idle2', 'pr']);
    // Stands in for the container query, which happy-dom does not evaluate.
    host
      .querySelector<HTMLElement>('.task-board-lanes')
      ?.style.setProperty('flex-direction', 'column');
    card('review')?.focus();
    press('ArrowDown');
    expect(focusedId()).toBe('idle');
    press('j');
    press('j');
    expect(focusedId()).toBe('pr');
    press('ArrowUp');
    expect(focusedId()).toBe('idle2');
    press('l');
    expect(focusedId()).toBe('idle2');
  });

  it('goes from the filter to the cards and opens the first match', () => {
    press('/');
    const search = host.querySelector<HTMLInputElement>('.task-board-search');
    expect(document.activeElement).toBe(search);
    press('ArrowDown');
    expect(focusedId()).toBe('review');
    search?.focus();
    press('ArrowUp', card('review'));
    expect(document.activeElement).toBe(search);
    search?.focus();
    press('Escape');
    expect(focusedId()).toBe('idle');
    search?.focus();
    press('Enter');
    expect(store.activeTaskId).toBe('review');
    expect(boardSidePanelOpen()).toBe(true);
  });

  it('leaves the board with Alt+Arrows: left to the sidebar, right into the side panel', () => {
    card('review')?.focus();
    expect(navigateBoard('left')).toBe(true);
    expect(store.sidebarFocused).toBe(true);

    navigateColumn('right');
    expect(store.sidebarFocused).toBe(false);
    expect(focusedId()).toBe('idle');

    setStore('boardPeek', true);
    expect(navigateBoard('right')).toBe(true);
    expect(focusedId()).toBe('pr');
    const panel = vi.fn();
    registerFocusFn('idle:ai-terminal', panel);
    expect(navigateBoard('right')).toBe(true);
    return Promise.resolve().then(() => {
      expect(panel).toHaveBeenCalled();
      unregisterFocusFn('idle:ai-terminal', panel);
    });
  });

  it("moves through the side panel task's panes, then on to the cards past their edge", () => {
    setStore('tasks', 'idle2', task('idle2', 'Tidy styles'));
    setStore('taskOrder', ['review', 'idle', 'idle2', 'pr']);
    setStore('boardPeek', true);
    setStore('activeTaskId', 'idle2');
    setTaskFocusedPanel('idle2', 'notes');
    (document.activeElement as HTMLElement | null)?.blur();
    // Focus is deferred, so only the last task's pane is focused.
    const panel = vi.fn();
    registerFocusFn('review:title', panel);
    // Lanes: Needs you [review], Stopped [idle, idle2], In pull request [pr].
    expect(navigateBoard('right')).toBe(true);
    expect(getTaskFocusedPanel('idle2')).toBe('changed-files');
    expect(navigateBoard('up')).toBe(true);
    expect(store.activeTaskId).toBe('idle2');
    expect(getTaskFocusedPanel('idle2')).toBe('title');
    // Past the top pane: the card above, on the same pane.
    expect(navigateBoard('up')).toBe(true);
    expect(store.activeTaskId).toBe('idle');
    expect(getTaskFocusedPanel('idle')).toBe('title');
    expect(navigateBoard('left')).toBe(true);
    expect(store.activeTaskId).toBe('review');
    expect(boardSidePanelOpen()).toBe(true);
    expect(focusedId()).toBeUndefined();
    return Promise.resolve().then(() => {
      expect(panel).toHaveBeenCalled();
      unregisterFocusFn('review:title', panel);
    });
  });

  it("hands the keyboard to the card at the side panel's edge facing the board", () => {
    setStore('boardPeek', true);
    setStore('activeTaskId', 'review');
    (document.activeElement as HTMLElement | null)?.blur();
    expect(navigateBoard('left')).toBe(true);
    expect(focusedId()).toBe('review');

    // On the board's left, the panel's edge facing it is the right one.
    setStore('boardSidePanelLeft', true);
    setStore('activeTaskId', 'pr');
    (document.activeElement as HTMLElement | null)?.blur();
    expect(navigateBoard('right')).toBe(true);
    expect(focusedId()).toBe('pr');
    // And the board's first lane leads into that panel.
    card('review')?.focus();
    const panel = vi.fn();
    registerFocusFn('pr:ai-terminal', panel);
    expect(navigateBoard('left')).toBe(true);
    return Promise.resolve().then(() => {
      expect(panel).toHaveBeenCalled();
      unregisterFocusFn('pr:ai-terminal', panel);
    });
  });

  it('steps through tasks in board order, on the board and in the side panel', () => {
    card('review')?.focus();
    navigateBoardTask('right');
    expect(focusedId()).toBe('idle');

    setStore('boardPeek', true);
    setStore('activeTaskId', 'idle');
    (document.activeElement as HTMLElement | null)?.blur();
    navigateBoardTask('right');
    expect(store.activeTaskId).toBe('pr');
    expect(store.boardView).toBe(true);
  });

  it("jumps a whole card up or down, on the board and past the side panel's panes", () => {
    setStore('tasks', 'idle2', task('idle2', 'Tidy styles'));
    setStore('taskOrder', ['review', 'idle', 'idle2', 'pr']);
    card('idle')?.focus();
    navigateBoardTask('down');
    expect(focusedId()).toBe('idle2');

    setStore('boardPeek', true);
    setStore('activeTaskId', 'idle2');
    setTaskFocusedPanel('idle2', 'changed-files');
    (document.activeElement as HTMLElement | null)?.blur();
    navigateBoardTask('up');
    expect(store.activeTaskId).toBe('idle');
    expect(getTaskFocusedPanel('idle')).toBe('changed-files');
    // At the lane's top there is nowhere to go, not even a pane up.
    navigateBoardTask('up');
    expect(store.activeTaskId).toBe('idle');
    expect(getTaskFocusedPanel('idle')).toBe('changed-files');
  });

  it('hands the keyboard to the active task when the board closes', async () => {
    dispose();
    dispose = render(
      () => (
        <Show when={store.boardView}>
          <Board />
        </Show>
      ),
      host,
    );
    const panel = vi.fn();
    registerFocusFn('idle:ai-terminal', panel);
    setStore('boardView', false);
    await Promise.resolve();
    await Promise.resolve();
    expect(panel).toHaveBeenCalled();
    unregisterFocusFn('idle:ai-terminal', panel);
  });
});

describe('keyboard edge cases', () => {
  const focusedId = () =>
    document.activeElement?.closest<HTMLElement>('[data-board-task-id]')?.dataset.boardTaskId;
  const press = (key: string, target: Element | null = document.activeElement) =>
    target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const search = () => host.querySelector<HTMLInputElement>('.task-board-search');

  beforeEach(() => {
    snoozed.clear();
    setStore('sidebarVisible', true);
    setStore('sidebarFocused', false);
    setStore('newTaskPanelFocused', false);
  });

  it('clears the filter before a second Escape returns to the cards', () => {
    const input = search();
    if (!input) throw new Error('missing search');
    input.focus();
    input.value = 'dark';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    press('Escape');
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    press('Escape');
    expect(focusedId()).toBe('idle');
  });

  it('lets the board take the keyboard from the sidebar, clearing its flag', () => {
    // The sidebar, not the board, has DOM focus.
    (document.activeElement as HTMLElement | null)?.blur();
    setStore('sidebarFocused', true);
    expect(navigateBoardTask('right')).toBe(true);
    expect(store.activeTaskId).toBe('idle');
    expect(store.boardView).toBe(true);
    expect(store.sidebarFocused).toBe(false);
    expect(focusedId()).toBe('idle');
  });

  it('counts the title-bar filter as the board, so a side panel does not take its keys', () => {
    setStore('boardPeek', true);
    search()?.focus();
    expect(boardHasFocus()).toBe(true);
  });

  it('sends an empty board to its filter and back out to the sidebar', () => {
    const input = search();
    if (!input) throw new Error('missing search');
    input.value = 'zzz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setStore('sidebarFocused', true);
    navigateColumn('right');
    expect(document.activeElement).toBe(input);
    expect(store.sidebarFocused).toBe(false);
    expect(navigateBoard('left')).toBe(true);
    expect(store.sidebarFocused).toBe(true);
  });

  it('skips snoozed tasks when switching the side panel', () => {
    snoozed.add('pr');
    // The mocked snooze set is not reactive; a new order recomputes the lanes.
    setStore('taskOrder', ['review', 'pr', 'idle']);
    host.querySelector<HTMLButtonElement>('.task-board-rail')?.click();
    expect(focusedId()).toBe('pr');
    setStore('boardPeek', true);
    // Board order is review, idle, then the snoozed lane's pr.
    setStore('activeTaskId', 'idle');
    (document.activeElement as HTMLElement | null)?.blur();
    navigateBoardTask('right');
    expect(store.activeTaskId).toBe('idle');
  });

  it('leaves a draft beside the board its focus when the board mounts', () => {
    dispose();
    setStore('showNewTaskPanel', true);
    const draft = document.createElement('textarea');
    document.body.append(draft);
    draft.focus();
    dispose = render(() => <Board />, host);
    expect(document.activeElement).toBe(draft);
  });
});

describe('next task that needs you', () => {
  it('goes through Needs you, then Stopped, and wraps, beside the board', () => {
    setStore('tasks', 'idle2', task('idle2', 'Tidy tests'));
    setStore('taskOrder', ['review', 'pr', 'idle', 'idle2']);
    setStore('activeTaskId', 'pr');
    const visited = [1, 2, 3, 4].map(() => {
      openNextAttentionTask();
      return store.activeTaskId;
    });
    expect(visited).toEqual(['review', 'idle', 'idle2', 'review']);
    expect(boardSidePanelOpen()).toBe(true);
  });

  it('goes back up the list, wrapping to the last, with the previous command', () => {
    setStore('tasks', 'idle2', task('idle2', 'Tidy tests'));
    setStore('taskOrder', ['review', 'pr', 'idle', 'idle2']);
    setStore('activeTaskId', 'idle');
    const visited = [1, 2, 3].map(() => {
      openPreviousAttentionTask();
      return store.activeTaskId;
    });
    expect(visited).toEqual(['review', 'idle2', 'idle']);
  });

  it('starts from the least urgent going back when the current task is not waiting', () => {
    setStore('activeTaskId', 'pr');
    openPreviousAttentionTask();
    expect(store.activeTaskId).toBe('idle');
  });

  it('starts from the most urgent once the current task stops waiting', () => {
    setStore('activeTaskId', 'idle');
    setStore('tasks', 'idle', 'prUrl', 'https://github.com/o/r/pull/7');
    openNextAttentionTask();
    expect(store.activeTaskId).toBe('review');
  });

  it('opens the task in the layout, without a side panel, when the board is closed', () => {
    setStore('boardView', false);
    setStore('activeTaskId', 'pr');
    openNextAttentionTask();
    expect(store.activeTaskId).toBe('review');
    expect(store.boardPeek).toBe(false);
  });

  it("opens the task beside a project's plan, which is part of the board", () => {
    setStore('kanbanProjectId', 'web');
    setStore('activeTaskId', 'pr');
    openNextAttentionTask();
    expect(store.activeTaskId).toBe('review');
    expect(store.kanbanProjectId).toBe('web');
    expect(store.boardPeek).toBe(true);
  });

  it('does not skip a task that stopped while the board was closed', () => {
    vi.useFakeTimers();
    // A closed board is not mounted, so nothing else reads lane states.
    dispose();
    dispose = () => undefined;
    setStore('boardView', false);
    setStore('activeTaskId', 'review');
    attention.force({ idle: 'active' });
    openNextAttentionTask();
    attention.force({});
    openNextAttentionTask();
    expect(store.activeTaskId).toBe('idle');
  });

  it('keeps the keyboard in the same kind of pane', () => {
    setStore('activeTaskId', 'pr');
    setTaskFocusedPanel('pr', 'notes');
    openNextAttentionTask();
    expect(store.activeTaskId).toBe('review');
    expect(getTaskFocusedPanel('review')).toBe('notes');
  });

  it('keeps the keyboard in an agent terminal, landing on the one that asks', () => {
    setStore('tasks', 'pr', 'agentIds', ['pr-agent']);
    setStore('tasks', 'review', 'agentIds', ['first', 'asking']);
    setStore('activeTaskId', 'pr');
    setTaskFocusedPanel('pr', 'ai-terminal:pr-agent');
    asking.entries = [
      {
        key: 'q',
        kind: 'question',
        taskId: 'review',
        label: 'Answer',
        panel: 'ai-terminal:asking',
      },
    ];
    openNextAttentionTask();
    expect(getTaskFocusedPanel('review')).toBe('ai-terminal:asking');
  });

  it('keeps the keyboard in an agent terminal when no agent asks', () => {
    setStore('tasks', 'pr', 'agentIds', ['pr-agent']);
    setStore('tasks', 'review', 'agentIds', ['review-agent']);
    setTaskFocusedPanel('review', 'notes');
    setStore('activeTaskId', 'pr');
    setTaskFocusedPanel('pr', 'ai-terminal:pr-agent');
    openNextAttentionTask();
    expect(getTaskFocusedPanel('review')).toBe('ai-terminal:review-agent');
  });

  it('keeps the keyboard in a shell, even one the next task numbers differently', () => {
    setStore('tasks', 'pr', 'shellAgentIds', ['s1', 's2']);
    setStore('tasks', 'review', 'shellAgentIds', ['s3']);
    setStore('activeTaskId', 'pr');
    setTaskFocusedPanel('pr', 'shell:1');
    openNextAttentionTask();
    expect(getTaskFocusedPanel('review')).toBe('shell:0');
  });

  it('stays put when nothing else is waiting', () => {
    setStore('tasks', 'idle', 'prUrl', 'https://github.com/o/r/pull/7');
    setStore('activeTaskId', 'review');
    openNextAttentionTask();
    expect(store.activeTaskId).toBe('review');
  });
});

describe('board tips', () => {
  const tip = () => document.querySelector<HTMLElement>('.feature-hint');
  const showTips = () => {
    dispose();
    vi.useFakeTimers();
    // happy-dom lays nothing out; a tip needs its anchor to have a box.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 200, 24),
    );
    setStore('seenFeatureHints', []);
  };
  afterEach(() => {
    // Unmount first: a shown tip follows its anchor every frame, the board keeps a clock.
    dispose();
    dispose = () => undefined;
    // A dismissal's cooldown must not hold back later tips.
    vi.runAllTimers();
    vi.restoreAllMocks();
  });

  it('points tiles users with several tasks at the board, which opens from the tip', () => {
    showTips();
    setStore('boardView', false);
    dispose = render(() => <WorkspaceControls />, host);
    vi.advanceTimersByTime(650);
    expect(tip()?.textContent).toContain('See every task by what it needs');

    [...(tip()?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent === 'Show board')
      ?.click();
    expect(store.boardView).toBe(true);
    expect(store.seenFeatureHints).toContain('board-view');
  });

  it('explains the lanes once the board has tasks, and counts the board as found', () => {
    showTips();
    dispose = render(() => <Board />, host);
    expect(store.seenFeatureHints).toContain('board-view');
    vi.advanceTimersByTime(650);
    expect(tip()?.textContent).toContain('Tasks sort themselves by what they need');
  });
});
