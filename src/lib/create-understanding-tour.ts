/**
 * Controller for guided understanding tours: plan tours, file tours and tours
 * the coding agent publishes through MCP.
 * Owns generation, the follow-up threads under each card and navigation; the
 * tour lives in renderer memory only. See docs/guided-understanding-plan.md.
 */

import { createSignal, onCleanup } from 'solid-js';
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
  type TourBranch,
  type UnderstandingTour,
  type UnderstandingTourKind,
} from './understanding-tour';

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
  /** Answered follow-ups, so reopening the tour keeps them under their cards. */
  threads: TourBranch[];
}

function cacheKey(kind: UnderstandingTourKind, subject: string): string {
  return `${kind}:${subject}`;
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
  const [step, setStep] = createSignal(0);
  // Every answered follow-up, in the order asked; each remembers its card.
  const [threads, setThreads] = createSignal<TourBranch[]>([]);
  /** The question in flight and the card it was asked from, or null when idle. */
  const [pending, setPending] = createSignal<{ question: string; fromIndex: number } | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [asking, setAsking] = createSignal(false);
  const [error, setError] = createSignal('');
  const [progress, setProgress] = createSignal('');
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0);
  const [receiving, setReceiving] = createSignal(false);
  /** The file behind the file tour on screen changed after the tour was made. */
  const [stale, setStale] = createSignal(false);
  // Finished tours, so starting a file tour does not discard a finished plan
  // tour. A signal (not a bare Map) keeps isReady() reactive for the buttons.
  const [cache, setCache] = createSignal<ReadonlyMap<string, CachedTour>>(new Map());

  let request: { cancel: () => void } | undefined;
  /** The exact context the tour was built from, replayed to follow-ups (D2). */
  let context = '';
  let cwd = '';
  let lastInput: UnderstandingTourInput | undefined;
  /** Bumped by every cancel and every new run so late results are ignored. */
  let token = 0;

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
    setTour(null);
    setStep(0);
    setThreads([]);
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
  }

  onCleanup(cancel);

  /**
   * Reports a failure. A follow-up's belongs to the card it was asked from, so
   * once the reader has moved on it is dropped — the same as navigating away
   * from a failed ask. A tour-level failure passes no card and always shows.
   */
  function reportError(message: string, fromIndex?: number): void {
    if (fromIndex !== undefined && fromIndex !== step()) return;
    setError(message);
  }

  /**
   * Runs one request, returning its text, or `undefined` when it was cancelled
   * or superseded. Failures throw so callers report them through `error()`.
   */
  async function run(options: {
    prompt: string;
    request: UnderstandingRequestKind;
    active: number;
    /** The card a follow-up was asked from; its provider errors belong there. */
    fromIndex?: number;
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
        if (active === token) reportError(message, options.fromIndex);
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
      setCache((prev) =>
        new Map(prev).set(cacheKey(input.kind, tourSubject), {
          tour: parsed,
          context: built.context,
          cwd: input.worktreePath,
          input,
          threads: [],
        }),
      );
      setTour(parsed);
      setStep(0);
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
    setCache((prev) =>
      new Map(prev).set(cacheKey('agent', input.subject), {
        tour: input.tour,
        context: tourContext,
        cwd: input.worktreePath,
        input: cachedInput,
        threads: [],
      }),
    );
    setKind('agent');
    setSubject(input.subject);
    setTour(input.tour);
    setStep(0);
    options.onReady?.(input.subject);
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
    if (kind() !== tourKind || subject() !== tourSubject || !tour()) {
      cancel();
      clearView();
      context = cached.context;
      cwd = cached.cwd;
      lastInput = cached.input;
      setKind(tourKind);
      setSubject(tourSubject);
      setTour(cached.tour);
      setThreads(cached.threads);
    }
    void checkFileFreshness(cached);
    return true;
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

  /** Re-runs the last generate input; used by Retry and by Regenerate on a stale tour. */
  function retry(): void {
    if (lastInput) void generate(lastInput);
  }

  /** Regenerates the tour on screen with the reader's request for how it should change. */
  function rework(instructions: string): void {
    if (lastInput && instructions.trim()) void generate({ ...lastInput, instructions });
  }

  /** The answered follow-ups under one spine card, oldest first. */
  function threadsFor(index: number): TourBranch[] {
    return threads().filter((thread) => thread.fromIndex === index);
  }

  /**
   * The question waiting for an answer under the card on screen. The answer
   * joins the thread of the card it was asked from, so no other card may show
   * it waiting — it would vanish from there the moment the answer arrived.
   */
  function pendingQuestion(): string {
    const inFlight = pending();
    return inFlight && inFlight.fromIndex === step() ? inFlight.question : '';
  }

  /** Keeps the cache entry of the tour on screen in step with its threads. */
  function cacheThreads(nextThreads: TourBranch[]): void {
    const tourKind = kind();
    if (!tourKind) return;
    const key = cacheKey(tourKind, subject());
    setCache((prev) => {
      const entry = prev.get(key);
      return entry ? new Map(prev).set(key, { ...entry, threads: nextThreads }) : prev;
    });
  }

  /**
   * Asks about the current card. The answer joins the thread under that card;
   * earlier answers there are replayed so a second question builds on them.
   */
  async function ask(question: string): Promise<void> {
    const current = tour();
    if (!current || !question.trim()) return;
    request?.cancel();
    const active = ++token;
    const fromIndex = step();
    setAsking(true);
    setPending({ question, fromIndex });
    setError('');
    setElapsedSeconds(0);
    setReceiving(false);
    try {
      const prompt = buildFollowUpPrompt({
        tour: current,
        currentIndex: fromIndex,
        question,
        context,
        earlier: threadsFor(fromIndex),
      });
      const text = await run({ prompt, request: 'follow-up', active, fromIndex });
      if (text === undefined) return;
      const branch = groundBranch(
        parseTourBranch(text, fromIndex, question),
        current.kind,
        context,
      );
      const nextThreads = [...threads(), branch];
      setThreads(nextThreads);
      cacheThreads(nextThreads);
      setAsking(false);
      setPending(null);
      // Provider stderr can arrive even on a request that then succeeded.
      setError('');
    } catch (cause) {
      if (active !== token) return;
      setAsking(false);
      setPending(null);
      reportError(errMessage(cause), fromIndex);
    }
  }

  function goDeeper(): void {
    void ask(GO_DEEPER_QUESTION);
  }

  /** A failed ask belonged to the card it was asked from, not to the next one. */
  function clearError(): void {
    setError('');
  }

  /** Clamped index into the spine. */
  function navigate(index: number): void {
    const total = tour()?.cards.length ?? 0;
    if (total === 0) return;
    clearError();
    setStep(Math.min(Math.max(index, 0), total - 1));
  }

  function next(): void {
    navigate(step() + 1);
  }

  function previous(): void {
    navigate(step() - 1);
  }

  return {
    tour,
    kind,
    subject,
    step,
    threads,
    threadsFor,
    pendingQuestion,
    loading,
    asking,
    error,
    progress,
    elapsedSeconds,
    receiving,
    stale,
    generate,
    publish,
    open,
    isReady,
    isLoading,
    errorFor,
    retry,
    rework,
    navigate,
    next,
    previous,
    ask,
    goDeeper,
    cancel,
    reset,
  };
}

export type UnderstandingTourController = ReturnType<typeof createUnderstandingTour>;

/** The slice entry-point buttons read to show their own subject's state. */
export type UnderstandingTourState = Pick<UnderstandingTourController, 'isReady' | 'isLoading'> &
  Partial<Pick<UnderstandingTourController, 'errorFor' | 'receiving' | 'elapsedSeconds'>>;
