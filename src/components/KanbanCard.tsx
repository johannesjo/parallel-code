import { For, Show, createMemo, createSignal, onMount, untrack, type JSX } from 'solid-js';
import { CloseIcon, CopyIcon, ExternalLinkIcon, LinkIcon, PlayIcon } from './icons';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { formatRelativeAge } from '../lib/relativeAge';
import { cardChecklist, cardSummary, type KanbanCard } from '../lib/kanban';
import { store } from '../store/core';
import { getAgentHookStatus } from '../store/agentHookStatus';
import { getPrChecks } from '../store/pr-checks-state';
import { computeAttentionEntries, jumpToWaitingTask } from '../store/sidebar-attention';
import { getReadyLabel, getTaskAttentionState } from '../store/taskStatus';
import { showNotification } from '../store/notification';
import type { Task } from '../store/types';

/** How a linked task is doing, from the card's point of view. */
export type CardTaskState = 'needs_input' | 'error' | 'review' | 'active' | 'ready' | 'idle';

const [now, setNow] = createSignal(Date.now());
let clockUsers = 0;
let clock: ReturnType<typeof setInterval> | undefined;

/** A minute clock for "working 3m" labels, running only while a board is open. */
export function useKanbanClock(): () => void {
  clockUsers++;
  if (!clock) clock = setInterval(() => setNow(Date.now()), 30_000);
  return () => {
    clockUsers--;
    if (clockUsers === 0 && clock) {
      clearInterval(clock);
      clock = undefined;
    }
  };
}

/** The open task of this project working on `branch`, if any. */
export function linkedTask(projectId: string, branch: string): Task | undefined {
  return Object.values(store.tasks).find(
    (task) => task?.projectId === projectId && task.branchName === branch,
  );
}

export function cardTaskState(task: Task): CardTaskState {
  const state = getTaskAttentionState(task.id);
  if (state === 'needs_input' || state === 'error' || state === 'review' || state === 'active') {
    return state;
  }
  if (task.signalDoneReceived || task.landingState === 'landed_pending_review') return 'review';
  return state === 'ready' ? 'ready' : 'idle';
}

/** The most urgent state among a card's linked tasks, or null without live tasks. */
export function cardState(projectId: string, card: KanbanCard): CardTaskState | null {
  const order: CardTaskState[] = ['needs_input', 'error', 'review', 'active', 'ready', 'idle'];
  let best: CardTaskState | null = null;
  for (const branch of card.branches) {
    const task = linkedTask(projectId, branch);
    if (!task) continue;
    const state = cardTaskState(task);
    if (best === null || order.indexOf(state) < order.indexOf(best)) best = state;
  }
  return best;
}

function stateLabel(task: Task, state: CardTaskState): string {
  switch (state) {
    case 'needs_input':
      return 'Needs input';
    case 'error':
      return 'Failed';
    case 'review':
      return 'Ready for review';
    case 'active':
      return 'Working';
    case 'ready':
      return getReadyLabel(task.id);
    default:
      return 'Idle';
  }
}

function firstLine(text: string | undefined): string {
  return (
    (text ?? '')
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? ''
  );
}

/** One line about what the task's agent is doing or last said. */
function activityLine(task: Task): { text: string; since?: number } {
  const hook = task.agentIds.map(getAgentHookStatus).find((status) => status !== null);
  if (hook?.state === 'working' && hook.toolName) {
    return {
      text: [hook.toolName, firstLine(hook.detail)].filter(Boolean).join(' · '),
      since: hook.since,
    };
  }
  const said = firstLine(hook?.lastAssistantMessage);
  if (said) return { text: said, since: hook?.since };
  // Nothing reported yet: name the agent rather than echo the prompt, which
  // starts with the card's own title.
  const agent = task.agentIds.map((id) => store.agents[id]?.def?.name).find(Boolean);
  return { text: agent ?? '', since: hook?.since };
}

function openTask(task: Task): void {
  const question = computeAttentionEntries().find(
    (entry) => entry.taskId === task.id && entry.kind === 'question',
  );
  jumpToWaitingTask(task.id, question?.panel ?? null);
}

function TaskRow(props: { task: Task }) {
  const state = createMemo(() => cardTaskState(props.task));
  const activity = createMemo(() => activityLine(props.task));
  const checks = () => getPrChecks(props.task.id)?.overall;
  const urgent = () => state() === 'needs_input' || state() === 'error';
  return (
    <li class={`kanban-task state-${state()}`}>
      <div class="kanban-task-head">
        <span class="kanban-dot" aria-hidden="true" />
        <span class="kanban-task-state">{stateLabel(props.task, state())}</span>
        <Show when={state() === 'active' && activity().since}>
          {(since) => <span class="kanban-task-age">{formatRelativeAge(since(), now())}</span>}
        </Show>
        <Show when={props.task.prUrl}>
          {(url) => (
            <button
              type="button"
              class={`kanban-chip pr-${checks() ?? 'none'}`}
              title={`Open pull request${checks() ? ` (checks: ${checks()})` : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                void invoke(IPC.ShellOpenExternal, { url: url() });
              }}
            >
              PR
              {checks() === 'success'
                ? ' ✓'
                : checks() === 'failure'
                  ? ' ✕'
                  : checks() === 'pending'
                    ? ' …'
                    : ''}
            </button>
          )}
        </Show>
        <button
          type="button"
          class="kanban-task-open"
          classList={{ urgent: urgent() }}
          title={urgent() ? 'Open the task where the agent waits' : `Open task ${props.task.name}`}
          onClick={(e) => {
            e.stopPropagation();
            openTask(props.task);
          }}
        >
          {state() === 'needs_input' ? 'Answer' : state() === 'error' ? 'Show' : 'Open'}
          <ExternalLinkIcon size={10} />
        </button>
      </div>
      {/* Always rendered so a task starting or stopping never changes the card's height. */}
      <p class="kanban-task-activity" title={activity().text}>
        {activity().text || ' '}
      </p>
    </li>
  );
}

function BranchRow(props: { branch: string }) {
  return (
    <li class="kanban-task state-gone">
      <div class="kanban-task-head">
        <span class="kanban-branch" title="No open task works on this branch">
          {props.branch}
        </span>
        <button
          type="button"
          class="kanban-icon"
          title="Copy branch name"
          aria-label={`Copy branch name ${props.branch}`}
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard
              ?.writeText(props.branch)
              .then(() => showNotification('Branch name copied'));
          }}
        >
          <CopyIcon size={11} />
        </button>
      </div>
    </li>
  );
}

export interface KanbanCardViewProps {
  card: KanbanCard;
  projectId: string;
  /** Open dependencies (cards on the board that are not done yet). */
  blockedBy: string[];
  selected: boolean;
  tabIndex: number;
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

export function KanbanCardView(props: KanbanCardViewProps) {
  const checklist = createMemo(() => cardChecklist(props.card));
  const summary = createMemo(() => cardSummary(props.card));
  const tasks = createMemo(() =>
    props.card.branches.map((branch) => ({ branch, task: linkedTask(props.projectId, branch) })),
  );
  const state = createMemo(() => cardState(props.projectId, props.card));
  const checked = () => checklist().filter((item) => item.done).length;
  return (
    <article
      class="kanban-card"
      classList={{
        done: props.card.done,
        selected: props.selected,
        'drop-before': props.dropBefore,
        dragging: props.dragging,
        flash: props.flash,
        asking: state() === 'needs_input',
        failed: state() === 'error',
        blocked: props.blockedBy.length > 0,
      }}
      data-card={props.dataRef}
      tabIndex={props.tabIndex}
      aria-label={props.card.title}
      draggable={true}
      onFocus={() => props.onSelect()}
      onDragStart={(e) => props.onDragStart(e)}
      onDragEnd={() => props.onDragEnd()}
      onDragOver={(e) => props.onDragOver(e)}
      onDrop={(e) => props.onDrop(e)}
      onDblClick={(e) => {
        if (!(e.target as HTMLElement).closest('button, input, a')) props.onEdit();
      }}
    >
      <div class="kanban-card-title">
        <label class="kanban-done">
          <input
            type="checkbox"
            checked={props.card.done}
            tabIndex={-1}
            aria-label={`Done: ${props.card.title}`}
            onChange={(e) => props.onToggleDone(e.currentTarget.checked)}
          />
          <span class="kanban-done-mark" aria-hidden="true" />
        </label>
        <span>{props.card.title}</span>
      </div>
      <Show when={summary()}>
        <p class="kanban-card-body">{summary()}</p>
      </Show>
      <Show when={checklist().length}>
        <ul class="kanban-checklist" aria-label="Checklist">
          <For each={checklist().slice(0, 5)}>
            {(item) => (
              <li classList={{ done: item.done }}>
                <label>
                  <input
                    type="checkbox"
                    checked={item.done}
                    tabIndex={-1}
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
        <ul class="kanban-tasks" aria-label="Tasks">
          <For each={tasks()}>
            {(entry) => (
              <Show when={entry.task} fallback={<BranchRow branch={entry.branch} />}>
                {(task) => <TaskRow task={task()} />}
              </Show>
            )}
          </For>
        </ul>
      </Show>
      {/* A done card has nothing to start; keep only its checklist progress. */}
      <Show when={!props.card.done || checklist().length}>
        <div class="kanban-card-footer">
          <Show when={!props.card.done}>
            <button
              type="button"
              class="kanban-start"
              tabIndex={-1}
              title={
                props.blockedBy.length
                  ? `Waits for ${props.blockedBy.join(', ')}; start anyway`
                  : 'Start a task from this card (S)'
              }
              onClick={(e) => {
                e.stopPropagation();
                props.onStart();
              }}
            >
              <PlayIcon size={10} /> {props.card.branches.length ? 'Start another' : 'Start task'}
            </button>
          </Show>
          <span class="kanban-card-meta">
            <Show when={checklist().length}>
              <span
                class="kanban-progress"
                classList={{ complete: checked() === checklist().length }}
                title="Checklist"
              >
                {checked()}/{checklist().length}
              </span>
            </Show>
          </span>
        </div>
      </Show>
    </article>
  );
}

export function KanbanCardEditor(props: {
  card: KanbanCard;
  columns: string[];
  column: number;
  /** Titles of the other cards, for dependencies. */
  otherTitles: string[];
  onSave: (change: { title: string; body: string; depends: string[] }, column: number) => void;
  onDelete: () => void;
  onArchive: () => void;
  onCancel: () => void;
}) {
  const initial = untrack(() => props.card);
  const [title, setTitle] = createSignal(initial.title);
  const [body, setBody] = createSignal(initial.body);
  const [depends, setDepends] = createSignal<string[]>([...initial.depends]);
  const [column, setColumn] = createSignal(untrack(() => props.column));
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
  const save = () => props.onSave({ title: title(), body: body(), depends: depends() }, column());
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
      class="kanban-card kanban-card-editor"
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
              <option value="">Add card…</option>
              <For each={candidates()}>{(t) => <option value={t}>{t}</option>}</For>
            </select>
          </Show>
        </div>
      </div>
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
        <span class="kanban-spacer" />
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
