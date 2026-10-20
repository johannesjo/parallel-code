export interface SwitcherItem {
  id: string;
  name: string;
  /** Secondary text shown and searched beside the name, e.g. project and branch. */
  detail: string;
}

/**
 * Items whose name or detail contains every whitespace-separated word of the
 * query, case-insensitively, in their original order. Plain substring words
 * keep matches predictable: "api fix" finds "Fix login" in project "api".
 */
export function filterSwitcherItems(items: SwitcherItem[], query: string): SwitcherItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  return items.filter((item) => {
    const haystack = `${item.name} ${item.detail}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
