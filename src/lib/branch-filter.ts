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

  const prefix: string[] = [];
  const substring: string[] = [];
  for (const branch of branches) {
    const lower = branch.toLowerCase();
    if (lower.startsWith(q)) prefix.push(branch);
    else if (lower.includes(q)) substring.push(branch);
  }
  return [...prefix, ...substring];
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
