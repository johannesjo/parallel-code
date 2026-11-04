import { For, Index, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { mod } from '../lib/platform';
import { isTypingTarget } from '../lib/tour-keys';
import { store } from '../store/core';
import { boardIdeas, ideasLaneShown } from '../store/ideas';
import { setTaskProjectFilter, toggleNewTaskPanel } from '../store/navigation';
import { markFeatureHintSeen } from '../store/onboarding';
import { boardSidePanelOpen } from '../store/project-pages';
import { codeProjects, pickAndAddProject } from '../store/projects';
import { taskProjectFilter } from '../store/task-project-filter';
import {
  getTaskFocusedPanel,
  registerFocusFn,
  setTaskFocusedPanel,
  unregisterFocusFn,
} from '../store/store';
import { BoardLane, BoardRail } from './board/BoardLane';
import { FeatureHint } from './FeatureHint';
import { ChevronDownIcon } from './icons';
import { useBoardClock } from './board/task-state';
import { TaskBoardCard } from './TaskBoardCard';
import { IdeasLane } from './TaskBoardIdeasLane';
import { TerminalsLane, boardTerminals } from './TaskBoardTerminals';
import { forgetWorkingHolds } from './task-board-hold';
import { boardQuery, setBoardQuery } from './BoardSearch';
import { useCardMotion } from './task-board-motion';
import {
  boardLanes,
  boardTasks,
  headingParentAt,
  type BoardLane as LaneData,
} from './task-board-lanes';
import {
  BOARD_KEY_MOVES,
  boardHasFocus,
  claimBoardFocus,
  releaseBoardFocus,
  dropBoardFocus,
  focusBoardCard,
  focusBoardFilter,
  focusedBoardItem,
  moveBoardFocus,
} from './task-board-keys';
import './task-board.css';

function Lane(props: { lane: LaneData; tools?: JSX.Element }) {
  const headingId = () => `task-board-lane-${props.lane.id}`;
  return (
    <BoardLane
      class={`lane-${props.lane.id}`}
      aria-labelledby={headingId()}
      headingId={headingId()}
      title={props.lane.title}
      count={props.lane.tasks.length}
      tools={props.tools}
    >
      <For each={props.lane.tasks}>
        {(task, index) => (
          <>
            <Show when={headingParentAt(props.lane.tasks, index())}>
              {(parentId) => <SubtaskHeading parentId={parentId()} />}
            </Show>
            <TaskBoardCard task={task} lane={props.lane.id} />
          </>
        )}
      </For>
    </BoardLane>
  );
}

/** Names the coordinator once above a block of its subtasks in another lane. */
function SubtaskHeading(props: { parentId: string }) {
  return (
    <Show when={store.tasks[props.parentId]}>
      {(parent) => (
        <li class="task-board-family" title={`Subtasks of ${parent().name}`}>
          <span aria-hidden="true">↳ </span>
          <span class="dialog-sr-only">Subtasks of </span>
          {parent().name}
        </li>
      )}
    </Show>
  );
}

/**
 * Snoozed and minimized work stays out of the way: a narrow rail until asked
 * for. Stacked in one column it is a collapsible section that folds back.
 */
function SnoozedLane(props: { lane: LaneData }) {
  const [open, setOpen] = createSignal(false);
  return (
    <Show
      when={open()}
      fallback={
        <BoardRail
          title="Show snoozed and minimized tasks"
          aria-expanded={false}
          label={props.lane.title}
          count={props.lane.tasks.length}
          onClick={(e) => {
            const lanes = e.currentTarget.parentElement;
            setOpen(true);
            // The rail is gone; keep the keyboard on what it opened.
            lanes?.querySelector<HTMLElement>('.lane-snoozed .task-board-title')?.focus();
          }}
        />
      }
    >
      <Lane
        lane={props.lane}
        tools={
          <button
            type="button"
            class="task-board-lane-collapse"
            aria-expanded={true}
            title="Collapse snoozed and minimized tasks"
            aria-label="Collapse snoozed and minimized tasks"
            onClick={(e) => {
              const lanes = e.currentTarget.closest('.task-board-lanes');
              setOpen(false);
              // The lane is gone; hand the keyboard back to the rail.
              lanes?.querySelector<HTMLElement>('.task-board-rail')?.focus();
            }}
          >
            <ChevronDownIcon size={12} />
          </button>
        }
      />
    </Show>
  );
}

/** A board with nothing on it yet: the first steps, over the empty lanes they will fill. */
function BoardFirstSteps() {
  return (
    <div class="task-board-empty task-board-first">
      <Show
        when={codeProjects().length > 0}
        fallback={
          <>
            <strong>Link a project to get started</strong>
            <span>A project is a folder with your code; its tasks show up here.</span>
            <button type="button" class="task-board-start" onClick={() => void pickAndAddProject()}>
              Link a project folder…
            </button>
          </>
        }
      >
        <strong>Start a task</strong>
        <span>
          Describe the work, and an agent takes it on in its own worktree. Its card moves to Needs
          you whenever the agent wants you.
        </span>
        <button type="button" class="task-board-start" onClick={() => toggleNewTaskPanel(true)}>
          New task <kbd>{mod}+N</kbd>
        </button>
      </Show>
    </div>
  );
}

/** Says what hid the tasks, so a project filter left on doesn't read as an empty board. */
function BoardEmpty() {
  const project = () => store.projects.find((p) => p.id === taskProjectFilter());
  const query = () => boardQuery().trim();
  const noTasksAtAll = () => !project() && !query();
  const message = () => {
    const where = project() ? ` in ${project()?.name}` : '';
    return query() ? `No tasks${where} match “${query()}”` : `No running tasks${where}`;
  };
  return (
    <Show when={!noTasksAtAll()} fallback={<BoardFirstSteps />}>
      <p class="task-board-empty">
        {message()}
        <Show when={project()}>
          <button
            type="button"
            class="task-board-act"
            onClick={() => {
              setTaskProjectFilter(null);
              focusBoardFilter();
            }}
          >
            Show all projects
          </button>
        </Show>
      </p>
    </Show>
  );
}

/**
 * Arrows and hjkl move between cards and up from the first row to the filter,
 * Home/End to a lane's ends, `/` to the filter.
 */
function onBoardKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || isTypingTarget(e.target)) return;
  if (e.key === '/') {
    e.preventDefault();
    focusBoardFilter();
    return;
  }
  const move = BOARD_KEY_MOVES[e.key];
  if (!move || !focusedBoardItem()) return;
  e.preventDefault();
  if (!moveBoardFocus(move) && move === 'up') focusBoardFilter();
}

/** The board takes the keyboard when it opens and hands it to the active task when it closes. */
function useBoardFocus(): void {
  // An empty board has no card to take the keyboard; its filter does instead.
  const focusBoard = () => {
    if (!focusBoardCard(store.activeTaskId)) focusBoardFilter();
  };
  onMount(() => {
    registerFocusFn('task-board', focusBoard);
    // A draft opened beside the board keeps its focus.
    if (!boardSidePanelOpen()) focusBoard();
  });
  onCleanup(() => {
    unregisterFocusFn('task-board', focusBoard);
    dropBoardFocus();
    // Only when the board closed while it had the keyboard (focus falls to
    // body as its DOM goes). Hidden behind a project page, it stays open; a
    // sidebar click or a focus-mode expand has already placed focus.
    if (store.boardView || !(boardHasFocus() || document.activeElement === document.body)) return;
    queueMicrotask(() => {
      const id = store.activeTaskId;
      if (id && !store.boardView) setTaskFocusedPanel(id, getTaskFocusedPanel(id));
    });
  });
}

/** The workspace's board view: running tasks, not planned work, in lanes by what they need. */
export function TaskBoard() {
  const tasks = createMemo(() => boardTasks(boardQuery()));
  const lanes = createMemo(() => boardLanes(tasks()));
  const terminals = createMemo(() => boardTerminals(boardQuery()));
  let lanesEl: HTMLDivElement | undefined;
  // Ideas and terminals share the motion: adding or removing one, or showing
  // their lane, fades cards in and out and glides the lanes beside them.
  useCardMotion(
    () => lanesEl,
    () => [lanes(), terminals(), ideasLaneShown() && boardIdeas(boardQuery())],
  );
  onCleanup(useBoardClock());
  onCleanup(forgetWorkingHolds);
  // A reopened board starts unfiltered, as when the filter lived inside it.
  onCleanup(() => setBoardQuery(''));
  useBoardFocus();
  // Opening the board is what the tip pointing at it asks for.
  onMount(() => markFeatureHintSeen('board-view'));
  return (
    <section
      class="task-board"
      aria-labelledby="task-board-title"
      onKeyDown={onBoardKeyDown}
      onFocusIn={claimBoardFocus}
      onFocusOut={releaseBoardFocus}
    >
      {/* The title bar's tabs name the page; see TaskBoardControls. */}
      <h2 id="task-board-title" class="dialog-sr-only">
        Running tasks
      </h2>
      <div class="task-board-lanes" ref={lanesEl}>
        <Show when={tasks().length === 0}>
          <BoardEmpty />
        </Show>
        <IdeasLane query={boardQuery()} />
        {/* Index, not For: lanes are rebuilt on every change but keep their place,
            so a lane's cards and the snoozed rail's open state survive updates. */}
        <Index each={lanes()}>
          {(lane) => (
            <Show
              when={lane().id === 'snoozed'}
              fallback={
                // Ready to merge only matters to projects with pull requests, so it
                // appears with its first card instead of taking width from everyone.
                <Show when={lane().id !== 'ready' || lane().tasks.length > 0}>
                  <Lane lane={lane()} />
                </Show>
              }
            >
              {/* Terminals sit past the task lanes, with the snoozed rail kept at the edge. */}
              <TerminalsLane terminals={terminals()} />
              <Show when={lane().tasks.length > 0}>
                <SnoozedLane lane={lane()} />
              </Show>
            </Show>
          )}
        </Index>
      </div>
      <FeatureHint
        id="board-lanes"
        when={tasks().length > 0}
        anchor={() =>
          lanesEl?.querySelector<HTMLElement>(
            '.task-board-lane:not(.lane-ideas) .task-board-lane-title',
          ) ?? undefined
        }
        title="Tasks sort themselves by what they need"
      >
        A card moves on its own: to Needs you when its agent asks something, fails or is ready for
        review, to Working while it runs, to Stopped when it is idle, and to In pull request once it
        has one. A pull request with failing checks, conflicts or requested changes comes back to
        Needs you; one that can merge moves to Ready to merge. Click a card to open the task beside
        the board.
      </FeatureHint>
    </section>
  );
}
