/**
 * Pure helpers for the branch combobox in the New Task dialog.
 *
 * Kept DOM-free so the matching behavior can be unit tested.
 */

/**
 * Filter a branch list by a free-text query (case-insensitive substring
 * match). Branches whose name starts with the query are ordered before
 * branches that merely contain it; ties keep the original order.
 *
 * An empty (or whitespace-only) query returns the list unchanged.
 */
export function filterBranches(branches: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...branches];

  // Lowercase each name once up front; the sort comparator below would
  // otherwise recompute it O(n log n) times.
  return branches
    .map((name) => ({ name, lower: name.toLowerCase() }))
    .filter((b) => b.lower.includes(q))
    .sort((a, b) => {
      // Prefix matches rank above plain substring matches. Array.sort is
      // stable, so branches keep their original order within each group.
      const aPrefix = a.lower.startsWith(q);
      const bPrefix = b.lower.startsWith(q);
      return aPrefix === bPrefix ? 0 : aPrefix ? -1 : 1;
    })
    .map((b) => b.name);
}

/**
 * Return the branch that exactly matches the query (case-insensitive), or
 * null when the query does not name an existing branch. Used to commit a
 * fully-typed value on blur without forcing the user to click a list item.
 */
export function matchExactBranch(branches: string[], query: string): string | null {
  const q = query.trim().toLowerCase();
  if (q === '') return null;
  return branches.find((b) => b.toLowerCase() === q) ?? null;
}

/**
 * Clamp a highlighted-option index into the valid range for a list of `count`
 * options. An empty list pins the index at 0, so a stale `-1` (from
 * `count - 1` when `count` is 0) can never be used to index the match array.
 */
export function clampHighlight(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, index));
}

/**
 * Decide which branch the combobox should hold once focus leaves it.
 *
 * - Untouched (`dirty` false): keep the committed `value`.
 * - Dirty with a fully-typed branch name: resolve to that branch.
 * - Dirty with partial or unmatched text: discard it and keep `value`.
 */
export function resolveOnBlur(
  branches: string[],
  query: string,
  dirty: boolean,
  value: string,
): string {
  if (!dirty) return value;
  return matchExactBranch(branches, query) ?? value;
}
