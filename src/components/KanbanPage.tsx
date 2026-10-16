import {
  For,
  Index,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from 'solid-js';
import { ConfirmDialog } from './ConfirmDialog';
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SyncIcon,
  TrashIcon,
} from './icons';
import { store } from '../store/core';
import { setActiveTask } from '../store/navigation';
import { uncollapseTask } from '../store/tasks';
import { openKanban, readKanbanFile, startKanbanCardTask, writeKanbanFile } from '../store/kanban';
import { showNotification } from '../store/notification';
import {
  DEFAULT_KANBAN_MARKDOWN,
  addCard,
  addColumn,
  moveCard,
  moveColumn,
  parseKanban,
  removeCard,
  removeColumn,
  renameColumn,
  serializeKanban,
  updateCard,
  type KanbanBoard,
  type KanbanCard,
  type KanbanCardRef,
} from '../lib/kanban';
import { openFileInEditor } from '../lib/shell';
import { errMessage } from '../lib/log';
import type { Project, Task } from '../store/types';
import './kanban.css';

/** How often the open board checks KANBAN.md for edits made elsewhere. */
const POLL_MS = 2000;
/** dataTransfer type for card drags; not text/plain, which the app treats as a dropped link. */
const CARD_DRAG_TYPE = 'application/x-parallel-code-kanban-card';
const COLUMN_DRAG_TYPE = 'application/x-parallel-code-kanban-column';

export function KanbanPage() {
  const project = createMemo(() =>
    store.kanbanEnabled ? store.projects.find((p) => p.id === store.kanbanProjectId) : undefined,
  );
  return (
    <Show when={project()} keyed>
      {(p) => <KanbanBoardView project={p} />}
    </Show>
  );
}

type Pending =
  | { kind: 'card'; ref: KanbanCardRef; title: string }
  | { kind: 'column'; index: number; title: string; cards: number };

function KanbanBoardView(props: { project: Project }) {
  const root = untrack(() => props.project.path);
  // undefined: loading; null: the project has no KANBAN.md yet.
  const [text, setText] = createSignal<string | null | undefined>(undefined);
  const [error, setError] = createSignal('');
  const [editing, setEditing] = createSignal<KanbanCardRef | null>(null);
  const [renaming, setRenaming] = createSignal<number | null>(null);
  const [adding, setAdding] = createSignal<number | null>(null);
  const [pending, setPending] = createSignal<Pending | null>(null);
  const [dragOver, setDragOver] = createSignal<{ column: number; card: number | null } | null>(
    null,
  );
  const board = createMemo(() => {
    const value = text();
    return typeof value === 'string' ? parseKanban(value) : null;
  });
  let writes: Promise<void> = Promise.resolve();
  let writing = 0;
  let disposed = false;
  onCleanup(() => (disposed = true));

  async function reload(): Promise<void> {
    try {
      const current = await readKanbanFile(root);
      if (disposed) return;
      setError('');
      if (current !== text()) setText(current);
    } catch (err) {
      if (!disposed) setError(errMessage(err));
    }
  }

  // Follow edits made in an editor or by an agent. An open editor would lose
  // its place if the cards under it moved, so wait until it closes.
  onMount(() => {
    void reload();
    const timer = setInterval(() => {
      if (writing || editing() || renaming() !== null || adding() !== null) return;
      void reload();
    }, POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  function onWriteError(err: unknown): Promise<void> {
    showNotification(`Could not save KANBAN.md: ${errMessage(err)}`);
    return reload();
  }

  /** Shows the change at once and writes it; on a refused write reloads the file. */
  function save(next: KanbanBoard | string): void {
    const content = typeof next === 'string' ? next : serializeKanban(next);
    const expected = text() ?? null;
    if (content === expected) return;
    setText(content);
    writing++;
    writes = writes
      .then(() => writeKanbanFile(root, content, expected))
      .catch(onWriteError)
      .finally(() => writing--);
  }

  function change(fn: (b: KanbanBoard) => KanbanBoard): void {
    const current = board();
    if (current) save(fn(current));
  }

  function startTask(ref: KanbanCardRef): void {
    const current = board();
    if (!current) return;
    if (!startKanbanCardTask(props.project.id, current, ref)) {
      showNotification('Finish or dismiss your open task draft before starting another.');
    }
  }

  function confirmPending(): void {
    const item = pending();
    setPending(null);
    if (!item) return;
    if (item.kind === 'card') change((b) => removeCard(b, item.ref));
    else change((b) => removeColumn(b, item.index));
  }

  function dropCard(e: DragEvent, column: number, card?: number): void {
    const raw = e.dataTransfer?.getData(CARD_DRAG_TYPE);
    setDragOver(null);
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    const [fromColumn, fromCard] = raw.split(':').map(Number);
    change((b) => moveCard(b, { column: fromColumn, card: fromCard }, column, card));
  }

  function dropColumn(e: DragEvent, column: number): void {
    const raw = e.dataTransfer?.getData(COLUMN_DRAG_TYPE);
    if (!raw) return;
    e.preventDefault();
    setDragOver(null);
    change((b) => moveColumn(b, Number(raw), column));
  }

  function acceptsDrag(e: DragEvent): boolean {
    const types = e.dataTransfer?.types ?? [];
    return types.includes(CARD_DRAG_TYPE) || types.includes(COLUMN_DRAG_TYPE);
  }

  return (
    <section class="kanban" aria-labelledby="kanban-title">
      <header class="kanban-heading">
        <div>
          <h2 id="kanban-title">
            {board()?.title || 'Kanban'} <span>· {props.project.name}</span>
          </h2>
          <small>KANBAN.md · plain Markdown, edits made elsewhere show up here</small>
        </div>
        <div class="kanban-actions">
          <button type="button" onClick={() => void reload()}>
            <SyncIcon /> Reload
          </button>
          <Show when={text()}>
            <button
              type="button"
              title="Open KANBAN.md in your editor"
              onClick={() =>
                void openFileInEditor(root, 'KANBAN.md', {
                  editorCommand: store.editorCommand,
                }).catch((err: unknown) => showNotification(errMessage(err)))
              }
            >
              <ExternalLinkIcon /> Open file
            </button>
          </Show>
          <button type="button" onClick={() => openKanban(null)}>
            <ArrowLeftIcon /> Back to tasks
          </button>
        </div>
      </header>
      <Show when={error()}>
        <p role="alert" class="kanban-error">
          {error()}
        </p>
      </Show>
      <Show when={text() === null}>
        <div class="kanban-empty">
          <p>This project has no Kanban board yet.</p>
          <p>
            <small>
              The board is saved as <code>KANBAN.md</code> in the project root, a plain Markdown
              file you can edit, commit and hand to agents.
            </small>
          </p>
          <button
            type="button"
            class="kanban-primary"
            onClick={() => save(DEFAULT_KANBAN_MARKDOWN)}
          >
            <PlusIcon /> Create board
          </button>
        </div>
      </Show>
      <Show when={board()}>
        {(b) => (
          <div class="kanban-columns">
            <Index each={b().columns}>
              {(column, columnIndex) => (
                <section
                  class="kanban-column"
                  classList={{
                    'drag-over': dragOver()?.column === columnIndex && dragOver()?.card === null,
                  }}
                  aria-label={column().title}
                  onDragOver={(e) => {
                    if (!acceptsDrag(e)) return;
                    e.preventDefault();
                    if (e.dataTransfer?.types.includes(CARD_DRAG_TYPE)) {
                      setDragOver({ column: columnIndex, card: null });
                    }
                  }}
                  onDragLeave={(e) => {
                    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
                      setDragOver(null);
                    }
                  }}
                  onDrop={(e) => {
                    if (e.dataTransfer?.types.includes(COLUMN_DRAG_TYPE))
                      dropColumn(e, columnIndex);
                    else dropCard(e, columnIndex);
                  }}
                >
                  <header
                    class="kanban-column-header"
                    draggable={renaming() !== columnIndex}
                    onDragStart={(e) => {
                      e.dataTransfer?.setData(COLUMN_DRAG_TYPE, String(columnIndex));
                    }}
                  >
                    <Show
                      when={renaming() === columnIndex}
                      fallback={
                        <h3
                          title="Double-click to rename"
                          onDblClick={() => setRenaming(columnIndex)}
                        >
                          {column().title}
                          <span class="kanban-count">{column().cards.length}</span>
                        </h3>
                      }
                    >
                      <InlineField
                        value={column().title}
                        label="Column name"
                        onCommit={(value) => {
                          setRenaming(null);
                          change((cur) => renameColumn(cur, columnIndex, value));
                        }}
                        onCancel={() => setRenaming(null)}
                      />
                    </Show>
                    <button
                      type="button"
                      class="kanban-icon"
                      title={`Delete column ${column().title}`}
                      aria-label={`Delete column ${column().title}`}
                      disabled={b().columns.length < 2 && column().cards.length > 0}
                      onClick={() =>
                        setPending({
                          kind: 'column',
                          index: columnIndex,
                          title: column().title,
                          cards: column().cards.length,
                        })
                      }
                    >
                      <TrashIcon size={12} />
                    </button>
                  </header>
                  <Show when={column().notes}>
                    <p class="kanban-notes">{column().notes}</p>
                  </Show>
                  <div class="kanban-cards">
                    <Index each={column().cards}>
                      {(card, cardIndex) => {
                        const ref = () => ({ column: columnIndex, card: cardIndex });
                        const isEditing = () =>
                          editing()?.column === columnIndex && editing()?.card === cardIndex;
                        return (
                          <Show
                            when={isEditing()}
                            fallback={
                              <KanbanCardView
                                card={card()}
                                projectId={props.project.id}
                                dropBefore={
                                  dragOver()?.column === columnIndex &&
                                  dragOver()?.card === cardIndex
                                }
                                onDragStart={(e) =>
                                  e.dataTransfer?.setData(
                                    CARD_DRAG_TYPE,
                                    `${columnIndex}:${cardIndex}`,
                                  )
                                }
                                onDragOver={(e) => {
                                  if (!e.dataTransfer?.types.includes(CARD_DRAG_TYPE)) return;
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setDragOver({ column: columnIndex, card: cardIndex });
                                }}
                                onDrop={(e) => dropCard(e, columnIndex, cardIndex)}
                                onEdit={() => setEditing(ref())}
                                onStart={() => startTask(ref())}
                                onToggleDone={(done) =>
                                  change((cur) => updateCard(cur, ref(), { done }))
                                }
                              />
                            }
                          >
                            <KanbanCardEditor
                              card={card()}
                              columns={b().columns.map((c) => c.title)}
                              column={columnIndex}
                              onSave={(next, toColumn) => {
                                setEditing(null);
                                change((cur) => {
                                  const updated = updateCard(cur, ref(), next);
                                  return toColumn === columnIndex
                                    ? updated
                                    : moveCard(updated, ref(), toColumn);
                                });
                              }}
                              onDelete={() => {
                                setEditing(null);
                                setPending({ kind: 'card', ref: ref(), title: card().title });
                              }}
                              onCancel={() => setEditing(null)}
                            />
                          </Show>
                        );
                      }}
                    </Index>
                  </div>
                  <Show
                    when={adding() === columnIndex}
                    fallback={
                      <button
                        type="button"
                        class="kanban-add-card"
                        onClick={() => setAdding(columnIndex)}
                      >
                        <PlusIcon size={12} /> Add card
                      </button>
                    }
                  >
                    <InlineField
                      value=""
                      label="New card title"
                      placeholder="Card title, Enter to add"
                      keepOpen
                      onCommit={(value) => {
                        if (value.trim()) change((cur) => addCard(cur, columnIndex, value));
                        else setAdding(null);
                      }}
                      onCancel={() => setAdding(null)}
                    />
                  </Show>
                </section>
              )}
            </Index>
            <AddColumn onAdd={(title) => change((cur) => addColumn(cur, title))} />
          </div>
        )}
      </Show>
      <ConfirmDialog
        open={pending() !== null}
        title={pending()?.kind === 'column' ? 'Delete column?' : 'Delete card?'}
        message={(() => {
          const item = pending();
          if (!item) return '';
          if (item.kind === 'card') return `"${item.title}" is removed from KANBAN.md.`;
          return item.cards
            ? `"${item.title}" is removed; its ${item.cards} card(s) move to the neighbouring column.`
            : `"${item.title}" is removed from KANBAN.md.`;
        })()}
        confirmLabel="Delete"
        danger
        onConfirm={confirmPending}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}

/** Tasks of this project whose branch a card records. */
function linkedTask(projectId: string, branch: string): Task | undefined {
  return Object.values(store.tasks).find(
    (task) => task?.projectId === projectId && task.branchName === branch,
  );
}

function openTask(task: Task): void {
  openKanban(null);
  if (task.collapsed) uncollapseTask(task.id);
  setActiveTask(task.id);
}

function KanbanCardView(props: {
  card: KanbanCard;
  projectId: string;
  dropBefore: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onEdit: () => void;
  onStart: () => void;
  onToggleDone: (done: boolean) => void;
}) {
  return (
    <article
      class="kanban-card"
      classList={{ done: props.card.done, 'drop-before': props.dropBefore }}
      draggable={true}
      onDragStart={(e) => props.onDragStart(e)}
      onDragOver={(e) => props.onDragOver(e)}
      onDrop={(e) => props.onDrop(e)}
      onDblClick={(e) => {
        if (!(e.target as HTMLElement).closest('button, input, a')) props.onEdit();
      }}
    >
      <div class="kanban-card-title">
        <input
          type="checkbox"
          checked={props.card.done}
          aria-label={`Done: ${props.card.title}`}
          onChange={(e) => props.onToggleDone(e.currentTarget.checked)}
        />
        <span>{props.card.title}</span>
      </div>
      <Show when={props.card.body}>
        <p class="kanban-card-body">{props.card.body}</p>
      </Show>
      <Show when={props.card.branches.length}>
        <ul class="kanban-card-tasks" aria-label="Tasks">
          <For each={props.card.branches}>
            {(branch) => {
              const task = () => linkedTask(props.projectId, branch);
              return (
                <li>
                  <Show
                    when={task()}
                    fallback={
                      <span class="kanban-branch" title="No open task works on this branch">
                        {branch}
                      </span>
                    }
                  >
                    {(t) => (
                      <button
                        type="button"
                        class="kanban-task-link"
                        title={`Open task on ${branch}`}
                        onClick={() => openTask(t())}
                      >
                        {t().name} <ExternalLinkIcon size={11} />
                      </button>
                    )}
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <div class="kanban-card-actions">
        <button type="button" onClick={() => props.onStart()} title="Start a task from this card">
          <PlayIcon size={11} /> {props.card.branches.length ? 'Start another task' : 'Start task'}
        </button>
        <button
          type="button"
          class="kanban-icon"
          title="Edit card"
          aria-label={`Edit card ${props.card.title}`}
          onClick={() => props.onEdit()}
        >
          <PencilIcon size={12} />
        </button>
      </div>
    </article>
  );
}

function KanbanCardEditor(props: {
  card: KanbanCard;
  columns: string[];
  column: number;
  onSave: (change: { title: string; body: string }, column: number) => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const initial = untrack(() => props.card);
  const [title, setTitle] = createSignal(initial.title);
  const [body, setBody] = createSignal(initial.body);
  const [column, setColumn] = createSignal(untrack(() => props.column));
  let titleRef: HTMLInputElement | undefined;
  onMount(() => titleRef?.focus());
  const save = () => props.onSave({ title: title(), body: body() }, column());
  const onKeyDown: JSX.EventHandler<HTMLElement, KeyboardEvent> = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      props.onCancel();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    }
  };
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
        aria-label="Card title"
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
      />
      <textarea
        aria-label="Description"
        placeholder="Description (Markdown). Becomes the task prompt."
        rows={5}
        value={body()}
        onInput={(e) => setBody(e.currentTarget.value)}
      />
      <label class="kanban-move">
        Column
        <select value={column()} onChange={(e) => setColumn(Number(e.currentTarget.value))}>
          <For each={props.columns}>{(name, i) => <option value={i()}>{name}</option>}</For>
        </select>
      </label>
      <div class="kanban-card-actions">
        <button type="submit" class="kanban-primary">
          Save
        </button>
        <button type="button" onClick={() => props.onCancel()}>
          Cancel
        </button>
        <button
          type="button"
          class="kanban-icon kanban-delete"
          title="Delete card"
          aria-label="Delete card"
          onClick={() => props.onDelete()}
        >
          <TrashIcon size={12} />
        </button>
      </div>
    </form>
  );
}

/** A one-line field that commits on Enter or blur and cancels on Escape. */
function InlineField(props: {
  value: string;
  label: string;
  placeholder?: string;
  /** Clear and stay open after Enter, for adding several items in a row. */
  keepOpen?: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  let ref: HTMLInputElement | undefined;
  let done = false;
  onMount(() => {
    ref?.focus();
    ref?.select();
  });
  return (
    <input
      ref={ref}
      class="kanban-inline-field"
      aria-label={props.label}
      placeholder={props.placeholder}
      value={props.value}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          done = true;
          props.onCancel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const value = e.currentTarget.value;
          if (props.keepOpen && value.trim()) {
            e.currentTarget.value = '';
            props.onCommit(value);
            return;
          }
          done = true;
          props.onCommit(value);
        }
      }}
      onBlur={(e) => {
        if (done) return;
        done = true;
        const value = e.currentTarget.value;
        if (!props.keepOpen) {
          props.onCommit(value);
          return;
        }
        if (value.trim()) props.onCommit(value);
        props.onCancel();
      }}
    />
  );
}

function AddColumn(props: { onAdd: (title: string) => void }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="kanban-add-column">
      <Show
        when={open()}
        fallback={
          <button type="button" class="kanban-add-card" onClick={() => setOpen(true)}>
            <PlusIcon size={12} /> Add column
          </button>
        }
      >
        <InlineField
          value=""
          label="New column name"
          placeholder="Column name"
          onCommit={(value) => {
            setOpen(false);
            if (value.trim()) props.onAdd(value);
          }}
          onCancel={() => setOpen(false)}
        />
      </Show>
    </div>
  );
}
