import {
  For,
  Index,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';
import { createAgentPaneState, GitHubAgentPane, type AgentPaneState } from './GitHubAgentPane';
import { KanbanCardEditor, KanbanCardView, cardState, useKanbanClock } from './KanbanCard';
import { ResizablePanel, type PanelChild } from './ResizablePanel';
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  PlusIcon,
  SearchIcon,
  SparkleIcon,
  SyncIcon,
  TrashIcon,
} from './icons';
import { githubAgentTaskId } from '../documents/task-id';
import { store } from '../store/core';
import { triggerFocus } from '../store/focused-panel';
import {
  openKanban,
  prefillKanbanPlanPrompt,
  readKanbanFile,
  startKanbanCardTask,
  writeKanbanFile,
} from '../store/kanban';
import { showNotification } from '../store/notification';
import {
  DEFAULT_KANBAN_MARKDOWN,
  addCard,
  addColumn,
  archiveCard,
  isArchiveColumn,
  moveCard,
  moveColumn,
  openDependencies,
  parseKanban,
  removeCard,
  removeColumn,
  renameColumn,
  serializeKanban,
  titlesFromInput,
  toggleChecklistItem,
  updateCard,
  type KanbanBoard,
  type KanbanCard,
  type KanbanCardRef,
} from '../lib/kanban';
import { openFileInEditor } from '../lib/shell';
import { errMessage } from '../lib/log';
import type { Project } from '../store/types';
import './github-issues.css';
import './kanban.css';

/** How often the open board checks KANBAN.md for edits made elsewhere. */
const POLL_MS = 1500;
/** How long Undo stays offered after a delete. */
const UNDO_MS = 8000;
/** dataTransfer types for drags; not text/plain, which the app treats as a dropped link. */
const CARD_DRAG_TYPE = 'application/x-parallel-code-kanban-card';
const COLUMN_DRAG_TYPE = 'application/x-parallel-code-kanban-column';
/** Below this width the agent overlays the board instead of squeezing it. Keep in
 *  sync with the @container query the GitHub page's CSS shares with this page. */
const OVERLAY_BELOW_PX = 900;

type QuickFilter = 'all' | 'attention' | 'running' | 'blocked' | 'ready';

/** Per-project view state that survives leaving and reopening the board. */
interface BoardSession {
  collapsed: Record<string, boolean>;
  query: string;
  quick: QuickFilter;
  scrollLeft: number;
}
const sessions = new Map<string, BoardSession>();
function boardSession(projectId: string): BoardSession {
  let session = sessions.get(projectId);
  if (!session) {
    session = { collapsed: {}, query: '', quick: 'all', scrollLeft: 0 };
    sessions.set(projectId, session);
  }
  return session;
}

export function KanbanPage() {
  const project = createMemo(() => store.projects.find((p) => p.id === store.kanbanProjectId));
  return (
    <Show when={project()} keyed>
      {(p) => <KanbanLayout project={p} />}
    </Show>
  );
}

function KanbanLayout(props: { project: Project }) {
  const projectId = untrack(() => props.project.id);
  const pane = createAgentPaneState(projectId);
  const [overlaid, setOverlaid] = createSignal(false);
  let shell: HTMLDivElement | undefined;
  onMount(() => {
    if (!shell || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) =>
      setOverlaid(entry.contentRect.width < OVERLAY_BELOW_PX),
    );
    observer.observe(shell);
    onCleanup(() => observer.disconnect());
  });
  const covered = () => overlaid() && pane.open();
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || !covered()) return;
    if ((e.target as HTMLElement).closest('.xterm, input, textarea, [contenteditable]')) return;
    pane.setOpen(false);
  }
  const board: PanelChild = {
    id: 'board',
    minSize: 420,
    content: () => <KanbanBoardView project={props.project} agentPane={pane} covered={covered()} />,
  };
  const agent: PanelChild = {
    id: 'agent',
    minSize: 280,
    defaultSize: 420,
    resizeLabel: 'Resize agent pane',
    content: () => (
      <GitHubAgentPane
        project={props.project}
        agentPane={pane}
        label="Planning agent"
        hint="Runs in the project checkout and edits KANBAN.md directly; the board follows. Ask it to break a goal into cards."
      />
    ),
  };
  return (
    <div class="github-page-shell" ref={shell} onKeyDown={onKeyDown}>
      <ResizablePanel
        direction="horizontal"
        persistKey="kanban-agent"
        class="github-page"
        absorberIds={['board']}
        children={pane.open() ? [board, agent] : [board]}
      />
      <Show when={covered()}>
        <div class="github-page-scrim" aria-hidden="true" onClick={() => pane.setOpen(false)} />
      </Show>
    </div>
  );
}

type SaveState = 'idle' | 'saving' | 'saved' | 'external' | 'error';

interface UndoOffer {
  label: string;
  /** The board text to restore, and the text the undo expects to find. */
  before: string;
  after: string;
}

function cardKey(column: string, card: KanbanCard): string {
  return JSON.stringify([column, card.title, card.body, card.done, card.branches, card.depends]);
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !!target.closest('input, textarea, select, [contenteditable], .xterm')
  );
}

function KanbanBoardView(props: { project: Project; agentPane: AgentPaneState; covered: boolean }) {
  const root = untrack(() => props.project.path);
  const projectId = untrack(() => props.project.id);
  const session = boardSession(projectId);
  // undefined: loading; null: the project has no KANBAN.md yet.
  const [text, setText] = createSignal<string | null | undefined>(undefined);
  const [error, setError] = createSignal('');
  const [saveState, setSaveState] = createSignal<SaveState>('idle');
  const [editing, setEditing] = createSignal<KanbanCardRef | null>(null);
  const [renaming, setRenaming] = createSignal<number | null>(null);
  const [adding, setAdding] = createSignal<number | null>(null);
  const [selected, setSelected] = createSignal<KanbanCardRef | null>(null);
  const [query, setQuery] = createSignal(session.query);
  const [quick, setQuick] = createSignal<QuickFilter>(session.quick);
  const [collapsed, setCollapsed] = createSignal<Record<string, boolean>>({ ...session.collapsed });
  const [undo, setUndo] = createSignal<UndoOffer | null>(null);
  const [flashed, setFlashed] = createSignal<ReadonlySet<string>>(new Set());
  const [dragging, setDragging] = createSignal<KanbanCardRef | null>(null);
  const [dragOver, setDragOver] = createSignal<{ column: number; card: number | null } | null>(
    null,
  );
  const [showHelp, setShowHelp] = createSignal(false);
  const board = createMemo(() => {
    const value = text();
    return typeof value === 'string' ? parseKanban(value) : null;
  });
  let section: HTMLElement | undefined;
  let columnsRef: HTMLDivElement | undefined;
  let filterRef: HTMLInputElement | undefined;
  let writes: Promise<void> = Promise.resolve();
  let writing = 0;
  let disposed = false;
  let undoTimer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  const stopClock = useKanbanClock();
  onCleanup(() => {
    disposed = true;
    stopClock();
    clearTimeout(undoTimer);
    clearTimeout(flashTimer);
    clearTimeout(savedTimer);
    Object.assign(session, {
      collapsed: collapsed(),
      query: query(),
      quick: quick(),
      scrollLeft: columnsRef?.scrollLeft ?? session.scrollLeft,
    });
  });

  function settleSaveState(state: SaveState): void {
    setSaveState(state);
    clearTimeout(savedTimer);
    if (state === 'saved' || state === 'external') {
      savedTimer = setTimeout(() => setSaveState('idle'), 2000);
    }
  }

  /** Marks cards that changed outside the app so the eye finds them. */
  function flashChanges(before: KanbanBoard | null, after: KanbanBoard | null): void {
    if (!before || !after) return;
    const known = new Set(
      before.columns.flatMap((column) => column.cards.map((card) => cardKey(column.title, card))),
    );
    const changed = new Set(
      after.columns.flatMap((column) =>
        column.cards.map((card) => cardKey(column.title, card)).filter((key) => !known.has(key)),
      ),
    );
    if (!changed.size) return;
    setFlashed(changed);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlashed(new Set<string>()), 1600);
  }

  async function reload(): Promise<void> {
    try {
      const current = await readKanbanFile(root);
      if (disposed) return;
      setError('');
      const previous = text();
      if (current === previous) return;
      const before = untrack(board);
      setText(current);
      if (typeof previous === 'string' && typeof current === 'string') {
        flashChanges(before, untrack(board));
        settleSaveState('external');
      }
    } catch (err) {
      if (!disposed) setError(errMessage(err));
    }
  }

  // Follow edits made in an editor or by an agent. An open editor would lose
  // its place if the cards under it moved, so wait until it closes.
  onMount(() => {
    void reload().then(() => {
      if (columnsRef) columnsRef.scrollLeft = session.scrollLeft;
    });
    const timer = setInterval(() => {
      if (writing || editing() || renaming() !== null || adding() !== null) return;
      void reload();
    }, POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  function onWriteError(err: unknown): Promise<void> {
    settleSaveState('error');
    showNotification(`Could not save KANBAN.md: ${errMessage(err)}`);
    return reload();
  }

  /** Shows the change at once and writes it; on a refused write reloads the file. */
  function save(next: KanbanBoard | string): void {
    const content = typeof next === 'string' ? next : serializeKanban(next);
    const expected = text() ?? null;
    if (content === expected) return;
    setText(content);
    setSaveState('saving');
    writing++;
    writes = writes
      .then(() => writeKanbanFile(root, content, expected))
      .then(() => {
        if (writing === 1) settleSaveState('saved');
      }, onWriteError)
      .finally(() => writing--);
  }

  function change(fn: (b: KanbanBoard) => KanbanBoard): void {
    const current = board();
    if (current) save(fn(current));
  }

  /** Applies a destructive change and offers to take it back. */
  function changeWithUndo(label: string, fn: (b: KanbanBoard) => KanbanBoard): void {
    const before = text();
    const current = board();
    if (typeof before !== 'string' || !current) return;
    const after = serializeKanban(fn(current));
    save(after);
    setUndo({ label, before, after });
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => setUndo(null), UNDO_MS);
  }

  function runUndo(): void {
    const offer = undo();
    setUndo(null);
    clearTimeout(undoTimer);
    if (!offer) return;
    if (text() !== offer.after) {
      showNotification('The board changed since; undo is no longer possible');
      return;
    }
    save(offer.before);
  }

  const card = (ref: KanbanCardRef | null) =>
    ref ? board()?.columns[ref.column]?.cards[ref.card] : undefined;

  function startTask(ref: KanbanCardRef): void {
    const current = board();
    if (!current) return;
    if (!startKanbanCardTask(projectId, current, ref)) {
      showNotification('Finish or dismiss your open task draft before starting another.');
    }
  }

  function deleteCard(ref: KanbanCardRef): void {
    const removed = card(ref);
    if (!removed) return;
    setEditing(null);
    changeWithUndo(`Deleted “${removed.title}”`, (b) => removeCard(b, ref));
    clampSelection(ref);
  }

  function archive(ref: KanbanCardRef): void {
    const archived = card(ref);
    if (!archived) return;
    setEditing(null);
    changeWithUndo(`Archived “${archived.title}”`, (b) => archiveCard(b, ref));
    clampSelection(ref);
  }

  function deleteColumn(index: number): void {
    const column = board()?.columns[index];
    if (!column) return;
    changeWithUndo(
      column.cards.length
        ? `Deleted column “${column.title}”; its cards moved to the neighbouring column`
        : `Deleted column “${column.title}”`,
      (b) => removeColumn(b, index),
    );
  }

  /** Adds one card per line; pasting a list adds the whole list. */
  function addCards(column: number, input: string): void {
    const titles = titlesFromInput(input);
    if (!titles.length) return;
    change((b) => titles.reduce((next, title) => addCard(next, column, title), b));
  }

  // --- Filtering ---

  const filterActive = () => query().trim() !== '' || quick() !== 'all';

  function matches(b: KanbanBoard, ref: KanbanCardRef): boolean {
    const c = b.columns[ref.column]?.cards[ref.card];
    if (!c) return false;
    const q = query().trim().toLowerCase();
    if (q && !`${c.title}\n${c.body}\n${c.branches.join(' ')}`.toLowerCase().includes(q)) {
      return false;
    }
    const state = cardState(projectId, c);
    switch (quick()) {
      case 'attention':
        return state === 'needs_input' || state === 'error' || state === 'review';
      case 'running':
        return state === 'active';
      case 'blocked':
        return openDependencies(b, ref).length > 0;
      case 'ready':
        return !c.done && !c.branches.length && !openDependencies(b, ref).length;
      default:
        return true;
    }
  }

  /** Card indexes shown per column, in board order. */
  const visible = createMemo(() => {
    const b = board();
    if (!b) return [];
    return b.columns.map((column, ci) =>
      column.cards.map((_, i) => i).filter((i) => matches(b, { column: ci, card: i })),
    );
  });

  const summary = createMemo(() => {
    const b = board();
    const counts = { attention: 0, running: 0, review: 0, cards: 0, done: 0 };
    if (!b) return counts;
    for (const column of b.columns) {
      if (isArchiveColumn(column.title)) continue;
      for (const c of column.cards) {
        counts.cards++;
        if (c.done) counts.done++;
        const state = cardState(projectId, c);
        if (state === 'needs_input' || state === 'error') counts.attention++;
        else if (state === 'active') counts.running++;
        else if (state === 'review') counts.review++;
      }
    }
    return counts;
  });

  const isCollapsed = (title: string) => collapsed()[title] ?? isArchiveColumn(title);
  function toggleCollapsed(title: string): void {
    setCollapsed((current) => ({ ...current, [title]: !isCollapsed(title) }));
  }

  // --- Keyboard ---

  function focusCard(ref: KanbanCardRef | null): void {
    setSelected(ref);
    if (!ref) return;
    queueMicrotask(() =>
      section
        ?.querySelector<HTMLElement>(`[data-card="${ref.column}:${ref.card}"]`)
        ?.focus({ preventScroll: false }),
    );
  }

  /** Keeps the selection on a card after the one under it went away. */
  function clampSelection(ref: KanbanCardRef): void {
    const count = board()?.columns[ref.column]?.cards.length ?? 0;
    if (count === 0) setSelected(null);
    else focusCard({ column: ref.column, card: Math.min(ref.card, count - 1) });
  }

  function navigableColumns(): number[] {
    const b = board();
    if (!b) return [];
    return b.columns
      .map((column, i) => ({ column, i }))
      .filter(({ column, i }) => !isCollapsed(column.title) && visible()[i]?.length)
      .map(({ i }) => i);
  }

  function moveSelection(dx: number, dy: number): void {
    const current = selected();
    const columns = navigableColumns();
    if (!columns.length) return;
    if (!current || !columns.includes(current.column)) {
      focusCard({ column: columns[0], card: visible()[columns[0]][0] });
      return;
    }
    if (dy) {
      const shown = visible()[current.column];
      const at = Math.max(0, shown.indexOf(current.card));
      const next = shown[Math.max(0, Math.min(shown.length - 1, at + dy))];
      focusCard({ column: current.column, card: next });
      return;
    }
    const position = columns.indexOf(current.column) + dx;
    if (position < 0 || position >= columns.length) return;
    const target = columns[position];
    const at = Math.max(0, visible()[current.column].indexOf(current.card));
    const shown = visible()[target];
    focusCard({ column: target, card: shown[Math.min(at, shown.length - 1)] });
  }

  function moveSelected(dx: number, dy: number): void {
    const ref = selected();
    const b = board();
    if (!ref || !b) return;
    if (dy) {
      const to = ref.card + dy;
      if (to < 0 || to >= b.columns[ref.column].cards.length) return;
      change((cur) => moveCard(cur, ref, ref.column, dy > 0 ? to + 1 : to));
      focusCard({ column: ref.column, card: to });
      return;
    }
    const target = ref.column + dx;
    if (target < 0 || target >= b.columns.length) return;
    const index = Math.min(ref.card, b.columns[target].cards.length);
    change((cur) => moveCard(cur, ref, target, index));
    if (isCollapsed(b.columns[target].title)) toggleCollapsed(b.columns[target].title);
    focusCard({ column: target, card: index });
  }

  function onBoardKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    // A focused button keeps Enter and Space for itself.
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).closest('button, a')) {
      return;
    }
    if (editing() || renaming() !== null || adding() !== null) return;
    const ref = selected();
    const key = e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (key === '?') {
      handled();
      setShowHelp((open) => !open);
    } else if (key === 'Escape') {
      if (showHelp()) {
        handled();
        setShowHelp(false);
      } else if (filterActive()) {
        handled();
        setQuery('');
        setQuick('all');
      }
    } else if (key === '/') {
      handled();
      filterRef?.focus();
    } else if (key === 'n') {
      handled();
      setAdding(ref?.column ?? navigableColumns()[0] ?? 0);
    } else if (/^Arrow(Up|Down|Left|Right)$/.test(key) || /^[hjklHJKL]$/.test(key)) {
      handled();
      const dir = key.replace('Arrow', '').toLowerCase();
      const dx = dir === 'left' || dir === 'h' ? -1 : dir === 'right' || dir === 'l' ? 1 : 0;
      const dy = dir === 'up' || dir === 'k' ? -1 : dir === 'down' || dir === 'j' ? 1 : 0;
      if (e.shiftKey) moveSelected(dx, dy);
      else moveSelection(dx, dy);
    } else if (!ref || !card(ref)) {
      return;
    } else if (key === 'Enter' || key === 'e') {
      handled();
      setEditing(ref);
    } else if (key === 's') {
      handled();
      startTask(ref);
    } else if (key === 'x' || key === ' ') {
      handled();
      const c = card(ref);
      if (c) change((cur) => updateCard(cur, ref, { done: !c.done }));
    } else if (key === 'a') {
      handled();
      archive(ref);
    } else if (key === 'Delete' || key === 'Backspace') {
      handled();
      deleteCard(ref);
    }
  }

  // --- Drag and drop ---

  function dropCard(e: DragEvent, column: number, cardIndex?: number): void {
    const raw = e.dataTransfer?.getData(CARD_DRAG_TYPE);
    setDragOver(null);
    setDragging(null);
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    const [fromColumn, fromCard] = raw.split(':').map(Number);
    const target = board()?.columns[column];
    change((b) => moveCard(b, { column: fromColumn, card: fromCard }, column, cardIndex));
    if (target) {
      const landed =
        cardIndex === undefined
          ? target.cards.length - (fromColumn === column ? 1 : 0)
          : fromColumn === column && cardIndex > fromCard
            ? cardIndex - 1
            : cardIndex;
      setSelected({ column, card: Math.max(0, landed) });
    }
  }

  function dropColumn(e: DragEvent, column: number): void {
    const raw = e.dataTransfer?.getData(COLUMN_DRAG_TYPE);
    setDragOver(null);
    if (!raw) return;
    e.preventDefault();
    change((b) => moveColumn(b, Number(raw), column));
  }

  function acceptsDrag(e: DragEvent): boolean {
    const types = e.dataTransfer?.types ?? [];
    return types.includes(CARD_DRAG_TYPE) || types.includes(COLUMN_DRAG_TYPE);
  }

  // Keep the selection pointing at a card that exists after outside edits.
  createEffect(() => {
    const ref = selected();
    const b = board();
    if (ref && b && !b.columns[ref.column]?.cards[ref.card]) setSelected(null);
  });

  function openPlanner(): void {
    batch(() => {
      props.agentPane.setOpen(true);
      prefillKanbanPlanPrompt(props.project);
    });
    queueMicrotask(() => triggerFocus(`${githubAgentTaskId(projectId)}:prompt`));
  }

  const saveLabel = () => {
    switch (saveState()) {
      case 'saving':
        return 'Saving…';
      case 'saved':
        return 'Saved';
      case 'external':
        return 'Updated from disk';
      case 'error':
        return 'Not saved';
      default:
        return '';
    }
  };

  return (
    <section
      class="kanban"
      ref={section}
      tabIndex={-1}
      aria-labelledby="kanban-title"
      inert={props.covered || undefined}
      onKeyDown={onBoardKeyDown}
    >
      <header class="kanban-heading">
        <div class="kanban-heading-title">
          <h2 id="kanban-title">
            {board()?.title || 'Kanban'} <span>· {props.project.name}</span>
          </h2>
          <small>
            <code>KANBAN.md</code>
            <Show when={board()}>
              {' · '}
              {summary().done}/{summary().cards} done
            </Show>
            {/* Reserved slot: the status comes and goes without moving the line. */}
            <span class="kanban-save-state" classList={{ error: saveState() === 'error' }}>
              {saveLabel()}
            </span>
          </small>
        </div>
        <div class="kanban-actions">
          <Show when={summary().attention}>
            <button
              type="button"
              class="kanban-summary urgent"
              aria-pressed={quick() === 'attention'}
              title="Show the cards whose task needs you"
              onClick={() => setQuick(quick() === 'attention' ? 'all' : 'attention')}
            >
              {summary().attention} need you
            </button>
          </Show>
          <Show when={summary().running}>
            <button
              type="button"
              class="kanban-summary"
              aria-pressed={quick() === 'running'}
              onClick={() => setQuick(quick() === 'running' ? 'all' : 'running')}
            >
              <span class="kanban-dot running" aria-hidden="true" /> {summary().running} running
            </button>
          </Show>
          <Show when={summary().review}>
            <button
              type="button"
              class="kanban-summary"
              aria-pressed={quick() === 'attention'}
              onClick={() => setQuick(quick() === 'attention' ? 'all' : 'attention')}
            >
              {summary().review} to review
            </button>
          </Show>
          <button
            type="button"
            aria-pressed={props.agentPane.open()}
            title="Plan with the project's agent: it edits KANBAN.md and the board follows"
            onClick={() =>
              props.agentPane.open() ? props.agentPane.setOpen(false) : openPlanner()
            }
          >
            <SparkleIcon /> Plan with agent
          </button>
          <Show when={text()}>
            <button
              type="button"
              class="kanban-icon-button"
              title="Open KANBAN.md in your editor"
              aria-label="Open KANBAN.md in your editor"
              onClick={() =>
                void openFileInEditor(root, 'KANBAN.md', {
                  editorCommand: store.editorCommand,
                }).catch((err: unknown) => showNotification(errMessage(err)))
              }
            >
              <ExternalLinkIcon />
            </button>
          </Show>
          <button
            type="button"
            class="kanban-icon-button"
            title="Reload KANBAN.md"
            aria-label="Reload KANBAN.md"
            onClick={() => void reload()}
          >
            <SyncIcon />
          </button>
          <button type="button" onClick={() => openKanban(null)}>
            <ArrowLeftIcon /> Back to tasks
          </button>
        </div>
      </header>
      <Show when={board()}>
        <div class="kanban-toolbar" role="toolbar" aria-label="Filter cards">
          <label class="kanban-search">
            <SearchIcon size={13} />
            <input
              ref={filterRef}
              type="search"
              placeholder="Filter cards  /"
              aria-label="Filter cards"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery('');
                  section?.focus();
                } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  moveSelection(0, 0);
                }
              }}
            />
          </label>
          <div class="kanban-segments" role="group" aria-label="Show">
            <For
              each={
                [
                  ['all', 'All'],
                  ['attention', 'Needs me'],
                  ['running', 'Running'],
                  ['ready', 'Ready to start'],
                  ['blocked', 'Blocked'],
                ] as const
              }
            >
              {([value, label]) => (
                <button
                  type="button"
                  aria-pressed={quick() === value}
                  onClick={() => setQuick(value)}
                >
                  {label}
                </button>
              )}
            </For>
          </div>
          <span class="kanban-spacer" />
          <button
            type="button"
            class="kanban-icon-button"
            aria-pressed={showHelp()}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
            onClick={() => setShowHelp((open) => !open)}
          >
            ?
          </button>
        </div>
      </Show>
      <Show when={error()}>
        <p role="alert" class="kanban-error">
          {error()}
        </p>
      </Show>
      <Show when={text() === undefined && !error()}>
        <div class="kanban-loading" aria-busy="true">
          <For each={[0, 1, 2]}>{() => <div class="kanban-skeleton" />}</For>
        </div>
      </Show>
      <Show when={text() === null}>
        <div class="kanban-empty">
          <h3>Plan this project on a board</h3>
          <p>
            The board is a plain Markdown file, <code>KANBAN.md</code>, in the project root. Edit it
            here, in your editor, or let an agent write it. Every card can start a task in its own
            worktree.
          </p>
          <pre class="kanban-sample" aria-label="Example">
            {`## Backlog

- [ ] Add rate limiting to the API
  Limit each token to 100 requests a minute.
  - [ ] Returns 429 with Retry-After
  depends: Token usage metrics`}
          </pre>
          <div class="kanban-empty-actions">
            <button
              type="button"
              class="kanban-primary"
              onClick={() => save(DEFAULT_KANBAN_MARKDOWN)}
            >
              <PlusIcon /> Create board
            </button>
            <button
              type="button"
              onClick={() => {
                save(DEFAULT_KANBAN_MARKDOWN);
                openPlanner();
              }}
            >
              <SparkleIcon /> Create and plan with agent
            </button>
          </div>
        </div>
      </Show>
      <Show when={board()}>
        {(b) => (
          <div
            class="kanban-columns"
            ref={columnsRef}
            onDragOver={(e) => {
              // Scroll the board sideways while dragging near its edges.
              if (!acceptsDrag(e) || !columnsRef) return;
              const rect = columnsRef.getBoundingClientRect();
              const edge = 60;
              if (e.clientX < rect.left + edge) columnsRef.scrollLeft -= 14;
              else if (e.clientX > rect.right - edge) columnsRef.scrollLeft += 14;
            }}
          >
            <Index each={b().columns}>
              {(column, columnIndex) => (
                <Show
                  when={!isCollapsed(column().title)}
                  fallback={
                    <button
                      type="button"
                      class="kanban-column-collapsed"
                      title={`Expand ${column().title}`}
                      aria-label={`Expand column ${column().title}, ${column().cards.length} cards`}
                      onClick={() => toggleCollapsed(column().title)}
                      onDragOver={(e) => {
                        if (!e.dataTransfer?.types.includes(CARD_DRAG_TYPE)) return;
                        e.preventDefault();
                        setDragOver({ column: columnIndex, card: null });
                      }}
                      onDragLeave={() => setDragOver(null)}
                      onDrop={(e) => dropCard(e, columnIndex, 0)}
                      classList={{
                        'drag-over':
                          dragOver()?.column === columnIndex && dragOver()?.card === null,
                      }}
                    >
                      <ChevronRightIcon size={12} />
                      <span class="kanban-collapsed-title">{column().title}</span>
                      <span class="kanban-count">{column().cards.length}</span>
                    </button>
                  }
                >
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
                      if (e.dataTransfer?.types.includes(COLUMN_DRAG_TYPE)) {
                        dropColumn(e, columnIndex);
                      } else dropCard(e, columnIndex);
                    }}
                  >
                    <header
                      class="kanban-column-header"
                      draggable={renaming() !== columnIndex}
                      onDragStart={(e) => {
                        e.dataTransfer?.setData(COLUMN_DRAG_TYPE, String(columnIndex));
                      }}
                    >
                      <button
                        type="button"
                        class="kanban-icon"
                        title={`Collapse ${column().title}`}
                        aria-label={`Collapse column ${column().title}`}
                        onClick={() => toggleCollapsed(column().title)}
                      >
                        <ChevronDownIcon size={12} />
                      </button>
                      <Show
                        when={renaming() === columnIndex}
                        fallback={
                          <h3
                            title="Double-click to rename"
                            onDblClick={() => setRenaming(columnIndex)}
                          >
                            <span class="kanban-column-name">{column().title}</span>
                            <span class="kanban-count">
                              {filterActive()
                                ? `${visible()[columnIndex]?.length ?? 0}/${column().cards.length}`
                                : column().cards.length}
                            </span>
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
                      <div class="kanban-column-tools">
                        <button
                          type="button"
                          class="kanban-icon"
                          title={`Add a card to ${column().title}`}
                          aria-label={`Add a card to ${column().title}`}
                          onClick={() => setAdding(columnIndex)}
                        >
                          <PlusIcon size={12} />
                        </button>
                        <button
                          type="button"
                          class="kanban-icon"
                          title={`Delete column ${column().title}`}
                          aria-label={`Delete column ${column().title}`}
                          disabled={b().columns.length < 2 && column().cards.length > 0}
                          onClick={() => deleteColumn(columnIndex)}
                        >
                          <TrashIcon size={12} />
                        </button>
                      </div>
                    </header>
                    <Show when={column().notes}>
                      <p class="kanban-notes">{column().notes}</p>
                    </Show>
                    <div class="kanban-cards">
                      <For each={visible()[columnIndex] ?? []}>
                        {(cardIndex) => {
                          const ref = () => ({ column: columnIndex, card: cardIndex });
                          const c = () => column().cards[cardIndex];
                          const isEditing = () =>
                            editing()?.column === columnIndex && editing()?.card === cardIndex;
                          const isSelected = () =>
                            selected()?.column === columnIndex && selected()?.card === cardIndex;
                          const firstShown = () =>
                            !selected() &&
                            navigableColumns()[0] === columnIndex &&
                            visible()[columnIndex]?.[0] === cardIndex;
                          return (
                            <Show when={c()}>
                              {(current) => (
                                <Show
                                  when={isEditing()}
                                  fallback={
                                    <KanbanCardView
                                      card={current()}
                                      projectId={projectId}
                                      blockedBy={openDependencies(b(), ref())}
                                      selected={isSelected()}
                                      tabIndex={isSelected() || firstShown() ? 0 : -1}
                                      dataRef={`${columnIndex}:${cardIndex}`}
                                      dropBefore={
                                        dragOver()?.column === columnIndex &&
                                        dragOver()?.card === cardIndex
                                      }
                                      dragging={
                                        dragging()?.column === columnIndex &&
                                        dragging()?.card === cardIndex
                                      }
                                      flash={flashed().has(cardKey(column().title, current()))}
                                      onSelect={() => setSelected(ref())}
                                      onDragStart={(e) => {
                                        e.dataTransfer?.setData(
                                          CARD_DRAG_TYPE,
                                          `${columnIndex}:${cardIndex}`,
                                        );
                                        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                                        setDragging(ref());
                                      }}
                                      onDragEnd={() => {
                                        setDragging(null);
                                        setDragOver(null);
                                      }}
                                      onDragOver={(e) => {
                                        if (!e.dataTransfer?.types.includes(CARD_DRAG_TYPE)) {
                                          return;
                                        }
                                        e.preventDefault();
                                        e.stopPropagation();
                                        // The lower half of a card drops after it.
                                        const box = (
                                          e.currentTarget as HTMLElement
                                        ).getBoundingClientRect();
                                        const after = e.clientY > box.top + box.height / 2;
                                        const shown = visible()[columnIndex] ?? [];
                                        const next = shown[shown.indexOf(cardIndex) + 1];
                                        setDragOver({
                                          column: columnIndex,
                                          card: after ? (next ?? null) : cardIndex,
                                        });
                                      }}
                                      onDrop={(e) => {
                                        const target = dragOver();
                                        dropCard(
                                          e,
                                          columnIndex,
                                          target?.column === columnIndex && target.card !== null
                                            ? target.card
                                            : undefined,
                                        );
                                      }}
                                      onEdit={() => setEditing(ref())}
                                      onStart={() => startTask(ref())}
                                      onToggleDone={(done) =>
                                        change((cur) => updateCard(cur, ref(), { done }))
                                      }
                                      onToggleChecklist={(line) =>
                                        change((cur) => toggleChecklistItem(cur, ref(), line))
                                      }
                                    />
                                  }
                                >
                                  <KanbanCardEditor
                                    card={current()}
                                    columns={b().columns.map((col) => col.title)}
                                    column={columnIndex}
                                    otherTitles={b()
                                      .columns.flatMap((col) => col.cards.map((x) => x.title))
                                      .filter((t) => t !== current().title)}
                                    onSave={(next, toColumn) => {
                                      setEditing(null);
                                      change((cur) => {
                                        const updated = updateCard(cur, ref(), next);
                                        return toColumn === columnIndex
                                          ? updated
                                          : moveCard(updated, ref(), toColumn);
                                      });
                                      focusCard(
                                        toColumn === columnIndex
                                          ? ref()
                                          : {
                                              column: toColumn,
                                              card: b().columns[toColumn]?.cards.length ?? 0,
                                            },
                                      );
                                    }}
                                    onDelete={() => deleteCard(ref())}
                                    onArchive={() => archive(ref())}
                                    onCancel={() => {
                                      setEditing(null);
                                      focusCard(ref());
                                    }}
                                  />
                                </Show>
                              )}
                            </Show>
                          );
                        }}
                      </For>
                      <Show when={filterActive() && !visible()[columnIndex]?.length}>
                        <p class="kanban-column-empty">No matching cards</p>
                      </Show>
                      <Show
                        when={!filterActive() && !column().cards.length && adding() !== columnIndex}
                      >
                        <p class="kanban-column-empty">Drop cards here</p>
                      </Show>
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
                        placeholder="Title, Enter to add. Paste a list for many."
                        keepOpen
                        onCommit={(value) => addCards(columnIndex, value)}
                        onPaste={(value) => {
                          if (titlesFromInput(value).length < 2) return false;
                          addCards(columnIndex, value);
                          return true;
                        }}
                        onCancel={() => setAdding(null)}
                      />
                    </Show>
                  </section>
                </Show>
              )}
            </Index>
            <AddColumn onAdd={(title) => change((cur) => addColumn(cur, title))} />
          </div>
        )}
      </Show>
      <Show when={showHelp()}>
        <KeyboardHelp onClose={() => setShowHelp(false)} />
      </Show>
      <div class="kanban-undo" classList={{ shown: undo() !== null }} role="status">
        <Show when={undo()}>
          {(offer) => (
            <>
              <span>{offer().label}</span>
              <button type="button" onClick={runUndo}>
                Undo
              </button>
            </>
          )}
        </Show>
      </div>
    </section>
  );
}

const SHORTCUTS: [string, string][] = [
  ['← → ↑ ↓ / h j k l', 'Move between cards'],
  ['Shift + arrows', 'Move the card'],
  ['Enter / E', 'Edit the card'],
  ['S', 'Start a task from the card'],
  ['X / Space', 'Mark done or not done'],
  ['A', 'Archive'],
  ['Delete', 'Delete (with undo)'],
  ['N', 'New card in this column'],
  ['/', 'Filter cards'],
  ['Esc', 'Clear the filter'],
  ['?', 'Show or hide this list'],
];

function KeyboardHelp(props: { onClose: () => void }) {
  return (
    <aside class="kanban-help" aria-label="Keyboard shortcuts">
      <header>
        <strong>Keyboard shortcuts</strong>
        <button
          type="button"
          class="kanban-icon"
          aria-label="Close"
          onClick={() => props.onClose()}
        >
          ×
        </button>
      </header>
      <dl>
        <For each={SHORTCUTS}>
          {([keys, action]) => (
            <>
              <dt>
                <kbd>{keys}</kbd>
              </dt>
              <dd>{action}</dd>
            </>
          )}
        </For>
      </dl>
    </aside>
  );
}

/** A one-line field that commits on Enter or blur and cancels on Escape. */
function InlineField(props: {
  value: string;
  label: string;
  placeholder?: string;
  /** Clear and stay open after Enter, for adding several items in a row. */
  keepOpen?: boolean;
  /** Handles a paste itself when it returns true. */
  onPaste?: (text: string) => boolean;
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
      onPaste={(e) => {
        const pasted = e.clipboardData?.getData('text/plain') ?? '';
        if (props.onPaste?.(pasted)) e.preventDefault();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
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
