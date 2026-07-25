import { createSignal } from 'solid-js';
import type { GitIgnoredEntry } from '../ipc/types';

export type SymlinkCandidatesFetcher = (projectRoot: string) => Promise<GitIgnoredEntry[]>;

/**
 * Checkbox state for the New Task dialog's symlink-dir picker.
 *
 * Lifecycle contract:
 * - Every load clears the previous dirs AND selection up front, so a stale
 *   project can never submit its checkmarks into a new task.
 * - A monotonically increasing request id invalidates in-flight responses:
 *   a late reply from a previous project (or a closed dialog) is dropped
 *   instead of overwriting the current project's state.
 * - `loading()` is true from the moment a fetch starts until its fresh
 *   response lands, so the dialog can block submit on an unresolved list.
 */
export function createSymlinkCandidateState(fetchCandidates: SymlinkCandidatesFetcher) {
  const [dirs, setDirs] = createSignal<string[]>([]);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = createSignal(false);
  let requestId = 0;

  /** Drop any in-flight response (dialog closed, effect re-run). */
  function invalidate(): void {
    requestId += 1;
    setLoading(false);
  }

  async function load(projectRoot: string | undefined, isGitRepo: boolean): Promise<void> {
    const id = ++requestId;
    // Clear before the async fetch — not just when skipping — so nothing
    // stale is visible (or submittable) while the new list is in flight.
    setDirs([]);
    setSelected(new Set<string>());
    if (!projectRoot || !isGitRepo) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const entries = await fetchCandidates(projectRoot);
      if (id !== requestId) return; // stale — a newer load owns the state
      setDirs(entries.map((entry) => entry.name));
      setSelected(new Set(entries.filter((entry) => entry.isDefault).map((entry) => entry.name)));
    } catch {
      // The backend already degrades to [] on git failures; a transport
      // failure here just leaves the cleared (empty) state in place.
    } finally {
      if (id === requestId) setLoading(false);
    }
  }

  function toggle(dir: string): void {
    const next = new Set(selected());
    if (next.has(dir)) next.delete(dir);
    else next.add(dir);
    setSelected(next);
  }

  return { dirs, selected, loading, load, invalidate, toggle };
}
