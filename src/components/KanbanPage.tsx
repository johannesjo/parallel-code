import {
  For,
  Index,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';
import { createAgentPaneState, GitHubAgentPane, type AgentPaneState } from './GitHubAgentPane';
import { GitHubItemPicker } from './GitHubItemPicker';
import {
  KanbanCardEditor,
  KanbanCardView,
  cardState,
  useKanbanClock,
  type EditorDraft,
} from './KanbanCard';
import { ResizablePanel, type PanelChild } from './ResizablePanel';
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  GitHubIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SparkleIcon,
  SyncIcon,
  TrashIcon,
} from './icons';
import { kanbanAgentTaskId } from '../documents/task-id';
import { store } from '../store/core';
import { triggerFocus } from '../store/focused-panel';
import {
  openKanban,
  prefillKanbanPlanPrompt,
  readKanbanFile,
  startKanbanCardTask,
  updateKanbanFile,
  writeKanbanFile,
} from '../store/kanban';
import { showNotification } from '../store/notification';
import {
  DEFAULT_KANBAN_MARKDOWN,
  addCard,
  addColumn,
  addIssueCard,
  archiveCard,
  cardFingerprint,
  findCard,
  findCardByIssue,
  insertCard,
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
  type KanbanColumn,
} from '../lib/kanban';
import { openFileInEditor } from '../lib/shell';
import { isMac } from '../lib/platform';
import { errMessage } from '../lib/log';
import type { Project } from '../store/types';
import './github-issues.css';
import './kanban.css';

/** How often the open board checks KANBAN.md for edits made elsewhere. */
const POLL_MS = 1500;
/** How long Undo stays offered after a delete, unless the pointer or focus is on it. */
const UNDO_MS = 8000;
/** dataTransfer types for drags; not text/plain, which the app treats as a dropped link. */
const CARD_DRAG_TYPE = 'application/x-parallel-code-kanban-card';
const COLUMN_DRAG_TYPE = 'application/x-parallel-code-kanban-column';
/** Below this width the agent overlays the board instead of squeezing it. Keep in
 *  sync with the @container query the GitHub page's CSS shares with this page. */
const OVERLAY_BELOW_PX = 900;

type QuickFilter = 'all' | 'attention' | 'running' | 'review' | 'ready' | 'blocked';

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
  const agentTaskId = kanbanAgentTaskId(projectId);
  const pane = createAgentPaneState(projectId, agentTaskId);
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
    resizeLabel: 'Resize planning agent pane',
    content: () => (
      <GitHubAgentPane
        project={props.project}
        agentPane={pane}
        taskId={agentTaskId}
        label="Planning agent"
        hint="Works in the project checkout and edits KANBAN.md directly; the board follows. Ask it to break a goal into cards."
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

/**
 * Where a card was when an action started, and what it held. Found again by
 * its fingerprint, then by title, if the board moved meanwhile.
 */
interface CardHint {
  title: string;
  column: string;
  ref: KanbanCardRef;
  fingerprint?: string;
}

/** A change to apply to the board as it is; null when its card or column is gone. */
type Intent = (board: KanbanBoard) => KanbanBoard | null;

interface UndoOffer {
  label: string;
  /** Puts back what the action removed, applied to the board as it is then. */
  restore: Intent;
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

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Puts a deleted column back where it was. Only the cards still waiting in the
 * neighbouring column come back with it; a card moved on since stays where it
 * was put, so nothing is ever duplicated.
 */
function restoreColumn(board: KanbanBoard, index: number, column: KanbanColumn): KanbanBoard {
  let next = board;
  const neighbour = Math.max(0, index - 1);
  const restored: KanbanCard[] = [];
  for (const card of [...column.cards].reverse()) {
    const fingerprint = cardFingerprint(card);
    const cards = next.columns[neighbour]?.cards ?? [];
    let at = -1;
    for (let i = cards.length - 1; i >= 0; i--) {
      if (cardFingerprint(cards[i]) === fingerprint) {
        at = i;
        break;
      }
    }
    if (at < 0) continue;
    restored.unshift(cards[at]);
    next = removeCard(next, { column: neighbour, card: at });
  }
  const columns = [...next.columns];
  columns.splice(Math.min(index, columns.length), 0, { ...column, cards: restored });
  return { ...next, columns };
}

function KanbanBoardView(props: { project: Project; agentPane: AgentPaneState; covered: boolean }) {
  const root = untrack(() => props.project.path);
  const projectId = untrack(() => props.project.id);
  const session = boardSession(projectId);
  const helpId = createUniqueId();
  const hintId = createUniqueId();
  // undefined: loading; null: the project has no KANBAN.md yet.
  const [text, setText] = createSignal<string | null | undefined>(undefined);
  const [error, setError] = createSignal('');
  const [saveState, setSaveState] = createSignal<SaveState>('idle');
  const [editing, setEditing] = createSignal<CardHint | null>(null);
  const [draft, setDraft] = createSignal<EditorDraft | null>(null);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [adding, setAdding] = createSignal<string | null>(null);
  const [selection, setSelection] = createSignal<CardHint | null>(null);
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
  const [showPicker, setShowPicker] = createSignal(false);
  const [announcement, setAnnouncement] = createSignal('');
  const board = createMemo(() => {
    const value = text();
    return typeof value === 'string' ? parseKanban(value) : null;
  });
  let section: HTMLElement | undefined;
  let columnsRef: HTMLDivElement | undefined;
  let filterRef: HTMLInputElement | undefined;
  let writes: Promise<void> = Promise.resolve();
  let writing = 0;
  // Bumped by every local change, so a read that started before one is dropped.
  let generation = 0;
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

  const resolve = (hint: CardHint | null): KanbanCardRef | null => {
    const b = board();
    return hint && b ? findCard(b, hint) : null;
  };
  const hintFor = (ref: KanbanCardRef): CardHint | null => {
    const column = board()?.columns[ref.column];
    const c = column?.cards[ref.card];
    return column && c
      ? { title: c.title, column: column.title, ref, fingerprint: cardFingerprint(c) }
      : null;
  };
  const sameRef = (a: KanbanCardRef | null, b: KanbanCardRef) =>
    !!a && a.column === b.column && a.card === b.card;
  const editingRef = createMemo(() => resolve(editing()));
  const selectedRef = createMemo(() => resolve(selection()));

  function announce(message: string): void {
    // Re-set even when unchanged, so the same message is read again.
    setAnnouncement('');
    queueMicrotask(() => setAnnouncement(message));
  }

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
      before.columns.flatMap((column) => column.cards.map((c) => cardKey(column.title, c))),
    );
    const changed = new Set(
      after.columns.flatMap((column) =>
        column.cards.map((c) => cardKey(column.title, c)).filter((key) => !known.has(key)),
      ),
    );
    if (!changed.size) return;
    setFlashed(changed);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlashed(new Set<string>()), 1600);
  }

  /** Reads the file and shows it, unless a local change happened meanwhile. */
  async function reload(quiet = false): Promise<void> {
    const started = generation;
    try {
      const current = await readKanbanFile(root);
      if (disposed || writing || started !== generation) return;
      setError('');
      const previous = text();
      if (current === previous) return;
      const before = untrack(board);
      setText(current);
      if (!quiet && typeof previous === 'string' && typeof current === 'string') {
        flashChanges(before, untrack(board));
        settleSaveState('external');
      }
    } catch (err) {
      if (!disposed) setError(errMessage(err));
    }
  }

  // Follow edits made in an editor or by an agent. An open editor or a drag
  // keeps its card in place until it ends; changes are rebased on save anyway.
  onMount(() => {
    // Take focus so the shortcuts work at once, unless the user is typing elsewhere.
    if (!isTypingTarget(document.activeElement)) section?.focus({ preventScroll: true });
    void reload().then(() => {
      if (columnsRef) columnsRef.scrollLeft = session.scrollLeft;
    });
    const timer = setInterval(() => {
      if (writing || editing() || dragging() || renaming() !== null || adding() !== null) return;
      void reload();
    }, POLL_MS);
    onCleanup(() => clearInterval(timer));
  });

  function afterWrite(): void {
    writing = Math.max(0, writing - 1);
    // Show the file as written, which may hold other writers' changes too.
    if (!writing && !disposed) void reload(true);
  }

  function reloadQuietly(): Promise<void> {
    return reload(true);
  }

  /**
   * Applies a change at once and saves it. The intent is re-applied to the
   * file as it is on disk, again if another writer got in first, so an edit
   * made while the planning agent or an editor changes the board is never
   * lost. Returns null when nothing changed, else a promise of whether the
   * change reached the file; a change whose card or column is gone by then
   * is reported, never silently dropped.
   */
  function change(fn: Intent): Promise<boolean> | null {
    const current = board();
    const local = current && fn(current);
    if (!local) return null;
    const content = serializeKanban(local);
    if (content === text()) return null;
    generation++;
    setText(content);
    setSaveState('saving');
    writing++;
    let applied = false;
    let missing = false;
    const saved = writes
      .then(() =>
        updateKanbanFile(root, (b) => {
          applied = true;
          const next = fn(b);
          missing = !next;
          return next;
        }),
      )
      .then(
        () => {
          if (!applied || missing) {
            settleSaveState('error');
            showNotification(
              applied
                ? 'Not saved: the card or column was changed or removed elsewhere'
                : 'Not saved: KANBAN.md no longer exists',
            );
            return false;
          }
          if (writing === 1) settleSaveState('saved');
          return true;
        },
        (err: unknown) => {
          settleSaveState('error');
          showNotification(`Could not save KANBAN.md: ${errMessage(err)}`);
          return false;
        },
      );
    writes = saved.then(afterWrite);
    return saved;
  }

  /** Runs `op` on the card the hint names, wherever it is when the change applies. */
  const atCard =
    (hint: CardHint, op: (b: KanbanBoard, ref: KanbanCardRef) => KanbanBoard | null): Intent =>
    (b) => {
      const ref = findCard(b, hint);
      return ref ? op(b, ref) : null;
    };
  const atColumn =
    (title: string, op: (b: KanbanBoard, index: number) => KanbanBoard): Intent =>
    (b) => {
      const index = b.columns.findIndex((c) => c.title === title);
      return index >= 0 ? op(b, index) : null;
    };

  /** Applies a destructive change and, once it is saved, offers to take it back. */
  function changeWithUndo(label: string, fn: Intent, restore: Intent): void {
    const saved = change(fn);
    if (!saved) return;
    setUndo(null);
    void saved.then((ok) => {
      if (!ok || disposed) return;
      announce(`${label}. Press U to undo.`);
      setUndo({ label, restore });
      armUndoTimer();
    });
  }

  function armUndoTimer(): void {
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => setUndo(null), UNDO_MS);
  }

  function runUndo(): void {
    const offer = undo();
    setUndo(null);
    clearTimeout(undoTimer);
    if (!offer) return;
    section?.focus({ preventScroll: true });
    if (!change(offer.restore)) {
      showNotification("Can't undo: the board changed since");
      return;
    }
    announce('Undone');
  }

  const card = (ref: KanbanCardRef | null) =>
    ref ? board()?.columns[ref.column]?.cards[ref.card] : undefined;

  function startTask(ref: KanbanCardRef): void {
    const current = board();
    if (!current) return;
    if (!startKanbanCardTask(projectId, current, ref)) {
      showNotification('Finish or dismiss your open task draft before starting another');
    }
  }

  function deleteCard(ref: KanbanCardRef): void {
    const hint = hintFor(ref);
    const removed = card(ref);
    if (!hint || !removed) return;
    setEditing(null);
    const next = neighbourAfterRemoval(ref);
    changeWithUndo(`Deleted “${removed.title || 'Untitled'}”`, atCard(hint, removeCard), (b) => {
      // Already back (another writer restored it): nothing to undo.
      if (findCard(b, { title: removed.title, fingerprint: hint.fingerprint })) return null;
      return atColumn(hint.column, (cur, column) =>
        insertCard(cur, { column, card: hint.ref.card }, removed),
      )(b);
    });
    focusHint(next);
  }

  function archive(ref: KanbanCardRef): void {
    const hint = hintFor(ref);
    const archived = card(ref);
    if (!hint || !archived || isArchiveColumn(hint.column)) return;
    setEditing(null);
    const next = neighbourAfterRemoval(ref);
    changeWithUndo(`Archived “${archived.title || 'Untitled'}”`, atCard(hint, archiveCard), (b) => {
      const archiveIndex = b.columns.findIndex((c) => isArchiveColumn(c.title));
      const column = b.columns.findIndex((c) => c.title === hint.column);
      const fingerprint = cardFingerprint(archived);
      const at = b.columns[archiveIndex]?.cards.findIndex(
        (c) => cardFingerprint(c) === fingerprint,
      );
      if (archiveIndex < 0 || column < 0 || at === undefined || at < 0) return null;
      return moveCard(b, { column: archiveIndex, card: at }, column, hint.ref.card);
    });
    focusHint(next);
  }

  function deleteColumn(index: number): void {
    const column = board()?.columns[index];
    if (!column) return;
    changeWithUndo(
      column.cards.length
        ? `Deleted column “${column.title}”; its cards moved to the neighbouring column`
        : `Deleted column “${column.title}”`,
      atColumn(column.title, removeColumn),
      (b) =>
        b.columns.some((c) => c.title === column.title) ? null : restoreColumn(b, index, column),
    );
  }

  /** Adds one card per line; pasting a list adds the whole list. */
  function addCards(columnTitle: string, input: string): void {
    const titles = titlesFromInput(input);
    if (!titles.length) return;
    change(
      atColumn(columnTitle, (b, column) =>
        titles.reduce((next, title) => addCard(next, column, title), b),
      ),
    );
    announce(`Added ${plural(titles.length, 'card')} to ${columnTitle}`);
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
        return state === 'needs_input' || state === 'error';
      case 'running':
        return state === 'active';
      case 'review':
        return state === 'review';
      case 'blocked':
        return openDependencies(b, ref).length > 0;
      case 'ready':
        return !c.done && !c.branches.length && !openDependencies(b, ref).length;
      default:
        return true;
    }
  }

  /** Card indexes shown per column, in board order. The card being edited always shows. */
  const visible = createMemo(() => {
    const b = board();
    if (!b) return [];
    const edited = editingRef();
    return b.columns.map((column, ci) =>
      column.cards
        .map((_, i) => i)
        .filter(
          (i) => sameRef(edited, { column: ci, card: i }) || matches(b, { column: ci, card: i }),
        ),
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
  function toggleCollapsed(title: string, focusAfter = true): void {
    const collapsing = !isCollapsed(title);
    batch(() => {
      // Nothing may stay open in a column that is about to hide.
      if (collapsing) {
        const edited = editingRef();
        if (edited && board()?.columns[edited.column]?.title === title) setEditing(null);
        if (adding() === title) setAdding(null);
        if (renaming() === title) setRenaming(null);
      }
      setCollapsed((current) => ({ ...current, [title]: collapsing }));
    });
    if (!focusAfter) return;
    // The toggle is a different element in each state; keep focus on it.
    queueMicrotask(() =>
      section?.querySelector<HTMLElement>(`[data-column-toggle="${CSS.escape(title)}"]`)?.focus(),
    );
  }

  // --- Selection and keyboard ---

  /** Keyboard actions apply only to a card the user can see. */
  const actionable = createMemo(() => {
    const ref = selectedRef();
    const b = board();
    if (!ref || !b) return null;
    const column = b.columns[ref.column];
    if (!column || isCollapsed(column.title)) return null;
    return visible()[ref.column]?.includes(ref.card) ? ref : null;
  });

  function focusHint(hint: CardHint | null): void {
    setSelection(hint);
    if (hint) queueMicrotask(focusSelected);
  }

  function focusSelected(): void {
    const ref = selectedRef();
    if (!ref) return;
    section
      ?.querySelector<HTMLElement>(`[data-card="${ref.column}:${ref.card}"]`)
      ?.focus({ preventScroll: false });
  }
  const focusCard = (ref: KanbanCardRef | null) => focusHint(ref ? hintFor(ref) : null);

  /** The card to select once `ref` is gone: the next visible one, else the previous. */
  function neighbourAfterRemoval(ref: KanbanCardRef): CardHint | null {
    const shown = visible()[ref.column] ?? [];
    const at = shown.indexOf(ref.card);
    const next = shown[at + 1] ?? shown[at - 1];
    if (next === undefined) return null;
    const hint = hintFor({ column: ref.column, card: next });
    // After the removal the neighbour below moves up by one.
    return hint && next > ref.card
      ? { ...hint, ref: { column: ref.column, card: next - 1 } }
      : hint;
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
    const current = actionable();
    const columns = navigableColumns();
    if (!columns.length) return;
    if (!current) {
      focusCard({ column: columns[0], card: visible()[columns[0]][0] });
      return;
    }
    if (dy) {
      const shown = visible()[current.column];
      const at = Math.max(0, shown.indexOf(current.card));
      focusCard({
        column: current.column,
        card: shown[Math.max(0, Math.min(shown.length - 1, at + dy))],
      });
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
    const ref = actionable();
    const hint = ref && hintFor(ref);
    const b = board();
    if (!ref || !hint || !b) return;
    if (dy) {
      // Step over hidden cards: move past the next visible neighbour.
      const shown = visible()[ref.column];
      const neighbour = shown[shown.indexOf(ref.card) + dy];
      if (neighbour === undefined) return;
      change(
        atCard(hint, (cur, at) => moveCard(cur, at, at.column, dy > 0 ? neighbour + 1 : neighbour)),
      );
      announce(`Moved “${hint.title}” ${dy > 0 ? 'down' : 'up'}`);
      focusHint({ ...hint, ref: { column: ref.column, card: neighbour } });
      return;
    }
    const target = ref.column + dx;
    const column = b.columns[target];
    if (!column) return;
    const index = Math.min(ref.card, column.cards.length);
    change(atCard(hint, (cur, at) => moveToColumn(cur, at, column.title, index)));
    if (isCollapsed(column.title)) toggleCollapsed(column.title, false);
    announce(`Moved “${hint.title}” to ${column.title}`);
    focusHint({ title: hint.title, column: column.title, ref: { column: target, card: index } });
  }

  function moveSelectedColumn(dx: number): void {
    const ref = actionable();
    const b = board();
    if (!ref || !b) return;
    const title = b.columns[ref.column].title;
    const to = ref.column + dx;
    if (to < 0 || to >= b.columns.length) return;
    change(atColumn(title, (cur, from) => moveColumn(cur, from, from + dx)));
    announce(`Moved column ${title} ${dx > 0 ? 'right' : 'left'}`);
    const hint = hintFor(ref);
    if (hint) focusHint({ ...hint, ref: { column: to, card: ref.card } });
  }

  function toggleChecklist(hint: CardHint, item: number): void {
    const c = card(resolve(hint));
    if (!c) return;
    let seen = -1;
    const line = c.body
      .split('\n')
      .findIndex((l) => /^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/.test(l) && ++seen === item);
    if (line < 0) return;
    change(atCard(hint, (cur, at) => toggleChecklistItem(cur, at, line)));
  }

  function onBoardKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || isTypingTarget(e.target)) return;
    if (editing() || renaming() !== null || adding() !== null) return;
    const target = e.target as HTMLElement;
    const key = e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if ((e.metaKey || e.ctrlKey) && key.toLowerCase() === 'z' && !e.shiftKey && undo()) {
      handled();
      runUndo();
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    if (key === '?') {
      handled();
      togglePopover('help');
      return;
    }
    if (key === 'Escape') {
      if (showHelp() || showPicker()) {
        handled();
        closePopovers();
      } else if (filterActive()) {
        handled();
        setQuery('');
        setQuick('all');
      }
      return;
    }
    if (key === '/') {
      handled();
      filterRef?.focus();
      return;
    }
    if (key === 'u' && undo()) {
      handled();
      runUndo();
      return;
    }
    // Card keys act from a card or the board itself, never from a header control.
    const onCard = target === section || target.classList.contains('kanban-card');
    if (!onCard) return;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    if (lower === 'n') {
      handled();
      const ref = actionable();
      const columns = board()?.columns ?? [];
      const column = (ref && columns[ref.column]) ?? columns.find((c) => !isCollapsed(c.title));
      if (column) setAdding(column.title);
      return;
    }
    if (/^Arrow(Up|Down|Left|Right)$/.test(key) || /^[hjkl]$/.test(lower)) {
      handled();
      const dir = key.startsWith('Arrow') ? key.slice(5).toLowerCase() : lower;
      const dx = dir === 'left' || dir === 'h' ? -1 : dir === 'right' || dir === 'l' ? 1 : 0;
      const dy = dir === 'up' || dir === 'k' ? -1 : dir === 'down' || dir === 'j' ? 1 : 0;
      if (e.shiftKey) moveSelected(dx, dy);
      else moveSelection(dx, dy);
      return;
    }
    const ref = actionable();
    const c = card(ref);
    const hint = ref && hintFor(ref);
    if (!ref || !c || !hint) return;
    if (key === '<' || key === '>') {
      handled();
      moveSelectedColumn(key === '<' ? -1 : 1);
    } else if (key === 'Enter' || lower === 'e') {
      handled();
      setEditing(hint);
    } else if (lower === 's') {
      handled();
      startTask(ref);
    } else if (lower === 'x' || key === ' ') {
      handled();
      change(atCard(hint, (cur, at) => updateCard(cur, at, { done: !c.done })));
      announce(`Marked “${hint.title}” ${c.done ? 'not done' : 'done'}`);
    } else if (lower === 'a') {
      handled();
      archive(ref);
    } else if (lower === 'r') {
      handled();
      setRenaming(hint.column);
    } else if (/^[1-9]$/.test(key)) {
      handled();
      toggleChecklist(hint, Number(key) - 1);
    } else if (key === 'Delete' || key === 'Backspace') {
      handled();
      deleteCard(ref);
    }
  }

  // A selection whose card is gone, hidden or collapsed no longer counts.
  createEffect(() => {
    if (selection() && board() && !selectedRef()) setSelection(null);
  });
  // An editor whose card disappeared (deleted elsewhere) closes.
  createEffect(() => {
    if (editing() && board() && !editingRef()) setEditing(null);
  });
  // A new card or rename field whose column was renamed or removed elsewhere closes,
  // so it can never hold the keyboard and the live updates off.
  createEffect(() => {
    const b = board();
    if (!b) return;
    const titles = new Set(b.columns.map((c) => c.title));
    const a = adding();
    if (a !== null && (!titles.has(a) || isCollapsed(a))) setAdding(null);
    const r = renaming();
    if (r !== null && (!titles.has(r) || isCollapsed(r))) setRenaming(null);
  });
  // A draft belongs to one editor; opening or closing one starts afresh.
  createEffect(on(editing, () => setDraft(null), { defer: true }));

  // --- Drag and drop ---

  function dragHint(e: DragEvent): CardHint | null {
    try {
      const value: unknown = JSON.parse(e.dataTransfer?.getData(CARD_DRAG_TYPE) ?? '');
      if (
        value &&
        typeof value === 'object' &&
        'title' in value &&
        'column' in value &&
        'ref' in value
      ) {
        return value as CardHint;
      }
    } catch {
      // Not one of ours.
    }
    return null;
  }

  function dropCard(e: DragEvent, column: number, cardIndex?: number): void {
    const hint = dragHint(e);
    setDragOver(null);
    setDragging(null);
    if (!hint) return;
    e.preventDefault();
    e.stopPropagation();
    const target = board()?.columns[column];
    if (!target) return;
    const from = resolve(hint);
    change(atCard(hint, (b, at) => moveToColumn(b, at, target.title, cardIndex)));
    const landed =
      cardIndex === undefined
        ? target.cards.length - (from?.column === column ? 1 : 0)
        : from?.column === column && from.card < cardIndex
          ? cardIndex - 1
          : cardIndex;
    announce(`Moved “${hint.title}” to ${target.title}`);
    setSelection({
      title: hint.title,
      column: target.title,
      ref: { column, card: Math.max(0, landed) },
    });
  }

  /** Moves a card to the column with this title, wherever that column is by now. */
  function moveToColumn(
    b: KanbanBoard,
    at: KanbanCardRef,
    title: string,
    index?: number,
  ): KanbanBoard | null {
    const column = b.columns.findIndex((c) => c.title === title);
    return column < 0 ? null : moveCard(b, at, column, index);
  }

  function dropColumn(e: DragEvent, column: number): void {
    const raw = e.dataTransfer?.getData(COLUMN_DRAG_TYPE);
    setDragOver(null);
    if (!raw) return;
    e.preventDefault();
    change(atColumn(raw, (b, from) => moveColumn(b, from, column)));
  }

  function acceptsDrag(e: DragEvent): boolean {
    const types = e.dataTransfer?.types ?? [];
    return types.includes(CARD_DRAG_TYPE) || types.includes(COLUMN_DRAG_TYPE);
  }

  function openPlanner(): void {
    batch(() => {
      props.agentPane.setOpen(true);
      prefillKanbanPlanPrompt(props.project);
    });
    queueMicrotask(() => triggerFocus(`${kanbanAgentTaskId(projectId)}:prompt`));
  }

  function createBoard(): Promise<void> {
    return writeKanbanFile(root, DEFAULT_KANBAN_MARKDOWN, null).then(
      reloadQuietly,
      (err: unknown) => showNotification(errMessage(err)),
    );
  }

  const firstColumnTitle = () => board()?.columns.find((c) => !isArchiveColumn(c.title))?.title;

  function addFromGitHub(item: { title: string; url: string }): void {
    const b = board();
    const first = b?.columns.findIndex((c) => !isArchiveColumn(c.title)) ?? -1;
    if (!b || first < 0) return;
    const title = b.columns[first].title;
    if (change(atColumn(title, (cur, column) => addIssueCard(cur, item, column)))) {
      announce(`Added “${item.title}” to ${title}`);
    }
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

  let pickerToggle: HTMLButtonElement | undefined;
  let helpToggle: HTMLButtonElement | undefined;
  /** One popover at a time; closing one hands focus back to its toggle. */
  function togglePopover(which: 'picker' | 'help'): void {
    const opening = which === 'picker' ? !showPicker() : !showHelp();
    batch(() => {
      setShowPicker(which === 'picker' && opening);
      setShowHelp(which === 'help' && opening);
    });
    if (!opening) (which === 'picker' ? pickerToggle : helpToggle)?.focus();
  }
  function closePopovers(returnFocus = true): void {
    const toggle = showPicker() ? pickerToggle : showHelp() ? helpToggle : undefined;
    batch(() => {
      setShowPicker(false);
      setShowHelp(false);
    });
    if (returnFocus) (toggle ?? section)?.focus();
  }
  // Clicks outside the popovers close them.
  createEffect(() => {
    if (!showHelp() && !showPicker()) return;
    const close = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.kanban-help, .kanban-picker, [data-popover-toggle]')) return;
      closePopovers(false);
    };
    document.addEventListener('pointerdown', close, true);
    onCleanup(() => document.removeEventListener('pointerdown', close, true));
  });

  return (
    <section
      class="kanban"
      ref={section}
      tabIndex={-1}
      aria-labelledby="kanban-title"
      aria-describedby={hintId}
      inert={props.covered || undefined}
      onKeyDown={onBoardKeyDown}
    >
      <header class="kanban-heading">
        <div class="kanban-heading-title">
          <h2 id="kanban-title" title={`${board()?.title || 'Kanban'} · ${props.project.name}`}>
            {board()?.title || 'Kanban'} <span>· {props.project.name}</span>
          </h2>
          <small>
            <code>KANBAN.md</code>
            <Show when={text() === null}>{' · not created yet'}</Show>
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
          <Show when={board()}>
            <button
              type="button"
              ref={pickerToggle}
              data-popover-toggle
              aria-haspopup="dialog"
              aria-expanded={showPicker()}
              title="Add open GitHub issues and pull requests as cards"
              onClick={() => togglePopover('picker')}
            >
              <GitHubIcon size={14} /> Add from GitHub
            </button>
          </Show>
          <button
            type="button"
            aria-pressed={props.agentPane.open()}
            title="Plan with an agent that edits KANBAN.md; the board follows"
            onClick={() =>
              props.agentPane.open() ? props.agentPane.setOpen(false) : openPlanner()
            }
          >
            <SparkleIcon /> Plan with agent
          </button>
          <Show when={text() && !error()}>
            <button
              type="button"
              title="Open KANBAN.md in your editor"
              onClick={() =>
                void openFileInEditor(root, 'KANBAN.md', {
                  line: 1,
                  editorCommand: store.editorCommand,
                }).catch((err: unknown) => showNotification(errMessage(err)))
              }
            >
              Open file
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
        <Show when={showPicker()}>
          <div
            class="kanban-picker"
            role="dialog"
            aria-label="Add from GitHub"
            onKeyDown={(e) => {
              // Escape closes the picker even from its search field.
              if (e.key !== 'Escape') return;
              e.preventDefault();
              e.stopPropagation();
              closePopovers();
            }}
          >
            <div class="kanban-popover-head">
              <strong>Add from GitHub</strong>
              <button
                type="button"
                class="kanban-icon"
                aria-label="Close Add from GitHub"
                onClick={() => closePopovers()}
              >
                <CloseIcon size={12} />
              </button>
            </div>
            <small>
              Each pick adds a card to {firstColumnTitle() || 'the first column'}. The issue text
              stays on GitHub; a task started from the card reads it there.
            </small>
            <GitHubItemPicker
              projectRoot={root}
              bare
              autofocus
              onPick={addFromGitHub}
              pickedLabel={(item) => {
                const b = board();
                const ref = b && findCardByIssue(b, item.url);
                return ref && b ? `On board · ${b.columns[ref.column].title}` : null;
              }}
            />
          </div>
        </Show>
      </header>
      <Show when={board()}>
        <div class="kanban-toolbar">
          <label class="kanban-search">
            <SearchIcon size={13} />
            <input
              ref={filterRef}
              type="search"
              placeholder="Filter cards"
              aria-label="Filter cards"
              aria-keyshortcuts="/"
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
            <kbd aria-hidden="true">/</kbd>
          </label>
          <div class="kanban-segments" role="group" aria-label="Show cards">
            <For
              each={
                [
                  ['all', 'All'],
                  ['attention', 'Needs input'],
                  ['running', 'Running'],
                  ['review', 'To review'],
                  ['ready', 'Ready to start'],
                  ['blocked', 'Blocked'],
                ] as const
              }
            >
              {([value, label]) => {
                // Live counts sit inside their filter, in space that is always
                // reserved, so a task starting never reflows the toolbar.
                const count = () =>
                  value === 'attention'
                    ? summary().attention
                    : value === 'running'
                      ? summary().running
                      : value === 'review'
                        ? summary().review
                        : null;
                return (
                  <button
                    type="button"
                    aria-pressed={quick() === value}
                    aria-label={count() ? `${label}, ${count()}` : undefined}
                    onClick={() => setQuick(quick() === value && value !== 'all' ? 'all' : value)}
                  >
                    {label}
                    <Show when={count() !== null}>
                      <span
                        class="kanban-segment-count"
                        classList={{ urgent: value === 'attention' && !!count() }}
                        aria-hidden="true"
                      >
                        {count() || ''}
                      </span>
                    </Show>
                  </button>
                );
              }}
            </For>
          </div>
          <span class="kanban-spacer" />
          <button
            type="button"
            class="kanban-icon-button"
            ref={helpToggle}
            data-popover-toggle
            aria-expanded={showHelp()}
            aria-controls={showHelp() ? helpId : undefined}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
            onClick={() => togglePopover('help')}
          >
            ?
          </button>
          <Show when={showHelp()}>
            <KeyboardHelp id={helpId} onClose={() => closePopovers()} />
          </Show>
        </div>
      </Show>
      <Show when={error()}>
        <p role="alert" class="kanban-error">
          {error()}
        </p>
      </Show>
      <Show when={text() === undefined && !error()}>
        <div class="kanban-loading" aria-busy="true" aria-label="Loading board">
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
  depends: Token usage metrics
  issue: https://github.com/acme/api/issues/42`}
          </pre>
          <div class="kanban-empty-actions">
            <button type="button" class="kanban-primary" onClick={() => void createBoard()}>
              <PlusIcon /> Create board
            </button>
            <button
              type="button"
              onClick={() => {
                void createBoard();
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
                    <section
                      class="kanban-column-collapsed"
                      classList={{
                        'drag-over':
                          dragOver()?.column === columnIndex && dragOver()?.card === null,
                      }}
                      aria-label={column().title}
                      onDragOver={(e) => {
                        if (!e.dataTransfer?.types.includes(CARD_DRAG_TYPE)) return;
                        e.preventDefault();
                        setDragOver({ column: columnIndex, card: null });
                      }}
                      onDragLeave={(e) => {
                        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
                          setDragOver(null);
                        }
                      }}
                      onDrop={(e) => dropCard(e, columnIndex, 0)}
                    >
                      <button
                        type="button"
                        data-column-toggle={column().title}
                        aria-expanded={false}
                        title={`Expand ${column().title}`}
                        aria-label={`Expand column ${column().title}, ${plural(column().cards.length, 'card')}`}
                        onClick={() => toggleCollapsed(column().title)}
                      >
                        <ChevronRightIcon size={12} />
                        <span class="kanban-collapsed-title">{column().title}</span>
                        <span class="kanban-count">{column().cards.length}</span>
                      </button>
                    </section>
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
                      draggable={renaming() !== column().title && !editing()}
                      onDragStart={(e) => {
                        e.dataTransfer?.setData(COLUMN_DRAG_TYPE, column().title);
                      }}
                    >
                      <button
                        type="button"
                        class="kanban-icon"
                        data-column-toggle={column().title}
                        aria-expanded={true}
                        title={`Collapse ${column().title}`}
                        aria-label={`Collapse column ${column().title}`}
                        onClick={() => toggleCollapsed(column().title)}
                      >
                        <ChevronDownIcon size={12} />
                      </button>
                      <Show
                        when={renaming() === column().title}
                        fallback={
                          <h3
                            title={`${column().title} · double-click to rename`}
                            onDblClick={() => setRenaming(column().title)}
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
                            const title = column().title;
                            setRenaming(null);
                            change(
                              atColumn(title, (cur, index) => renameColumn(cur, index, value)),
                            );
                          }}
                          onCancel={() => setRenaming(null)}
                        />
                      </Show>
                      <div class="kanban-column-tools">
                        <button
                          type="button"
                          class="kanban-icon"
                          title={`Rename ${column().title} (R)`}
                          aria-label={`Rename column ${column().title}`}
                          onClick={() => setRenaming(column().title)}
                        >
                          <PencilIcon size={12} />
                        </button>
                        <button
                          type="button"
                          class="kanban-icon"
                          title={`Add a card to ${column().title}`}
                          aria-label={`Add a card to ${column().title}`}
                          onClick={() => setAdding(column().title)}
                        >
                          <PlusIcon size={12} />
                        </button>
                        <button
                          type="button"
                          class="kanban-icon"
                          title={
                            b().columns.length < 2 && column().cards.length > 0
                              ? 'The last column holds cards and cannot be deleted'
                              : `Delete column ${column().title}`
                          }
                          aria-label={`Delete column ${column().title}`}
                          disabled={b().columns.length < 2 && column().cards.length > 0}
                          onClick={() => deleteColumn(columnIndex)}
                        >
                          <TrashIcon size={12} />
                        </button>
                      </div>
                    </header>
                    <Show when={column().notes}>
                      <ColumnNotes text={column().notes} />
                    </Show>
                    <div class="kanban-cards" role="list" aria-label={column().title || 'Untitled'}>
                      <For each={visible()[columnIndex] ?? []}>
                        {(cardIndex) => {
                          const ref = () => ({ column: columnIndex, card: cardIndex });
                          const c = () => column().cards[cardIndex];
                          const isEditing = () => sameRef(editingRef(), ref());
                          const isSelected = () => sameRef(actionable(), ref());
                          const firstShown = () =>
                            !actionable() &&
                            navigableColumns()[0] === columnIndex &&
                            visible()[columnIndex]?.[0] === cardIndex;
                          const onHint = (
                            op: (b: KanbanBoard, at: KanbanCardRef) => KanbanBoard,
                          ) => {
                            const hint = hintFor(ref());
                            if (hint) change(atCard(hint, op));
                          };
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
                                      draggable={!editing()}
                                      dataRef={`${columnIndex}:${cardIndex}`}
                                      dropBefore={
                                        dragOver()?.column === columnIndex &&
                                        dragOver()?.card === cardIndex
                                      }
                                      dragging={sameRef(dragging(), ref())}
                                      flash={flashed().has(cardKey(column().title, current()))}
                                      onSelect={() => setSelection(hintFor(ref()))}
                                      onDragStart={(e) => {
                                        const hint = hintFor(ref());
                                        if (!hint || editing()) {
                                          e.preventDefault();
                                          return;
                                        }
                                        e.dataTransfer?.setData(
                                          CARD_DRAG_TYPE,
                                          JSON.stringify(hint),
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
                                      onEdit={() => setEditing(hintFor(ref()))}
                                      onStart={() => startTask(ref())}
                                      onToggleDone={(done) =>
                                        onHint((cur, at) => updateCard(cur, at, { done }))
                                      }
                                      onToggleChecklist={(line) =>
                                        onHint((cur, at) => toggleChecklistItem(cur, at, line))
                                      }
                                    />
                                  }
                                >
                                  <KanbanCardEditor
                                    card={current()}
                                    draft={draft()}
                                    onDraft={setDraft}
                                    columns={b().columns.map((col) => col.title)}
                                    column={columnIndex}
                                    otherTitles={b()
                                      .columns.flatMap((col) => col.cards.map((x) => x.title))
                                      .filter((t) => t && t !== current().title)}
                                    onSave={(next, toColumn) => {
                                      const hint = editing();
                                      setEditing(null);
                                      if (!hint) return;
                                      const target = b().columns[toColumn]?.title ?? hint.column;
                                      const length = b().columns[toColumn]?.cards.length ?? 0;
                                      change(
                                        atCard(hint, (cur, at) => {
                                          const updated = updateCard(cur, at, next);
                                          const to = updated.columns.findIndex(
                                            (col) => col.title === target,
                                          );
                                          return to < 0 || to === at.column
                                            ? updated
                                            : moveCard(updated, at, to);
                                        }),
                                      );
                                      const title = next.title.trim() || hint.title;
                                      focusHint(
                                        target === hint.column
                                          ? { ...hint, title }
                                          : {
                                              title,
                                              column: target,
                                              ref: { column: toColumn, card: length },
                                            },
                                      );
                                    }}
                                    onDelete={() => deleteCard(ref())}
                                    onArchive={() => archive(ref())}
                                    onCancel={() => {
                                      const hint = editing();
                                      setEditing(null);
                                      focusHint(hint);
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
                        when={
                          !filterActive() && !column().cards.length && adding() !== column().title
                        }
                      >
                        <p class="kanban-column-empty">No cards yet</p>
                      </Show>
                    </div>
                    <Show
                      when={adding() === column().title}
                      fallback={
                        <button
                          type="button"
                          class="kanban-add-card"
                          onClick={() => setAdding(column().title)}
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
                        onCommit={(value) => addCards(column().title, value)}
                        onPaste={(value) => {
                          if (titlesFromInput(value).length < 2) return false;
                          addCards(column().title, value);
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
      <span id={hintId} class="kanban-sr-only">
        Arrow keys move between cards, Enter edits a card, S starts a task, question mark lists all
        shortcuts.
      </span>
      <div class="kanban-sr-only" aria-live="polite">
        {announcement()}
      </div>
      <div
        class="kanban-undo"
        classList={{ shown: undo() !== null }}
        onPointerEnter={() => clearTimeout(undoTimer)}
        onPointerLeave={() => undo() && armUndoTimer()}
        onFocusIn={() => clearTimeout(undoTimer)}
        onFocusOut={() => undo() && armUndoTimer()}
      >
        <Show when={undo()}>
          {(offer) => (
            <>
              <span class="kanban-undo-label" title={offer().label}>
                {offer().label}
              </span>
              <button type="button" onClick={runUndo} aria-keyshortcuts="u">
                Undo
              </button>
            </>
          )}
        </Show>
      </div>
    </section>
  );
}

const MOD = isMac ? '⌘' : 'Ctrl';

const SHORTCUTS: [string[], string][] = [
  [['←', '→', '↑', '↓'], 'Move between cards (or h j k l)'],
  [['Shift', '+ arrow'], 'Move the card'],
  [['<', '>'], 'Move the whole column left or right'],
  [['Enter'], 'Edit the card (or e)'],
  [['s'], 'Start a task from the card'],
  [['x'], 'Mark done or not done (or Space)'],
  [['1', '…', '9'], 'Tick checklist item 1 to 9'],
  [['a'], 'Archive the card'],
  [['Delete'], 'Delete the card (or Backspace)'],
  [['u'], `Undo (or ${MOD}+Z)`],
  [['n'], 'New card in the selected column'],
  [['r'], 'Rename the selected column'],
  [['/'], 'Filter cards'],
  [['Esc'], 'Close this list, or clear the filter'],
  [[MOD, '+ Enter'], 'Save the card being edited'],
  [['?'], 'Show or hide this list'],
];

function KeyboardHelp(props: { id: string; onClose: () => void }) {
  return (
    <aside id={props.id} class="kanban-help" aria-label="Keyboard shortcuts">
      <div class="kanban-popover-head">
        <strong>Keyboard shortcuts</strong>
        <button
          type="button"
          class="kanban-icon"
          aria-label="Close keyboard shortcuts"
          onClick={() => props.onClose()}
        >
          <CloseIcon size={12} />
        </button>
      </div>
      <dl>
        <For each={SHORTCUTS}>
          {([keys, action]) => (
            <>
              <dt>
                <For each={keys}>
                  {(key) =>
                    key.startsWith('+') || key === '…' ? <span>{key}</span> : <kbd>{key}</kbd>
                  }
                </For>
              </dt>
              <dd>{action}</dd>
            </>
          )}
        </For>
      </dl>
    </aside>
  );
}

/** Column notes as written, with Markdown headings shown as headings rather than `###`. */
function ColumnNotes(props: { text: string }) {
  return (
    <div class="kanban-notes">
      <For each={props.text.split('\n')}>
        {(line) => {
          const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
          return heading ? (
            <strong class="kanban-notes-heading">{heading[1]}</strong>
          ) : (
            <span>{line || '\u00a0'}</span>
          );
        }}
      </For>
    </div>
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
          if (props.keepOpen) {
            if (!value.trim()) {
              // An empty Enter closes the field instead of leaving it open but idle.
              done = true;
              props.onCancel();
              return;
            }
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
    <div class="kanban-add-column" classList={{ open: open() }}>
      <Show
        when={open()}
        fallback={
          <button
            type="button"
            class="kanban-add-column-button"
            title="Add column"
            aria-label="Add column"
            onClick={() => setOpen(true)}
          >
            <PlusIcon size={13} />
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
