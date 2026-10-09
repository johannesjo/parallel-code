/**
 * Heading outline and text normalisation for plan and document tours. The
 * outline goes into the prompt so the model sees a long document's structure;
 * the normalisation lets the app check the model's quotes and omissions
 * against the text it was given. See docs/tour-polish-plan.md.
 */

export interface OutlineHeading {
  level: number;
  text: string;
}

/** Headings past this count are thinned to levels 1-2, then cut. */
export const MAX_OUTLINE_HEADINGS = 60;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;

/** ATX headings of levels 1-3 outside fenced code, in document order. */
export function markdownOutline(markdown: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      // A fence closes only with the same character, at least as long.
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = ATX_HEADING.exec(line);
    if (match) headings.push({ level: match[1].length, text: match[2].trim() });
  }
  if (headings.length <= MAX_OUTLINE_HEADINGS) return headings;
  return headings.filter((heading) => heading.level <= 2).slice(0, MAX_OUTLINE_HEADINGS);
}

/** The outline as indented lines for the prompt; empty when there are no headings. */
export function renderOutline(headings: OutlineHeading[]): string {
  return headings.map((heading) => `${'  '.repeat(heading.level - 1)}- ${heading.text}`).join('\n');
}

/**
 * Folds the differences a faithful quote may still have from its Markdown
 * source: link syntax, emphasis and code markers, list and heading markers,
 * typographic quotes and dashes, whitespace and case.
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+[.)]|>)[ \t]+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Shortest fragment worth checking; shorter ones match almost anywhere. */
const MIN_FRAGMENT_CHARS = 12;

/**
 * Whether `quote` appears in the text whose normalised form is `normalizedSource`.
 * An ellipsis joins fragments; each must appear, in order. A quote made only of
 * tiny fragments proves nothing and does not count.
 */
export function quoteAppearsIn(quote: string, normalizedSource: string): boolean {
  const fragments = quote
    .split(/…|\.{3}/)
    .map(normalizeForMatch)
    .filter((fragment) => fragment.length > 0);
  if (!fragments.some((fragment) => fragment.length >= MIN_FRAGMENT_CHARS)) return false;
  let from = 0;
  for (const fragment of fragments) {
    const at = normalizedSource.indexOf(fragment, from);
    if (at < 0) return false;
    from = at + fragment.length;
  }
  return true;
}
