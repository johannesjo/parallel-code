import {
  For,
  Show,
  createMemo,
  createResource,
  createEffect,
  createSignal,
  createUniqueId,
  on,
  onMount,
  untrack,
  type JSX,
} from 'solid-js';
import { CloseIcon, CopyIcon, GitHubIcon, LinkIcon, PlayIcon } from './icons';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { formatRelativeAge } from '../lib/relativeAge';
import {
  cardChecklist,
  cardFingerprint,
  cardSummary,
  parseGitHubIssueUrl,
  type KanbanCard,
} from '../lib/kanban';
import { readGitHubIssue } from '../store/github';
import { store } from '../store/core';
import { setPendingAction } from '../store/focus';
import { isLandedTaskState } from '../store/landing';
import { showNotification } from '../store/notification';
import type { Task } from '../store/types';
import {
  activityLine,
  agentName,
  boardNow as now,
  cardTaskState,
  stateLabel,
  type CardTaskState,
} from './board/task-state';
import { ASK_ACTION, AskRow, TaskGlyph, TaskLine, TaskPr, openBeside } from './board/TaskStatus';
import { taskLeadPr, taskLinkedPrUrl } from '../store/task-prs';
import { createTaskContextMenu } from './task-context-menu';

/** The open task of this project working on `branch`, if any. */
export function linkedTask(projectId: string, branch: string): Task | undefined {
  // Only worktree tasks own their branch; a direct task works on a shared one.
  return Object.values(store.tasks).find(
    (task) =>
      task?.projectId === projectId &&
      task.gitIsolation === 'worktree' &&
      task.branchName === branch,
  );
}

/** The card's linked task that most needs the user, and how it is doing. */
export function urgentTask(
  projectId: string,
  card: KanbanCard,
): { task: Task; state: CardTaskState } | undefined {
  const order: CardTaskState[] = ['needs_input', 'error', 'review', 'active', 'ready', 'idle'];
  let best: { task: Task; state: CardTaskState } | undefined;
  for (const branch of card.branches) {
    const task = linkedTask(projectId, branch);
    if (!task) continue;
    const state = cardTaskState(task);
    if (!best || order.indexOf(state) < order.indexOf(best.state)) best = { task, state };
  }
  return best;
}

export function cardState(projectId: string, card: KanbanCard): CardTaskState | null {
  return urgentTask(projectId, card)?.state ?? null;
}

/** A linked task: which one, what it is doing, and the way to it when it waits on you. */
function TaskRow(props: { task: Task }) {
  const state = createMemo(() => cardTaskState(props.task));
  const activity = createMemo(() => activityLine(props.task));
  // As on the task board: until the agent reports, its branch says more than its name.
  const fromAgent = () => !activity().text || activity().text === agentName(props.task);
  const activityText = () => (fromAgent() ? props.task.branchName : activity().text);
  const ask = () => ASK_ACTION[state()];
  // Finish runs in the task's panel, so Merge opens it beside the board with Finish requested.
  const canFinish = () =>
    props.task.gitIsolation === 'worktree' && !isLandedTaskState(props.task.landingState);
  const merge = () => {
    openBeside(props.task);
    setPendingAction({ type: 'finish', taskId: props.task.id });
  };
  const menu = createTaskContextMenu({
    task: () => props.task,
    open: () => openBeside(props.task),
    openOnOtherSide: () => openBeside(props.task, true),
  });
  return (
    <li class={`plan-task state-${state()}`} onContextMenu={(event) => menu.onContextMenu(event)}>
      <button
        type="button"
        class="plan-task-open"
        title={`Show ${props.task.name} beside the board`}
        onClick={() => openBeside(props.task)}
      >
        <TaskGlyph taskId={props.task.id} />
        <span class="plan-task-name">{props.task.name}</span>
        {/* An asking task says so in the row below, beside its action. */}
        <Show when={!ask()}>
          <span class="plan-task-state">{stateLabel(props.task, state())}</span>
        </Show>
        <Show when={state() === 'active' && activity().since}>
          {(since) => <span class="task-board-age">{formatRelativeAge(since(), now())}</span>}
        </Show>
      </button>
      <Show when={ask()}>
        {(action) => (
          <AskRow
            label={stateLabel(props.task, state())}
            action={action()}
            onAct={() => openBeside(props.task)}
          />
        )}
      </Show>
      {/* The card shows its issue already, so the line links only the PR. */}
      <TaskLine
        text={activityText()}
        classList={{ branch: fromAgent() }}
        prUrl={taskLinkedPrUrl(props.task)}
      />
      <Show when={taskLeadPr(props.task)}>
        {(pr) => (
          <TaskPr
            taskId={props.task.id}
            watchId={pr().watchId}
            onMerge={canFinish() ? merge : undefined}
          />
        )}
      </Show>
      <menu.Menu />
    </li>
  );
}

function BranchRow(props: { branch: string }) {
  return (
    <li class="plan-task task-board-row">
      <span class="kanban-branch" title={`${props.branch}: no open task works on this branch`}>
        {props.branch}
      </span>
      <button
        type="button"
        class="task-board-chip"
        title="Copy branch name"
        aria-label={`Copy branch name ${props.branch}`}
        onClick={() =>
          void navigator.clipboard
            ?.writeText(props.branch)
            .then(() => showNotification('Branch name copied'))
        }
      >
        <CopyIcon size={11} />
      </button>
    </li>
  );
}

/** GitHub state per issue URL, shared by every card and kept for a few minutes. */
const issueStates = new Map<string, { at: number; state: Promise<string | null> }>();
const ISSUE_STATE_TTL_MS = 5 * 60_000;

function issueState(url: string): Promise<string | null> {
  const cached = issueStates.get(url);
  if (cached && Date.now() - cached.at < ISSUE_STATE_TTL_MS) return cached.state;
  const state = readGitHubIssue(url).then(
    (issue) => issue.state,
    () => null,
  );
  issueStates.set(url, { at: Date.now(), state });
  return state;
}

/** `#12` for the card's GitHub issue or PR, with its state once GitHub answers. */
function IssueChip(props: { url: string }) {
  const parsed = () => parseGitHubIssueUrl(props.url);
  const [state] = createResource(() => props.url, issueState);
  const closed = () => state() === 'closed' || state() === 'merged';
  return (
    <Show when={parsed()}>
      {(issue) => (
        <button
          type="button"
          class="task-board-chip kanban-issue"
          classList={{ closed: closed() }}
          title={`Open ${issue().kind === 'pr' ? 'pull request' : 'issue'} ${issue().repo}#${issue().number} on GitHub${state() ? ` (${state()})` : ''}`}
          onClick={() => void invoke(IPC.ShellOpenExternal, { url: props.url })}
        >
          <GitHubIcon size={10} />#{issue().number}
          <Show when={closed()}>
            <span> · {state()}</span>
          </Show>
        </button>
      )}
    </Show>
  );
}

export interface KanbanCardViewProps {
  card: KanbanCard;
  projectId: string;
  /** Open dependencies (cards on the board that are not done yet). */
  blockedBy: string[];
  draggable: boolean;
  /** Leave out the description and checklist; the footer still shows checklist progress. */
  compact?: boolean;
  dropBefore: boolean;
  dragging: boolean;
  flash: boolean;
  dataRef: string;
  onSelect: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onEdit: () => void;
  onStart: () => void;
  onToggleDone: (done: boolean) => void;
  onToggleChecklist: (line: number) => void;
}

/**
 * One card of a plan, built like a task card: its title stretches over the
 * card, so a click anywhere edits it; the controls on it sit above the title.
 */
export function KanbanCardView(props: KanbanCardViewProps) {
  const describedId = createUniqueId();
  const checklist = createMemo(() => cardChecklist(props.card));
  const summary = createMemo(() => cardSummary(props.card));
  const tasks = createMemo(() =>
    props.card.branches.map((branch) => ({ branch, task: linkedTask(props.projectId, branch) })),
  );
  const state = createMemo(() => cardState(props.projectId, props.card));
  const checked = () => checklist().filter((item) => item.done).length;
  const live = () => tasks().some((entry) => entry.task);
  const startTitle = () =>
    props.blockedBy.length
      ? `Waits for ${props.blockedBy.join(', ')}; start anyway (S)`
      : `Start ${live() ? 'another task' : 'a task'} from this card (S)`;
  // What a screen reader hears after the title: the card's state in words.
  const description = () =>
    [
      props.card.done ? 'Done' : '',
      state() === 'needs_input'
        ? 'Needs input'
        : state() === 'error'
          ? 'Task failed'
          : state() === 'active'
            ? 'Task working'
            : state() === 'review'
              ? 'Ready for review'
              : '',
      props.blockedBy.length ? `Waits for ${props.blockedBy.join(', ')}` : '',
      checklist().length ? `Checklist ${checked()} of ${checklist().length}` : '',
      props.card.issue ? `Linked to #${parseGitHubIssueUrl(props.card.issue)?.number ?? ''}` : '',
    ]
      .filter(Boolean)
      .join('. ');
  return (
    <li
      class="task-board-card plan-card"
      classList={{
        [`state-${state() ?? 'none'}`]: true,
        done: props.card.done,
        'drop-before': props.dropBefore,
        dragging: props.dragging,
        flash: props.flash,
        blocked: props.blockedBy.length > 0,
      }}
      data-card={props.dataRef}
      data-board-card={cardFingerprint(props.card)}
      // The side panel steps through the cards whose task is open.
      data-board-task-id={tasks().find((entry) => entry.task)?.task?.id}
      draggable={props.draggable}
      onDragStart={(e) => props.onDragStart(e)}
      onDragEnd={() => props.onDragEnd()}
      onDragOver={(e) => props.onDragOver(e)}
      onDrop={(e) => props.onDrop(e)}
    >
      <div class="plan-card-head">
        <label class="kanban-done">
          <input
            type="checkbox"
            checked={props.card.done}
            aria-label={`Done: ${props.card.title || 'Untitled'}`}
            onChange={(e) => props.onToggleDone(e.currentTarget.checked)}
          />
          <span class="kanban-done-mark" aria-hidden="true" />
        </label>
        <button
          type="button"
          class="task-board-title"
          aria-describedby={describedId}
          title={`${props.card.title || 'Untitled'} · click to edit`}
          onFocus={() => props.onSelect()}
          onClick={() => props.onEdit()}
        >
          <span class="task-board-name" classList={{ untitled: !props.card.title }}>
            {props.card.title || 'Untitled'}
          </span>
        </button>
        <Show when={!props.card.done}>
          <button
            type="button"
            class="kanban-start"
            title={startTitle()}
            aria-label={live() ? 'Start another task from this card' : 'Start task'}
            onClick={() => props.onStart()}
          >
            <PlayIcon size={11} />
          </button>
        </Show>
      </div>
      <span id={describedId} class="kanban-sr-only">
        {description()}
      </span>
      <Show when={!props.compact && summary()}>
        <p class="plan-card-body">{summary()}</p>
      </Show>
      <Show when={!props.compact && checklist().length}>
        <ul class="kanban-checklist" aria-label="Checklist">
          <For each={checklist().slice(0, 5)}>
            {(item) => (
              <li classList={{ done: item.done }}>
                <label>
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={() => props.onToggleChecklist(item.line)}
                  />
                  <span>{item.text}</span>
                </label>
              </li>
            )}
          </For>
          <Show when={checklist().length > 5}>
            <li class="kanban-more">+{checklist().length - 5} more</li>
          </Show>
        </ul>
      </Show>
      <Show when={props.blockedBy.length}>
        <p class="kanban-blocked" title="Cards that have to be done first">
          <LinkIcon size={11} /> Waits for {props.blockedBy.join(', ')}
        </p>
      </Show>
      <Show when={tasks().length}>
        <ul class="plan-tasks" aria-label="Tasks">
          <For each={tasks()}>
            {(entry) => (
              <Show when={entry.task} fallback={<BranchRow branch={entry.branch} />}>
                {(task) => <TaskRow task={task()} />}
              </Show>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.card.issue || checklist().length}>
        <div class="plan-card-footer">
          <Show when={props.card.issue}>{(url) => <IssueChip url={url()} />}</Show>
          <Show when={checklist().length}>
            <span class="kanban-progress" title="Checklist">
              {checked()}/{checklist().length}
            </span>
          </Show>
        </div>
      </Show>
    </li>
  );
}

/** What the open card editor holds, kept by the board so a re-render cannot drop typed text. */
export interface EditorDraft {
  title: string;
  body: string;
  depends: string[];
  group: string;
  column: number;
}

export function KanbanCardEditor(props: {
  card: KanbanCard;
  /** Text typed before the editor was re-created; wins over the card's own. */
  draft?: EditorDraft | null;
  onDraft?: (draft: EditorDraft) => void;
  columns: string[];
  column: number;
  /** Titles of the other cards, for dependencies. */
  otherTitles: string[];
  /** Themes already on the board, offered while typing one. */
  themes: string[];
  onSave: (
    change: { title: string; body: string; depends: string[]; group: string },
    column: number,
  ) => void;
  onDelete: () => void;
  onArchive: () => void;
  onCancel: () => void;
}) {
  const initial = untrack(() => props.card);
  const saved = untrack(() => props.draft);
  const [title, setTitle] = createSignal(saved?.title ?? initial.title);
  const [body, setBody] = createSignal(saved?.body ?? initial.body);
  const [depends, setDepends] = createSignal<string[]>([...(saved?.depends ?? initial.depends)]);
  const [group, setGroup] = createSignal(saved?.group ?? initial.group ?? '');
  const [column, setColumn] = createSignal(saved?.column ?? untrack(() => props.column));
  createEffect(
    on(
      [title, body, depends, group, column],
      ([t, b, d, g, c]) => props.onDraft?.({ title: t, body: b, depends: d, group: g, column: c }),
      {
        defer: true,
      },
    ),
  );
  let titleRef: HTMLInputElement | undefined;
  let bodyRef: HTMLTextAreaElement | undefined;
  const grow = () => {
    if (!bodyRef) return;
    bodyRef.style.height = 'auto';
    bodyRef.style.height = `${Math.min(bodyRef.scrollHeight + 2, 360)}px`;
  };
  onMount(() => {
    titleRef?.focus();
    titleRef?.select();
    grow();
  });
  const save = () =>
    props.onSave({ title: title(), body: body(), depends: depends(), group: group() }, column());
  const themeList = createUniqueId();
  const onKeyDown: JSX.EventHandler<HTMLElement, KeyboardEvent> = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      props.onCancel();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
    e.stopPropagation();
  };
  const candidates = () => props.otherTitles.filter((t) => !depends().includes(t));
  return (
    <form
      class="kanban-card-editor"
      aria-label={`Edit card ${initial.title || 'Untitled'}`}
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <input
        ref={titleRef}
        class="kanban-editor-title"
        aria-label="Card title"
        placeholder="Card title"
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            bodyRef?.focus();
          }
        }}
      />
      <textarea
        ref={bodyRef}
        aria-label="Description"
        placeholder={
          'What should the agent do? Markdown.\n- [ ] Acceptance criteria as checklist items'
        }
        rows={4}
        value={body()}
        onInput={(e) => {
          setBody(e.currentTarget.value);
          grow();
        }}
      />
      <div class="kanban-editor-row">
        <span class="kanban-editor-label">Waits for</span>
        <div class="kanban-depends">
          <For each={depends()}>
            {(dependency) => (
              <span class="kanban-chip">
                {dependency}
                <button
                  type="button"
                  class="kanban-chip-remove"
                  aria-label={`Remove dependency ${dependency}`}
                  onClick={() => setDepends((list) => list.filter((d) => d !== dependency))}
                >
                  <CloseIcon size={9} />
                </button>
              </span>
            )}
          </For>
          <Show when={candidates().length}>
            <select
              aria-label="Add a dependency"
              value=""
              onChange={(e) => {
                const value = e.currentTarget.value;
                if (value) setDepends((list) => [...list, value]);
                e.currentTarget.value = '';
              }}
            >
              <option value="">Add…</option>
              <For each={candidates()}>{(t) => <option value={t}>{t}</option>}</For>
            </select>
          </Show>
        </div>
      </div>
      <label class="kanban-editor-row">
        <span class="kanban-editor-label">Theme</span>
        <input
          list={themeList}
          placeholder="Cluster in the map, e.g. Auth"
          value={group()}
          onInput={(e) => setGroup(e.currentTarget.value)}
        />
        <datalist id={themeList}>
          <For each={props.themes}>{(theme) => <option value={theme} />}</For>
        </datalist>
      </label>
      <label class="kanban-editor-row">
        <span class="kanban-editor-label">Column</span>
        <select value={column()} onChange={(e) => setColumn(Number(e.currentTarget.value))}>
          <For each={props.columns}>{(name, i) => <option value={i()}>{name}</option>}</For>
        </select>
      </label>
      <div class="kanban-editor-actions">
        <button type="submit" class="kanban-primary" title="Save (Ctrl+Enter)">
          Save
        </button>
        <button type="button" onClick={() => props.onCancel()} title="Cancel (Esc)">
          Cancel
        </button>
      </div>
      <div class="kanban-editor-actions secondary">
        <button type="button" class="kanban-quiet" onClick={() => props.onArchive()}>
          Archive
        </button>
        <button type="button" class="kanban-quiet" onClick={() => props.onDelete()}>
          Delete
        </button>
      </div>
    </form>
  );
}
