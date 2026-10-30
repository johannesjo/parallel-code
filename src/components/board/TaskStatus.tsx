import { Match, Show, Switch, batch } from 'solid-js';
import { IPC } from '../../../electron/ipc/channels';
import { invoke } from '../../lib/ipc';
import { parseGitHubIssueUrl } from '../../lib/kanban';
import { withViewTransition } from '../../lib/viewTransition';
import { getPrChecks, prBoardStatus, type PrBoardStatusKind } from '../../store/pr-checks-state';
import { store } from '../../store/core';
import { toggleNewTaskPanel } from '../../store/navigation';
import {
  boardSidePanelOpen,
  openBoardSidePanel,
  toggleBoardSidePanelSide,
} from '../../store/project-pages';
import { setOpenDraftAside } from '../../store/task-creation';
import { getTaskAttentionState, getTaskDotStatus } from '../../store/taskStatus';
import type { Task } from '../../store/types';
import { isPrBabysitStuck } from '../../store/pr-babysit';
import { BabysitButton } from '../BabysitButton';
import { CheckIcon, GitMergeIcon, GitPullRequestIcon, IssueOpenedIcon } from '../icons';
import { StatusDot } from '../StatusDot';
import { openTask, type CardTaskState } from './task-state';

/** The button label for a task that waits on you, by its state. */
export const ASK_ACTION: Partial<Record<CardTaskState, string>> = {
  needs_input: 'Answer',
  error: 'Show error',
  review: 'Review',
};

function prNumber(url: string): string {
  return url.match(/\/pull\/(\d+)/)?.[1] ?? '';
}

/**
 * Shows `id` in the board's side panel, moving the panel across first when
 * asked; `open` makes it the active item, `null` naming one it creates. The
 * board stays, so it never jumps to the tiled view.
 */
export function openBesideBoard(id: string | null, open: () => void, otherSide = false): void {
  // Only a panel that stays put swaps its item; opening or moving it has its own motion.
  const switching = !otherSide && boardSidePanelOpen() && store.activeTaskId !== id;
  withViewTransition(
    () =>
      batch(() => {
        // The draft holds the side panel, so it steps aside and returns on the next New Task.
        if (store.showNewTaskPanel) {
          setOpenDraftAside();
          toggleNewTaskPanel(false);
        }
        if (otherSide) toggleBoardSidePanelSide();
        openBoardSidePanel();
        open();
      }),
    switching ? ['task-switch'] : [],
  );
}

/** Opens the task in the board's side panel, moving the panel across first when asked. */
export function openBeside(task: Task, otherSide = false, panel?: string | null): void {
  openBesideBoard(task.id, () => openTask(task, panel), otherSide);
}

/** The task's status dot, the same glyph as the title-bar pills, which the board hides. */
export function TaskGlyph(props: { taskId: string; checking?: string }) {
  return (
    <span class="task-board-glyph" aria-hidden="true">
      <StatusDot
        status={getTaskDotStatus(props.taskId)}
        taskId={props.taskId}
        size="sm"
        attention={getTaskAttentionState(props.taskId)}
        checking={props.checking}
      />
    </span>
  );
}

/** How loudly a PR state reads: colour only for what needs you now. */
function prTone(kind: PrBoardStatusKind | undefined, conflicting: boolean): string {
  if (kind === 'failed') return 'error';
  if (kind === 'ready') return 'strong';
  if (kind === 'merged') return 'subtle';
  // "Blocked" by conflicts needs the user; by review or draft it is a routine wait.
  if (kind === 'blocked' && conflicting) return 'warning';
  return 'muted';
}

/** The PR's state as one label, toned by urgency, with Babysit; the link sits in the task's line. */
export function TaskPr(props: { taskId: string; url: string }) {
  const checks = () => getPrChecks(props.taskId);
  const status = () => prBoardStatus(checks());
  const kind = () => status()?.kind;
  // A stalled Babysit is why a failed PR is back in Needs you, so say so.
  const label = () =>
    kind() === 'failed' && isPrBabysitStuck(props.taskId)
      ? 'CI failed · Babysit stuck'
      : (status()?.label ?? 'Pull request open');
  return (
    <div class="task-board-ask">
      <span
        class={`task-board-status ${prTone(kind(), checks()?.mergeable === 'CONFLICTING')}`}
        title={label()}
      >
        <Switch>
          <Match when={kind() === 'ready'}>
            <span class="task-board-ok">
              <CheckIcon size={12} />
            </span>
          </Match>
          <Match when={kind() === 'merged'}>
            <GitMergeIcon size={12} />
          </Match>
        </Switch>
        <span class="task-board-status-text">{label()}</span>
      </span>
      <span class="task-board-actions">
        <Show when={checks() && !checks()?.merged}>
          <BabysitButton taskId={props.taskId} class="task-board-chip" />
        </Show>
      </span>
    </div>
  );
}

/** A neutral badge that opens a GitHub link in the browser. */
function LinkBadge(props: { url: string; kind: 'issue' | 'pr'; text: string }) {
  const noun = () => (props.kind === 'pr' ? 'pull request' : 'issue');
  return (
    <button
      type="button"
      class="task-board-chip task-board-link"
      title={`Open ${noun()} ${props.text}`}
      aria-label={`Open ${noun()} ${props.text}`}
      onClick={() => void invoke(IPC.ShellOpenExternal, { url: props.url })}
    >
      <Show when={props.kind === 'pr'} fallback={<IssueOpenedIcon size={11} />}>
        <GitPullRequestIcon size={11} />
      </Show>
      {props.text}
    </button>
  );
}

/**
 * A task's activity line with its issue and PR badges at the right end. The
 * issue shows only for a GitHub issue URL; a PR checkout's source is its PR.
 */
export function TaskLine(props: {
  text: string;
  classList: Record<string, boolean>;
  prUrl?: string;
  issueUrl?: string;
}) {
  const issue = () => {
    const parsed = props.issueUrl ? parseGitHubIssueUrl(props.issueUrl) : null;
    return parsed?.kind === 'issue' ? parsed : null;
  };
  // A URL without a number (not a GitHub PR) still gets a link.
  const prText = (url: string) => (prNumber(url) ? `#${prNumber(url)}` : 'PR');
  return (
    <div class="task-board-line">
      {/* Always rendered so a task starting or stopping never changes the card's height. */}
      <p class="task-board-activity" classList={props.classList} title={props.text}>
        {props.text || ' '}
      </p>
      <Show when={issue() || props.prUrl}>
        <span class="task-board-links">
          <Show when={issue()}>
            {(i) => <LinkBadge url={props.issueUrl ?? ''} kind="issue" text={`#${i().number}`} />}
          </Show>
          <Show when={props.prUrl}>
            {(url) => <LinkBadge url={url()} kind="pr" text={prText(url())} />}
          </Show>
        </span>
      </Show>
    </div>
  );
}

/** What the task waits for, and the button that goes there. */
export function AskRow(props: { label: string; action: string; onAct: () => void }) {
  return (
    <div class="task-board-ask">
      <span class="task-board-ask-label">{props.label}</span>
      <button type="button" class="task-board-act" onClick={() => props.onAct()}>
        {props.action}
      </button>
    </div>
  );
}
