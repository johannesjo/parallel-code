export interface SwitcherItem {
  id: string;
  name: string;
  /** Secondary text beside the name: a task's project and branch, or the task an action acts on. */
  detail: string;
  /** An action's key combo, shown but not searched: "ctrl" would match nearly everything. */
  shortcut?: string;
  /** Hidden extra search words, e.g. "merge" for Finish task. */
  keywords?: string;
}

/** Whether the detail is searched too; an action's target task is not, or
 *  typing the active task's name would also list every action for it. */
export interface FilterOptions {
  searchDetail?: boolean;
}

/**
 * Items whose name, detail or keywords contain every whitespace-separated word
 * of the query, case-insensitively. Plain substring words keep matches
 * predictable: "api fix" finds "Fix login" in project "api". Names starting
 * with the query rank first, then items where every word starts a word, as in
 * VS Code and Raycast; ties keep their original order.
 */
export function filterSwitcherItems(
  items: SwitcherItem[],
  query: string,
  options: FilterOptions = {},
): SwitcherItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  const searchDetail = options.searchDetail ?? true;
  return items
    .map((item) => {
      const haystack = [item.name, searchDetail ? item.detail : '', item.keywords ?? '']
        .join(' ')
        .toLowerCase();
      return { item, haystack };
    })
    .filter(({ haystack }) => words.every((word) => haystack.includes(word)))
    .map(({ item, haystack }) => ({ item, rank: matchRank(item.name, haystack, words) }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ item }) => item);
}

function matchRank(name: string, haystack: string, words: string[]): number {
  if (name.toLowerCase().startsWith(words.join(' '))) return 0;
  const starts = haystack.split(/[^a-z0-9]+/);
  return words.every((word) => starts.some((start) => start.startsWith(word))) ? 1 : 2;
}

/** A leading ">" narrows the switcher to actions, as in VS Code's quick open. */
export function parseSwitcherQuery(query: string): { actionsOnly: boolean; text: string } {
  const trimmed = query.trimStart();
  return trimmed.startsWith('>')
    ? { actionsOnly: true, text: trimmed.slice(1) }
    : { actionsOnly: false, text: query };
}
