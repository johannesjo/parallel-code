import { createSignal } from 'solid-js';

/** One saved user edit, kept as the graphs on either side of it. */
interface EditTransition<T> {
  before: T;
  after: T;
}

/**
 * Bounded undo/redo of user edits. Entries are detached transitions instead of whole
 * snapshots so a step can be replayed as a difference on top of later agent updates.
 */
export function createEditHistory<T>(limit = 50) {
  const [past, setPast] = createSignal<EditTransition<T>[]>([]);
  const [future, setFuture] = createSignal<EditTransition<T>[]>([]);
  return {
    canUndo: () => past().length > 0,
    canRedo: () => future().length > 0,
    /** Record a new edit; any redo branch is discarded. */
    push(entry: EditTransition<T>): void {
      setPast((history) => [...history, entry].slice(-limit));
      setFuture([]);
    },
    /** Move the nearest entry to the other side and return it, or undefined when there is none. */
    step(redo: boolean): EditTransition<T> | undefined {
      const source = redo ? future() : past();
      const entry = source.at(-1);
      if (!entry) return;
      if (redo) {
        setFuture(source.slice(0, -1));
        setPast((history) => [...history, entry]);
      } else {
        setPast(source.slice(0, -1));
        setFuture((history) => [...history, entry]);
      }
      return entry;
    },
    /** Return the entry `step(redo)` just moved when its replay could not be saved. */
    unstep(redo: boolean): void {
      const [source, setSource, setTarget] = redo
        ? ([past(), setPast, setFuture] as const)
        : ([future(), setFuture, setPast] as const);
      const entry = source.at(-1);
      if (!entry) return;
      setSource(source.slice(0, -1));
      setTarget((history) => [...history, entry]);
    },
    /** Called when the recorded edits can no longer be replayed. */
    reset(): void {
      setPast([]);
      setFuture([]);
    },
  };
}
