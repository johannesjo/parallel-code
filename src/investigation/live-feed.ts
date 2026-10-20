import { batch, createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import type { ReasoningFeedRead } from '../../electron/shared/reasoning';
import { invoke } from '../lib/ipc';
import { reasoningFeedChange } from '../store/reasoning-activity';
import { emptyHistory } from './state';
import { parseReasoningFeed } from './feed';

interface ReasoningSource {
  taskId: string;
  agentId: string;
  worktreePath: string;
}

const POLL_MS = 1000;

/** Poll only visible panes. The main process answers `unchanged` from a file stamp, so a
 *  quiet feed costs one stat per second; this renderer's own writes trigger an immediate read. */
export function createReasoningFeed(
  source: Accessor<ReasoningSource | undefined>,
  visible: Accessor<boolean>,
) {
  const [history, setHistory] = createSignal(emptyHistory());
  const [error, setError] = createSignal('');
  const [pending, setPending] = createSignal(false);
  const [loaded, setLoaded] = createSignal(false);
  const [updatedAt, setUpdatedAt] = createSignal<number>();
  // Updates already on disk when polling (re)starts have no terminal position worth marking.
  const [jumpableFrom, setJumpableFrom] = createSignal(0);
  let refreshNow: (() => Promise<void>) | undefined;
  createEffect(() => {
    const current = source();
    let accepted = emptyHistory();
    let stamp: string | undefined;
    let lastRaw: string | undefined;
    batch(() => {
      setHistory(accepted);
      setError('');
      setPending(false);
      setLoaded(false);
      setUpdatedAt(undefined);
      setJumpableFrom(0);
    });
    if (!current) return;
    const apply = (read: ReasoningFeedRead | null, first: boolean) => {
      if (first) setJumpableFrom(accepted.updates.length);
      if (read === null) {
        setPending(false);
        setError(
          accepted.updates.length ? 'Report unavailable; showing the last valid graph.' : '',
        );
        stamp = lastRaw = undefined;
        return;
      }
      stamp = read.stamp;
      if (read.unchanged || read.raw === lastRaw) return;
      const result = parseReasoningFeed(read.raw, accepted);
      accepted = result.history;
      lastRaw = read.raw;
      batch(() => {
        setHistory(accepted);
        setError(result.error ?? '');
        setPending(result.pending);
        setUpdatedAt(Date.now());
        if (first) setJumpableFrom(accepted.updates.length);
      });
    };
    createEffect(() => {
      if (!visible()) return;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let inFlight: Promise<void> | undefined;
      let firstRead = true;
      async function read() {
        const first = firstRead;
        firstRead = false;
        try {
          const result = await invoke<ReasoningFeedRead | null>(IPC.ReadReasoningFeed, {
            ...current,
            knownStamp: stamp,
          });
          if (!stopped) apply(result, first);
        } catch (e) {
          if (stopped) return;
          if (first) setJumpableFrom(accepted.updates.length);
          setPending(false);
          setError(e instanceof Error ? e.message : 'Could not read the reasoning report');
          stamp = lastRaw = undefined;
        } finally {
          if (!stopped) {
            setLoaded(true);
            timer = setTimeout(() => void run(), POLL_MS);
          }
        }
      }
      function run(): Promise<void> {
        clearTimeout(timer);
        if (!inFlight) inFlight = read().finally(() => (inFlight = undefined));
        return inFlight;
      }
      // A read already under way may predate the write; queue one more after it.
      refreshNow = () => (inFlight ? inFlight.then(() => (stopped ? undefined : run())) : run());
      void run();
      createEffect(
        on(reasoningFeedChange, (change) => {
          if (change?.taskId === current.taskId) void refreshNow?.();
        }),
      );
      onCleanup(() => {
        stopped = true;
        refreshNow = undefined;
        clearTimeout(timer);
      });
    });
  });
  return {
    snapshot: () => history().snapshots.at(-1),
    /** Accepted updates in sequence order. */
    updates: () => history().updates,
    /** Index of the first update observed live rather than in the catch-up read. */
    jumpableFrom,
    runId: () => history().updates[0]?.runId,
    /** The latest update's caption, when the agent gave one. */
    caption: () => history().updates.at(-1)?.caption,
    error,
    pending,
    /** True once the current source has been read at least once. */
    loaded,
    /** When this renderer last saw the feed change; undefined before the first read. */
    updatedAt,
    /** Re-read now, coalesced with any read in flight; resolves once the feed is current. */
    refresh: (): Promise<void> => refreshNow?.() ?? Promise.resolve(),
  };
}
