/**
 * Controller for guided understanding tours: plan tours, file tours and tours
 * the coding agent publishes through MCP.
 * Owns generation, the tree of follow-up answers under each card and the
 * navigation through it; the tour lives in renderer memory only.
 * See docs/guided-understanding-plan.md.
 */

import { batch, createMemo, createSignal, onCleanup } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from './ipc';
import { errMessage, warn as logWarn } from './log';
import { startUnderstandingRequest, type UnderstandingRequestKind } from './understanding-request';
import {
  GO_DEEPER_QUESTION,
  buildDocumentTourPrompt,
  buildFileTourPrompt,
  buildFollowUpPrompt,
  buildPlanTourPrompt,
  buildTopicTourPrompt,
  compactSpine,
  renderFileTourContext,
} from './understanding-prompt';
import {
  groundBranch,
  groundTour,
  parseTourBranch,
  parseUnderstandingTour,
  type FileTourContext,
  type UnderstandingTour,
  type UnderstandingTourKind,
} from './understanding-tour';
import {
  TOUR_CARD_LIMITS,
  TOUR_FILE_CHANGED,
  TOUR_FILE_MAX_CARDS,
  TOUR_FILE_MAX_CHARS,
  UNDERSTANDING_MAX_OUTPUT_CHARS,
} from '../../electron/shared/understanding-limits';
import { serializeTour, tourFileName, type TourFile, type TourFileKind } from './tour-file';
import { blankCard, hasWriting, isBlankCard, removeNode } from './tour-tree-edit';
import {
  MAX_TOUR_DEPTH,
  appendChildren,
  countNodes,
  createNodeIds,
  findNode,
  nextNodeId,
  nodeTrail,
  nodesFromCards,
  pointQuestion,
  previousNodeId,
  rootIndexOf,
  type TourNode,
} from './tour-tree';

/**
 * Subject of a plan tour. The entry-point button compares it with the running
 * tour's subject, so both sides must derive it the same way. The worktree path
 * is preferred so a tour of the same file from the canvas shares the cache.
 */
export function planTourSubject(task: { planFileName?: string; planPath?: string }): string {
  return task.planPath ?? task.planFileName ?? 'plan';
}

/**
 * Which tour a canvas document gets: the task's own plan keeps its plan tour,
 * so both entry points share one cached tour; any other document gets a
 * document tour. Only the real plan path counts, never the file-name fallback
 * of planTourSubject(), which could name an unrelated document.
 */
export function documentTourKind(task: { planPath?: string }, path: string): 'plan' | 'document' {
  return task.planPath !== undefined && path === task.planPath ? 'plan' : 'document';
}

/** Hooks for background generation: the entry button is the only thing on screen. */
export interface UnderstandingTourOptions {
  onReady?: (subject: string) => void;
  onError?: (message: string) => void;
}

/** The reader's "Rework tour" request, carried so Retry repeats it. */
interface ReworkInstructions {
  instructions?: string;
}

export type UnderstandingTourInput = ReworkInstructions &
  (
    | {
        kind: 'plan';
        taskName: string;
        worktreePath: string;
        planContent: string;
        subject: string;
      }
    | { kind: 'file'; taskName: string; worktreePath: string; filePath: string }
    /** A Markdown document from the canvas, read fresh when the tour starts. */
    | {
        kind: 'document';
        taskName: string;
        worktreePath: string;
        content: string;
        subject: string;
      }
    /**
     * A tour the agent published. It is only regenerated when the reader
     * reworks it, from `context`: the material the agent summarised.
     */
    | { kind: 'agent'; taskName: string; worktreePath: string; subject: string; context?: string }
  );

/** The cache key's subject for one input; both entry buttons and open() need it. */
export function tourInputSubject(input: UnderstandingTourInput): string {
  return input.kind === 'file' ? input.filePath : input.subject;
}

/** A finished tour plus everything a follow-up needs to replay its context. */
interface CachedTour {
  tour: UnderstandingTour;
  context: string;
  cwd: string;
  input: UnderstandingTourInput;
  /** The cards with every answered follow-up under them, so reopening keeps them. */
  tree: TourNode[];
  /** Worktree-relative path of the text or file the tour explains. */
  source?: string;
  /** Where the reader saved the tour; later answers keep that file up to date. */
  savedPath?: string;
  /**
   * What the saved file held when the tour last wrote or read it, to notice
   * edits made outside the tour; only a write that landed changes it.
   */
  savedText?: string;
  /**
   * The tour's own text when its file last matched it. A hand-formatted file
   * reads back to the same cards but not the same characters, so whether
   * answers are unsaved is judged by this rather than by savedText.
   */
  cleanText?: string;
  /**
   * The kind a reopened file was saved with, written back to it, when what it
   * explains is gone and the tour itself runs as a tour of its cards, and
   * 'thinking' on a tour the reader writes themselves.
   */
  fileKind?: TourFileKind;
}

/** The worktree path a tour explains: what a saved file names as its source. */
function sourceOf(input: UnderstandingTourInput): string | undefined {
  if (input.kind === 'file') return input.filePath;
  return input.kind === 'agent' ? undefined : input.subject;
}

/** The tour's own cards as the roots of a fresh tree. */
function treeOf(tour: UnderstandingTour): TourNode[] {
  return nodesFromCards(tour.cards, createNodeIds());
}

/** The answers under one card, grouped by the question each answered, oldest first. */
function answersUnder(node: TourNode): { question: string; cards: UnderstandingTour['cards'] }[] {
  const groups: { question: string; cards: UnderstandingTour['cards'] }[] = [];
  for (const child of node.children) {
    if (child.question === undefined) continue;
    const last = groups.at(-1);
    if (last?.question === child.question) last.cards.push(child.card);
    else groups.push({ question: child.question, cards: [child.card] });
  }
  return groups;
}

function cacheKey(kind: UnderstandingTourKind, subject: string): string {
  return `${kind}:${subject}`;
}

/**
 * A tour reopened from its file is its own entry, so it never replaces a
 * generated tour of the same subject, answers the reader has not saved included.
 */
const SAVED_KEY_PREFIX = 'saved:';

function savedKey(path: string): string {
  return `${SAVED_KEY_PREFIX}${path}`;
}

/** Every blank tour started is its own entry: none has a subject yet to key it by. */
const THINKING_KEY_PREFIX = 'thinking:';

/** How long typing pauses before a tour the reader writes is saved. */
const EDIT_SAVE_DELAY_MS = 600;

/** A cached tour as the text of its saved file. */
function entryText(entry: CachedTour): string {
  return serializeTour(
    {
      subject: entry.tour.subject,
      kind: entry.fileKind ?? entry.tour.kind,
      ...(entry.source && { source: entry.source }),
      ...(entry.tour.omitted && { omitted: entry.tour.omitted }),
      roots: entry.tree,
    },
    { forFile: true },
  );
}

/**
 * Whether a cached reopened file still replays what reopening it now would:
 * the plan, document or file as read now, or its cards when that is gone.
 */
function replaysSource(entry: CachedTour, file: TourFile, sourceText?: string): boolean {
  const { kind, source } = file;
  if (kind !== 'plan' && kind !== 'document' && kind !== 'file') return true;
  if (!source || sourceText === undefined) return entry.input.kind === 'agent';
  return entry.input.kind === kind && entry.context === sourceText;
}

/**
 * Plan and document tours explain the text they were built from, so an edited
 * text needs a new tour. File tours are keyed by path only and checked after
 * they open, see checkFileFreshness().
 */
function isStale(cached: UnderstandingTourInput, input: UnderstandingTourInput): boolean {
  if (cached.kind === 'plan' && input.kind === 'plan')
    return cached.planContent !== input.planContent;
  if (cached.kind === 'document' && input.kind === 'document')
    return cached.content !== input.content;
  return false;
}

export function createUnderstandingTour(options: UnderstandingTourOptions = {}) {
  const [tour, setTour] = createSignal<UnderstandingTour | null>(null);
  const [kind, setKind] = createSignal<UnderstandingTourKind | null>(null);
  const [subject, setSubject] = createSignal('');
  /** The tour's cards with every answered follow-up nested under its card. */
  const [tree, setTree] = createSignal<TourNode[]>([]);
  /** The card on screen; empty while there is no tour. */
  const [currentId, setCurrentId] = createSignal('');
  /** The question in flight and the card it was asked on, or null when idle. */
  const [pending, setPending] = createSignal<{ question: string; nodeId: string } | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [asking, setAsking] = createSignal(false);
  const [error, setError] = createSignal('');
  const [progress, setProgress] = createSignal('');
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0);
  const [receiving, setReceiving] = createSignal(false);
  /** The file behind the file tour on screen changed after the tour was made. */
  const [stale, setStale] = createSignal(false);
  /** Worktree-relative path the tour on screen is saved to, or ''. */
  const [savedPath, setSavedPath] = createSignal('');
  /** Cache keys with a write queued or running, once per write. */
  const [writing, setWriting] = createSignal<readonly string[]>([]);
  // Finished tours, so starting a file tour does not discard a finished plan
  // tour. A signal (not a bare Map) keeps isReady() reactive for the buttons.
  const [cache, setCache] = createSignal<ReadonlyMap<string, CachedTour>>(new Map());

  let request: { cancel: () => void } | undefined;
  /** The exact context the tour was built from, replayed to follow-ups (D2). */
  let context = '';
  let cwd = '';
  let lastInput: UnderstandingTourInput | undefined;
  /** What the tour on screen explains, for its saved file. */
  let source: string | undefined;
  /** The cache entry of the tour on screen. */
  let shownKey = '';
  /** See CachedTour.fileKind. */
  let fileKind: TourFileKind | undefined;
  /** The tour on screen is one the reader writes: fileKind 'thinking', as a signal. */
  const [thinking, setThinking] = createSignal(false);
  /** Blank tours started, for their cache keys. */
  let thinkingRuns = 0;
  /** The save waiting for typing to pause; see edit(). */
  let editSave: ReturnType<typeof setTimeout> | undefined;
  /** editSave as a signal, for the save state on screen. */
  const [editPending, setEditPending] = createSignal(false);
  /** Saves run one after another, so an older tree never lands last. */
  let writes: Promise<void> = Promise.resolve();
  /** Bumped by every cancel and every new run so late results are ignored. */
  let token = 0;
  /** Bumped by every restore, so the file opened last is the one shown. */
  let restores = 0;

  function cancel(): void {
    token += 1;
    request?.cancel();
    request = undefined;
    setLoading(false);
    setAsking(false);
    setPending(null);
    setProgress('');
  }

  /** Clears what is on screen; finished tours stay in the cache. */
  function clearView(): void {
    // The tour going off screen keeps what was typed into it last.
    flushEdits();
    setTour(null);
    setTree([]);
    setCurrentId('');
    setSavedPath('');
    shownKey = '';
    setFileKind(undefined);
    setError('');
    setElapsedSeconds(0);
    setReceiving(false);
    setStale(false);
  }

  function reset(): void {
    cancel();
    clearView();
    setKind(null);
    setSubject('');
    setCache(new Map());
    context = '';
    cwd = '';
    lastInput = undefined;
    source = undefined;
  }

  onCleanup(() => {
    flushEdits();
    cancel();
  });

  function setFileKind(next: TourFileKind | undefined): void {
    fileKind = next;
    setThinking(next === 'thinking');
  }

  /**
   * Reports a failure. A follow-up's belongs to the card it was asked on, so
   * once the reader has moved on it is dropped — the same as navigating away
   * from a failed ask. A tour-level failure passes no card and always shows.
   */
  function reportError(message: string, nodeId?: string): void {
    if (nodeId !== undefined && nodeId !== currentId()) return;
    setError(message);
  }

  /** Puts a tour and its tree on screen, opening on the gist. */
  function show(shown: UnderstandingTour, shownTree: TourNode[]): void {
    // One update, so nothing reading the tour sees it beside the last one's tree.
    batch(() => {
      setTour(shown);
      setTree(shownTree);
      setCurrentId(shownTree[0]?.id ?? '');
    });
  }

  /**
   * Runs one request, returning its text, or `undefined` when it was cancelled
   * or superseded. Failures throw so callers report them through `error()`.
   */
  async function run(options: {
    prompt: string;
    request: UnderstandingRequestKind;
    active: number;
    /** The card a follow-up was asked on; its provider errors belong there. */
    nodeId?: string;
  }): Promise<string | undefined> {
    const { active } = options;
    const handle = startUnderstandingRequest({
      prompt: options.prompt,
      cwd,
      request: options.request,
      onElapsed: (seconds) => {
        if (active === token) setElapsedSeconds(seconds);
      },
      onReceiving: () => {
        if (active === token) setReceiving(true);
      },
      onProviderError: (message) => {
        if (active === token) reportError(message, options.nodeId);
      },
    });
    request = handle;
    const outcome = await handle.result;
    if (active !== token) return undefined;
    request = undefined;
    if (outcome.status === 'cancelled') return undefined;
    if (outcome.status === 'failed') throw new Error(outcome.message);
    return outcome.text;
  }

  /** Builds the prompt plus the context string replayed to follow-ups. */
  async function buildPrompt(
    input: UnderstandingTourInput,
  ): Promise<{ prompt: string; context: string }> {
    const { instructions } = input;
    if (input.kind === 'agent') {
      if (!input.context) throw new Error('This tour has nothing to regenerate it from.');
      return {
        prompt: buildTopicTourPrompt({
          taskName: input.taskName,
          subject: input.subject,
          context: input.context,
          instructions,
        }),
        context: input.context,
      };
    }
    if (input.kind === 'plan')
      return {
        prompt: buildPlanTourPrompt({
          taskName: input.taskName,
          planContent: input.planContent,
          instructions,
        }),
        context: input.planContent,
      };
    if (input.kind === 'document')
      return {
        prompt: buildDocumentTourPrompt({
          taskName: input.taskName,
          path: input.subject,
          content: input.content,
          instructions,
        }),
        context: input.content,
      };
    const bundle = await invoke<FileTourContext>(IPC.ReadFileTourContext, {
      worktreePath: input.worktreePath,
      filePath: input.filePath,
    });
    return {
      prompt: buildFileTourPrompt({ taskName: input.taskName, context: bundle, instructions }),
      context: renderFileTourContext(bundle),
    };
  }

  /** Runs in the background: nothing opens the viewer, so callers watch the hooks. */
  async function generate(input: UnderstandingTourInput): Promise<void> {
    cancel();
    clearView();
    const active = ++token;
    const tourSubject = tourInputSubject(input);
    lastInput = input;
    cwd = input.worktreePath;
    source = sourceOf(input);
    shownKey = cacheKey(input.kind, tourSubject);
    setKind(input.kind);
    setSubject(tourSubject);
    setLoading(true);
    setProgress(
      input.kind === 'file'
        ? 'Reading file…'
        : input.instructions
          ? 'Reworking tour…'
          : 'Generating tour…',
    );
    try {
      const built = await buildPrompt(input);
      if (active !== token) return;
      context = built.context;
      setProgress(input.instructions ? 'Reworking tour…' : 'Generating tour…');
      const text = await run({ prompt: built.prompt, request: 'tour', active });
      if (text === undefined) return;
      const parsed = groundTour(
        parseUnderstandingTour(text, input.kind, tourSubject),
        built.context,
      );
      const parsedTree = treeOf(parsed);
      setCache((prev) =>
        new Map(prev).set(shownKey, {
          tour: parsed,
          context: built.context,
          cwd: input.worktreePath,
          input,
          tree: parsedTree,
          source: sourceOf(input),
        }),
      );
      show(parsed, parsedTree);
      setError('');
      setLoading(false);
      setProgress('');
      options.onReady?.(tourSubject);
    } catch (cause) {
      if (active !== token) return;
      setLoading(false);
      setProgress('');
      const message = errMessage(cause);
      setError(message);
      options.onError?.(message);
    }
  }

  /**
   * Puts a tour the agent wrote straight on screen, no provider call. Published
   * tours are cached like generated ones, so follow-ups and reopening work the
   * same; without a context from the agent the cards themselves are replayed.
   */
  function publish(input: {
    subject: string;
    tour: UnderstandingTour;
    context: string;
    worktreePath: string;
  }): void {
    // cancel() bumps the token, so a request still in flight cannot overwrite this.
    cancel();
    clearView();
    const tourContext = input.context.trim() || compactSpine(input.tour);
    // A published tour is never generated, so the cached input carries no prompt
    // material; taskName only exists because every input shape has one.
    const cachedInput: UnderstandingTourInput = {
      kind: 'agent',
      taskName: input.subject,
      worktreePath: input.worktreePath,
      subject: input.subject,
      context: tourContext,
    };
    context = tourContext;
    cwd = input.worktreePath;
    lastInput = cachedInput;
    source = undefined;
    shownKey = cacheKey('agent', input.subject);
    const publishedTree = treeOf(input.tour);
    setCache((prev) =>
      new Map(prev).set(shownKey, {
        tour: input.tour,
        context: tourContext,
        cwd: input.worktreePath,
        input: cachedInput,
        tree: publishedTree,
      }),
    );
    setKind('agent');
    setSubject(input.subject);
    show(input.tour, publishedTree);
    options.onReady?.(input.subject);
  }

  /**
   * Opens a blank tour the reader writes themselves, on its one empty card.
   * The first card's title names the tour. Nothing is saved until a card has
   * text, so a tour opened and closed blank leaves no file behind.
   */
  function startThinking(input: { worktreePath: string; taskName: string }): void {
    cancel();
    clearView();
    const first: TourNode = { id: createNodeIds()(), card: blankCard(), children: [] };
    const started: UnderstandingTour = { subject: '', kind: 'agent', cards: [first.card] };
    context = '';
    cwd = input.worktreePath;
    // Nothing to regenerate it from: Retry and Rework stay out of reach.
    lastInput = undefined;
    source = undefined;
    shownKey = `${THINKING_KEY_PREFIX}${++thinkingRuns}`;
    setFileKind('thinking');
    setCache((prev) =>
      new Map(prev).set(shownKey, {
        tour: started,
        context: '',
        cwd: input.worktreePath,
        input: { kind: 'agent', ...input, subject: '', context: '' },
        tree: [first],
        fileKind: 'thinking',
      }),
    );
    setKind('agent');
    setSubject('');
    show(started, [first]);
  }

  /**
   * Replaces the tree of a tour the reader writes, then shows `focusId` when
   * given. The first card's title names the tour. Saving waits for typing to
   * pause, so a burst of keys costs one write.
   */
  function edit(nextTree: TourNode[], focusId?: string): void {
    if (!thinking() || !tour()) return;
    setTree(nextTree);
    cacheTree(nextTree);
    setSubject(nextTree[0]?.card.title.trim() ?? '');
    if (focusId) select(focusId);
    if (editSave !== undefined) clearTimeout(editSave);
    editSave = setTimeout(flushEdits, EDIT_SAVE_DELAY_MS);
    setEditPending(true);
  }

  /** Writes edits still waiting for typing to pause; see edit(). */
  function flushEdits(): void {
    if (editSave === undefined) return;
    clearTimeout(editSave);
    editSave = undefined;
    setEditPending(false);
    if (savedPath()) void persist();
    else if (hasWriting(tree())) void save();
  }

  /**
   * Drops a card left blank, showing the card before it, or the one after for
   * a first card. The tour keeps at least one card to write on.
   */
  function dropIfBlank(id: string): void {
    const blank = findNode(tree(), id);
    if (!blank || !isBlankCard(blank.card) || countNodes(tree()) < 2) return;
    // Only a card still on screen needs a neighbour; one already left keeps the reader where they went.
    const neighbour =
      id === currentId()
        ? (previousNodeId(tree(), id) ?? blank.children[0]?.id ?? nextNodeId(tree(), id))
        : undefined;
    edit(removeNode(tree(), id), neighbour);
  }

  /**
   * Shows an already generated tour without regenerating it. Returns false when
   * nothing usable is cached for that subject, so callers fall back to generate().
   */
  function open(input: UnderstandingTourInput): boolean {
    const tourKind = input.kind;
    const tourSubject = tourInputSubject(input);
    const key = cacheKey(tourKind, tourSubject);
    const cached = cache().get(key);
    if (!cached) return false;
    if (isStale(cached.input, input)) {
      setCache((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
      return false;
    }
    // Reopening the tour already on screen keeps the reader's place in it.
    if (shownKey !== key || !tour()) showEntry(key, cached);
    void checkFileFreshness(cached);
    return true;
  }

  /** Puts a cached tour on screen, opening on its gist. */
  function showEntry(key: string, cached: CachedTour): void {
    cancel();
    clearView();
    context = cached.context;
    cwd = cached.cwd;
    lastInput = cached.input;
    source = cached.source;
    shownKey = key;
    setFileKind(cached.fileKind);
    setKind(cached.input.kind);
    setSubject(tourInputSubject(cached.input));
    show(cached.tour, cached.tree);
    setSavedPath(cached.savedPath ?? '');
  }

  /**
   * Re-reads a file tour's context and flags the tour when it no longer matches
   * what the tour was built from. It flags rather than regenerates, so a changed
   * file never costs a provider call the reader did not ask for.
   */
  async function checkFileFreshness(cached: CachedTour): Promise<void> {
    const { input } = cached;
    if (input.kind !== 'file') return;
    const shown = tour();
    try {
      const bundle = await invoke<FileTourContext>(IPC.ReadFileTourContext, {
        worktreePath: input.worktreePath,
        filePath: input.filePath,
      });
      // The reader may have moved on to another tour while the file was read.
      if (tour() !== shown) return;
      setStale(renderFileTourContext(bundle) !== cached.context);
    } catch (error) {
      // A file that can no longer be read is as stale as one that changed.
      logWarn('understandingTour', 'Could not re-read the toured file', {
        error: errMessage(error),
      });
      if (tour() === shown) setStale(true);
    }
  }

  function isReady(tourKind: UnderstandingTourKind, tourSubject: string): boolean {
    return cache().has(cacheKey(tourKind, tourSubject));
  }

  function isLoading(tourKind: UnderstandingTourKind, tourSubject: string): boolean {
    return loading() && kind() === tourKind && subject() === tourSubject;
  }

  /** An error belongs to the run that produced it, not to every entry button. */
  function errorFor(tourKind: UnderstandingTourKind, tourSubject: string): string {
    return kind() === tourKind && subject() === tourSubject ? error() : '';
  }

  /**
   * A tour reopened from its file is that file's record of an exploration, so
   * it is never regenerated in place: a new tour of its subject starts from the
   * subject's own Take Tour.
   */
  function fromFile(): boolean {
    return shownKey.startsWith(SAVED_KEY_PREFIX);
  }

  /** Re-runs the last generate input; used by Retry and by Regenerate on a stale tour. */
  function retry(): void {
    if (lastInput && !fromFile()) void generate(lastInput);
  }

  /** Regenerates the tour on screen with the reader's request for how it should change. */
  function rework(instructions: string): void {
    if (lastInput && instructions.trim() && !fromFile())
      void generate({ ...lastInput, instructions });
  }

  /** The tour on screen as the file it saves to. */
  function currentFile(): TourFile | undefined {
    const shown = tour();
    if (!shown) return undefined;
    return {
      subject: subject(),
      kind: fileKind ?? shown.kind,
      ...(source && { source }),
      ...(shown.omitted && { omitted: shown.omitted }),
      roots: tree(),
    };
  }

  /**
   * Records where a cached tour is saved and what its file holds, so reopening
   * it keeps saving there; no path forgets the file.
   */
  function cacheSaved(key: string, saved?: { path: string; text: string }): void {
    setCache((prev) => {
      const entry = prev.get(key);
      if (!entry) return prev;
      return new Map(prev).set(key, {
        ...entry,
        savedPath: saved?.path,
        savedText: saved?.text,
        cleanText: saved?.text,
      });
    });
  }

  /**
   * Writes a tour's text to its file and returns where it landed. A first save
   * picks a free name from the subject; later ones replace that file. The text
   * and worktree are taken when the save starts, so a tour opened meanwhile
   * can never be written over this one's file.
   */
  function write(target: {
    worktreePath: string;
    path: string;
    content: string;
    replace: boolean;
    /** What the file should still hold; an edit made outside the tour refuses the write. */
    expected?: string;
  }) {
    return invoke<string>(IPC.SaveTourFile, target);
  }

  /** The tour on screen as the text of its saved file. */
  function fileText(): string | undefined {
    const file = currentFile();
    return file && serializeTour(file, { forFile: true });
  }

  /** Whether a write of the tour on screen is queued or running. */
  function saving(): boolean {
    return writing().includes(shownKey);
  }

  /**
   * Whether the saved tour on screen holds answers its file does not: a write
   * is still on its way, or one failed. Kept apart from the file it saves to,
   * so a failed update leaves something to retry rather than looking saved.
   */
  const unsaved = createMemo(() => {
    // Typing not yet paused is written by flushEdits, not something to retry.
    if (!savedPath() || editPending()) return false;
    const content = fileText();
    return content !== undefined && content !== cache().get(shownKey)?.cleanText;
  });

  /**
   * Saves the tour on screen into the worktree as Markdown, so it can be
   * reopened from the canvas, committed or handed to the agent. Once saved,
   * every new answer updates the file; saving again only retries an update
   * that failed.
   */
  async function save(): Promise<void> {
    const shown = tour();
    const content = fileText();
    if (!shown || content === undefined || saving()) return;
    setError('');
    if (savedPath()) {
      if (unsaved()) await persist();
      return;
    }
    const key = shownKey;
    const path = await queueWrite(
      {
        worktreePath: cwd,
        path: tourFileName(subject() || (thinking() ? 'thinking' : '')),
        content,
        replace: false,
      },
      key,
      shown,
      'Could not save the tour',
    );
    if (!path || tour() !== shown) return;
    setSavedPath(path);
    // Answers that arrived while the first save ran are written now.
    if (fileText() !== content) void persist();
  }

  /** Keeps a saved tour's file in step with its tree; unsaved tours stay in memory. */
  function persist(): Promise<string | undefined> {
    const path = savedPath();
    const content = fileText();
    // A tour emptied again keeps its last version: a file with no cards would not open.
    if (!path || content === undefined || !hasWriting(tree())) return Promise.resolve(undefined);
    return queueWrite(
      { worktreePath: cwd, path, content, replace: true },
      shownKey,
      tour(),
      `Could not update ${path}`,
    );
  }

  /**
   * Runs writes one after another, saves and updates alike, so an older tree
   * never lands last. Resolves with the path written, or undefined when the
   * write failed or its tour has gone from the cache.
   */
  function queueWrite(
    target: Omit<Parameters<typeof write>[0], 'expected'>,
    key: string,
    shown: UnderstandingTour | null,
    failed: string,
  ): Promise<string | undefined> {
    setWriting((keys) => [...keys, key]);
    const run = writes
      .then(() => writeQueued(target, key, shown, failed))
      .finally(() =>
        setWriting((keys) => {
          const index = keys.indexOf(key);
          return index < 0 ? keys : [...keys.slice(0, index), ...keys.slice(index + 1)];
        }),
      );
    writes = run.then(() => undefined);
    return run;
  }

  /** Whether `key` still holds the tour a write was queued for. */
  function stillCached(key: string, shown: UnderstandingTour | null): boolean {
    return shown !== null && cache().get(key)?.tour === shown;
  }

  async function writeQueued(
    target: Omit<Parameters<typeof write>[0], 'expected'>,
    key: string,
    shown: UnderstandingTour | null,
    failed: string,
  ): Promise<string | undefined> {
    if (!stillCached(key, shown)) return undefined;
    // What the last write that landed left there, read only now that it has.
    // A conflict ahead in the queue let go of the file, and every update
    // queued behind it goes with it rather than writing over the edit.
    const entry = cache().get(key);
    if (target.replace && (entry?.savedPath !== target.path || entry.savedText === undefined))
      return undefined;
    const expected = target.replace ? entry?.savedText : undefined;
    try {
      const path = await write({ ...target, ...(expected !== undefined && { expected }) });
      // A file reopened while this update ran is its own record now; this
      // tour keeps no claim on it.
      const landed = !target.replace || cache().get(key)?.savedPath === target.path;
      if (landed && stillCached(key, shown)) cacheSaved(key, { path, text: target.content });
      return path;
    } catch (cause) {
      const conflict = errMessage(cause).includes(TOUR_FILE_CHANGED);
      if (conflict && stillCached(key, shown)) cacheSaved(key);
      if (tour() === shown) forgetFile(target.replace ? target.path : '', cause, failed);
      return undefined;
    }
  }

  /**
   * Reports a failed write. A file edited outside the tour is never written
   * over: the tour lets go of it, so the next save makes a new file.
   */
  function forgetFile(path: string, cause: unknown, failed: string): void {
    const message = errMessage(cause);
    if (!path || !message.includes(TOUR_FILE_CHANGED)) {
      setError(`${failed}: ${message}`);
      return;
    }
    setSavedPath('');
    setError(
      `${path} was changed or removed outside the tour, so it was left as it is. Open it again from the canvas, or save this tour as a new file.`,
    );
  }

  /**
   * Shows a tour saved in the worktree, with every answer in it, without a
   * provider call. Follow-ups replay what it explains: the text passed in,
   * the file re-read, or the cards themselves when neither is there any more.
   * Reopening the file already on screen, unchanged, keeps the reader's place.
   */
  async function restore(input: {
    file: TourFile;
    /** The file's text as read, to tell whether it changed since it was shown. */
    text: string;
    savedPath: string;
    worktreePath: string;
    taskName: string;
    /** The plan or document the tour explains, read fresh; absent when gone. */
    sourceText?: string;
  }): Promise<void> {
    const { file, taskName, worktreePath } = input;
    const active = token;
    const run = ++restores;
    const fileContext =
      file.kind === 'file' && file.source
        ? await readFileContext(worktreePath, file.source)
        : undefined;
    if (active !== token || run !== restores) return;
    const sourceText = file.kind === 'file' ? fileContext : input.sourceText;
    // The file's own entry, while the file is as it last wrote or read it and
    // the entry replays what is there now, is the same tour: show it, with any
    // answers not yet saved, keeping the reader's place when it is on screen. A
    // generated tour that saved this file is never reused; the file is its own record.
    const key = savedKey(input.savedPath);
    const entry = cache().get(key);
    if (
      entry?.savedPath === input.savedPath &&
      entry.savedText === input.text &&
      replaysSource(entry, file, sourceText)
    ) {
      if (shownKey !== key || !tour()) showEntry(key, entry);
      return;
    }
    cancel();
    clearView();
    const cards = file.roots.map((node) => node.card);
    const fromCards = (): UnderstandingTourInput => ({
      kind: 'agent',
      taskName,
      worktreePath,
      subject: file.subject,
      context: compactSpine({ cards }),
    });
    let restoredInput: UnderstandingTourInput = fromCards();
    if (file.source && input.sourceText !== undefined && file.kind === 'plan')
      restoredInput = {
        kind: 'plan',
        taskName,
        worktreePath,
        planContent: input.sourceText,
        subject: file.source,
      };
    else if (file.source && input.sourceText !== undefined && file.kind === 'document')
      restoredInput = {
        kind: 'document',
        taskName,
        worktreePath,
        content: input.sourceText,
        subject: file.source,
      };
    let restoredContext =
      restoredInput.kind === 'plan'
        ? restoredInput.planContent
        : restoredInput.kind === 'document'
          ? restoredInput.content
          : compactSpine({ cards });
    if (file.kind === 'file' && file.source && fileContext !== undefined) {
      restoredInput = { kind: 'file', taskName, worktreePath, filePath: file.source };
      restoredContext = fileContext;
    }
    const restoredSubject = tourInputSubject(restoredInput);
    // Follow-ups and their quotes go by what is replayed; the file keeps the
    // kind it was saved with, even when what it explains is gone.
    const restored: UnderstandingTour = {
      subject: restoredSubject,
      kind: restoredInput.kind,
      cards,
      ...(file.omitted && { omitted: file.omitted }),
    };
    context = restoredContext;
    cwd = worktreePath;
    lastInput = restoredInput;
    source = file.source;
    shownKey = savedKey(input.savedPath);
    setFileKind(file.kind === restoredInput.kind ? undefined : file.kind);
    setCache((prev) => {
      const next = new Map(prev);
      // Only one tour writes a file; any other that saved here lets go of it.
      for (const [key, entry] of next)
        if (entry.savedPath === input.savedPath)
          next.set(key, {
            ...entry,
            savedPath: undefined,
            savedText: undefined,
            cleanText: undefined,
          });
      const restoredEntry: CachedTour = {
        tour: restored,
        context: restoredContext,
        cwd: worktreePath,
        input: restoredInput,
        tree: file.roots,
        source: file.source,
        savedPath: input.savedPath,
        savedText: input.text,
        ...(fileKind && { fileKind }),
      };
      return next.set(shownKey, { ...restoredEntry, cleanText: entryText(restoredEntry) });
    });
    setKind(restoredInput.kind);
    setSubject(restoredSubject);
    show(restored, file.roots);
    setSavedPath(input.savedPath);
  }

  /** A toured file's context as it reads now; undefined when it cannot be read. */
  async function readFileContext(worktreePath: string, filePath: string) {
    try {
      const bundle = await invoke<FileTourContext>(IPC.ReadFileTourContext, {
        worktreePath,
        filePath,
      });
      return renderFileTourContext(bundle);
    } catch (error) {
      logWarn('understandingTour', 'Could not re-read the toured file', {
        error: errMessage(error),
      });
      return undefined;
    }
  }

  /** The card on screen. */
  function currentNode(): TourNode | undefined {
    return findNode(tree(), currentId());
  }

  /** The card on screen and the cards above it, outermost first. */
  function trail(): TourNode[] {
    return nodeTrail(tree(), currentId());
  }

  /** Index of the tour card the reader is under, for the progress strip. */
  function step(): number {
    return Math.max(0, rootIndexOf(tree(), currentId()));
  }

  /**
   * Why no question can be asked on the card on screen: answers nest down to
   * MAX_TOUR_DEPTH, and a tour stops before an answer could take it past the
   * cards or the size its saved file may hold. '' when asking is open. A memo:
   * the size check serializes the whole tour, and the viewer reads this often.
   */
  const askLimit = createMemo((): '' | 'depth' | 'cards' | 'size' => {
    if (trail().length >= MAX_TOUR_DEPTH) return 'depth';
    if (countNodes(tree()) + TOUR_CARD_LIMITS.branchMaxCards > TOUR_FILE_MAX_CARDS) return 'cards';
    // shortcut: one response's output ceiling stands in for an answer's size in
    // the file — measure the serialized branch if this stops tours too early.
    if ((fileText()?.length ?? 0) + UNDERSTANDING_MAX_OUTPUT_CHARS > TOUR_FILE_MAX_CHARS)
      return 'size';
    return '';
  });

  function canAsk(): boolean {
    return trail().length > 0 && askLimit() === '';
  }

  /**
   * The question waiting for an answer under the card on screen. The answer
   * lands under the card it was asked on, so no other card may show it
   * waiting — it would vanish from there the moment the answer arrived.
   */
  function pendingQuestion(): string {
    const inFlight = pending();
    return inFlight && inFlight.nodeId === currentId() ? inFlight.question : '';
  }

  /** Keeps the cache entry of the tour on screen in step with its tree. */
  function cacheTree(nextTree: TourNode[]): void {
    const key = shownKey;
    setCache((prev) => {
      const entry = prev.get(key);
      return entry ? new Map(prev).set(key, { ...entry, tree: nextTree }) : prev;
    });
  }

  /**
   * Asks about the card on screen. The answer's cards become its children,
   * and a reader still on that card is taken into the first of them; earlier
   * answers there are replayed so a second question builds on them.
   */
  async function ask(question: string): Promise<void> {
    const current = tour();
    const asked = currentNode();
    if (!current || !asked || !question.trim() || !canAsk()) return;
    request?.cancel();
    const active = ++token;
    const nodeId = asked.id;
    const path = trail();
    setAsking(true);
    setPending({ question, nodeId });
    setError('');
    setElapsedSeconds(0);
    setReceiving(false);
    try {
      const prompt = buildFollowUpPrompt({
        tour: current,
        currentIndex: rootIndexOf(tree(), nodeId),
        path: path.slice(1).map((node) => node.card),
        question,
        context,
        earlier: answersUnder(asked),
      });
      const text = await run({ prompt, request: 'follow-up', active, nodeId });
      if (text === undefined) return;
      const branch = groundBranch(
        parseTourBranch(text, rootIndexOf(tree(), nodeId), question),
        current.kind,
        context,
      );
      const answers = nodesFromCards(branch.cards, createNodeIds(tree()), question);
      const nextTree = appendChildren(tree(), nodeId, answers);
      setTree(nextTree);
      cacheTree(nextTree);
      void persist();
      setAsking(false);
      setPending(null);
      // Provider stderr can arrive even on a request that then succeeded.
      setError('');
      if (currentId() === nodeId) setCurrentId(answers[0].id);
    } catch (cause) {
      if (active !== token) return;
      setAsking(false);
      setPending(null);
      reportError(errMessage(cause), nodeId);
    }
  }

  function goDeeper(): void {
    void ask(GO_DEEPER_QUESTION);
  }

  /** Digs into one point of the slide on screen. */
  function goDeeperOn(point: string): void {
    void ask(pointQuestion(point));
  }

  /** A failed ask belonged to the card it was asked on, not to the next one. */
  function clearError(): void {
    setError('');
  }

  /** Shows one card of the tree; an unknown id changes nothing. */
  function select(id: string | undefined): void {
    if (!id || !findNode(tree(), id) || id === currentId()) return;
    clearError();
    setCurrentId(id);
  }

  /** Shows one of the tour's own cards, clamped to the first and last. */
  function navigate(index: number): void {
    const roots = tree();
    if (roots.length === 0) return;
    select(roots[Math.min(Math.max(index, 0), roots.length - 1)].id);
  }

  /** The next card at this level, climbing out after the last child. */
  function next(): void {
    select(nextNodeId(tree(), currentId()));
  }

  /** The previous card at this level, or the parent from a first child. */
  function previous(): void {
    select(previousNodeId(tree(), currentId()));
  }

  /** Back out to the card this one answers. */
  function leave(): void {
    const path = trail();
    select(path.at(-2)?.id);
  }

  /** Whether next() has anywhere to go; the last card offers Finish instead. */
  function hasNext(): boolean {
    return nextNodeId(tree(), currentId()) !== undefined;
  }

  function hasPrevious(): boolean {
    return previousNodeId(tree(), currentId()) !== undefined;
  }

  return {
    tour,
    kind,
    subject,
    tree,
    currentId,
    currentNode,
    trail,
    step,
    pending,
    pendingQuestion,
    canAsk,
    askLimit,
    loading,
    asking,
    error,
    progress,
    elapsedSeconds,
    receiving,
    stale,
    savedPath,
    saving,
    unsaved,
    generate,
    publish,
    open,
    restore,
    save,
    thinking,
    startThinking,
    edit,
    dropIfBlank,
    isReady,
    isLoading,
    errorFor,
    retry,
    rework,
    navigate,
    select,
    next,
    previous,
    leave,
    hasNext,
    hasPrevious,
    ask,
    goDeeper,
    goDeeperOn,
    cancel,
    reset,
    fromFile,
  };
}

export type UnderstandingTourController = ReturnType<typeof createUnderstandingTour>;

/** The slice entry-point buttons read to show their own subject's state. */
export type UnderstandingTourState = Pick<UnderstandingTourController, 'isReady' | 'isLoading'> &
  Partial<Pick<UnderstandingTourController, 'errorFor' | 'receiving' | 'elapsedSeconds'>>;
