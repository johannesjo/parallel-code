import { Show, createMemo, onCleanup } from 'solid-js';
import { formatRelativeAge } from '../lib/relativeAge';
import { isTaskBackgrounded } from '../store/background-tasks';
import { store } from '../store/core';
import { getPrChecks } from '../store/pr-checks-state';
import { getProject } from '../store/projects';
import { ClockIcon } from './icons';
import { ProjectSwatch } from './ProjectSwatch';
import { getTaskAttentionState, getTaskOpenQuestion } from '../store/taskStatus';
import { retryCloseTask } from '../store/tasks';
import type { Task } from '../store/types';
import { activityLine, agentName, boardNow, stateLabel } from './board/task-state';
import { ASK_ACTION, AskRow, TaskGlyph, TaskLine, TaskPr, openBeside } from './board/TaskStatus';
import { focusBoardCard } from './task-board-keys';
import { boardCheckLabel, boardTaskState, type BoardLaneId } from './task-board-lanes';
import { createTaskContextMenu } from './task-context-menu';

/** Why the card is set aside: when its snooze ends, or that it is minimized. */
function setAsideLabel(task: Task): string {
  if (!isTaskBackgrounded(task.id)) return 'Minimized';
  if (task.snoozedUntil === undefined) return task.snoozedUntilCi ? 'Until CI finishes' : '';
  const until = new Date(task.snoozedUntil);
  return `Until ${until.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

/** Offers another try at a close whose teardown failed; the error is the label's tooltip. */
function CloseFailed(props: { task: Task }) {
  return (
    <div class="task-board-ask">
      <span class="task-board-ask-label" title={props.task.closingError}>
        Close failed
      </span>
      <button
        type="button"
        class="task-board-act"
        onClick={() => void retryCloseTask(props.task.id)}
      >
        Retry
      </button>
    </div>
  );
}

/** A card's project: its swatch and name, or nothing for no project. */
export function BoardProjectLabel(props: { projectId: string | null | undefined }) {
  const project = () => (props.projectId ? getProject(props.projectId) : undefined);
  return (
    <Show when={project()}>
      {(p) => (
        <span class="task-board-project" title={p().name}>
          <Show
            when={p().icon}
            fallback={<i style={{ background: p().color }} aria-hidden="true" />}
          >
            {(icon) => <ProjectSwatch color={p().color} icon={icon()} size={8} />}
          </Show>
          <span>{p().name}</span>
        </span>
      )}
    </Show>
  );
}

/** A subtask's coordinator, while it is open. */
function parentTask(task: Task): Task | undefined {
  return task.coordinatedBy ? store.tasks[task.coordinatedBy] : undefined;
}

/** Lines the branch's commits changed since the base, or nothing when none are known or changed. */
function DiffCount(props: { taskId: string }) {
  const git = () => store.taskGitStatus[props.taskId];
  const added = () => git()?.lines_added ?? 0;
  const removed = () => git()?.lines_removed ?? 0;
  return (
    <Show when={added() + removed() > 0}>
      <span
        class="task-board-diff"
        title={`${added()} lines added, ${removed()} removed by the branch's commits`}
      >
        <span class="add">+{added()}</span> <span class="rem">−{removed()}</span>
      </span>
    </Show>
  );
}

function CardMeta(props: { task: Task; since: number | undefined; waiting: boolean }) {
  return (
    <div class="task-board-meta">
      <BoardProjectLabel projectId={props.task.projectId} />
      <span class="task-board-agent">{agentName(props.task)}</span>
      <Show when={props.since}>
        {(since) => (
          // The card's "Needs input" row already says it waits; the age says how long.
          <span class="task-board-age" title={props.waiting ? 'Waiting for an answer' : undefined}>
            {formatRelativeAge(since(), boardNow())}
          </span>
        )}
      </Show>
      <DiffCount taskId={props.task.id} />
    </div>
  );
}

/** One task on the all-tasks board; clicking anywhere opens it beside the board. */
export function TaskBoardCard(props: { task: Task; lane: BoardLaneId }) {
  const state = createMemo(() => boardTaskState(props.task));
  const checking = createMemo(() => boardCheckLabel(props.task));
  const activity = createMemo(() => activityLine(props.task));
  // activityLine falls back to the agent's name, which the meta row already
  // shows; the branch says more and keeps the line from standing empty.
  const fromAgent = () => !activity().text || activity().text === agentName(props.task);
  const closing = () =>
    props.task.closingStatus === 'closing' || props.task.closingStatus === 'removing';
  const closeErrorText = () =>
    props.task.closingStatus === 'error' ? props.task.closingError : undefined;
  // Names the cause of a card's spinner where its activity goes, so no row reflows.
  const busy = () =>
    checking() || (getTaskAttentionState(props.task.id) === 'shell_busy' ? 'Terminal busy' : '');
  const activityText = () => {
    if (closing()) return 'Closing…';
    // Spelled out on the card, not only in a tooltip, so keyboard users see why.
    const closeError = closeErrorText();
    if (closeError) return closeError;
    return busy() || (fromAgent() ? props.task.branchName : activity().text);
  };
  const shown = () => store.boardPeek && store.activeTaskId === props.task.id;
  const question = () => getTaskOpenQuestion(props.task.id);
  const ask = () =>
    props.lane === 'needs' && !props.task.closingStatus ? ASK_ACTION[state()] : undefined;
  const menu = createTaskContextMenu({
    task: () => props.task,
    open: () => openBeside(props.task),
    openOnOtherSide: () => openBeside(props.task, true),
  });
  let cardEl: HTMLLIElement | undefined;
  // A card that changes lane is rebuilt in its new lane, and focus on the old
  // one falls to the body; hand it to the new card once that is in place.
  onCleanup(() => {
    if (!cardEl?.contains(document.activeElement)) return;
    const taskId = props.task.id;
    queueMicrotask(() => {
      if (document.activeElement === document.body) focusBoardCard(taskId);
    });
  });
  return (
    <li
      ref={cardEl}
      class={`task-board-card state-${state()}`}
      data-board-card={props.task.id}
      data-board-task-id={props.task.id}
      classList={{
        failed: getPrChecks(props.task.id)?.overall === 'failure',
        'close-failed': props.task.closingStatus === 'error',
        shown: shown(),
        closing: closing(),
        subtask: !!parentTask(props.task),
      }}
      onContextMenu={(event) => menu.onContextMenu(event)}
    >
      <button
        type="button"
        class="task-board-title"
        aria-current={shown() ? 'true' : undefined}
        title={props.task.name}
        onClick={() => openBeside(props.task)}
      >
        <TaskGlyph taskId={props.task.id} checking={checking()} />
        <span class="task-board-name">{props.task.name}</span>
      </button>
      <CardMeta
        task={props.task}
        since={question()?.since ?? activity().since}
        waiting={question() !== null}
      />
      <TaskLine
        text={activityText()}
        classList={{
          branch: fromAgent() && !closing() && !closeErrorText() && !busy(),
          busy: !closing() && !closeErrorText() && !!busy(),
        }}
        prUrl={props.task.prUrl}
        issueUrl={props.task.githubUrl}
      />
      <Show when={props.task.prUrl}>{(url) => <TaskPr taskId={props.task.id} url={url()} />}</Show>
      <Show when={props.lane === 'snoozed' && setAsideLabel(props.task)}>
        {(label) => (
          <p class="task-board-ask">
            <span class="task-board-status muted">
              <ClockIcon size={12} />
              <span class="task-board-status-text">{label()}</span>
            </span>
          </p>
        )}
      </Show>
      <Show when={props.task.closingStatus === 'error'}>
        <CloseFailed task={props.task} />
      </Show>
      <Show when={ask()}>
        {(action) => (
          <AskRow
            label={stateLabel(props.task, state())}
            action={action()}
            onAct={() => openBeside(props.task)}
          />
        )}
      </Show>
      <menu.Menu />
    </li>
  );
}
