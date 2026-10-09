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

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
/** A closing fence carries no info string. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ATX_HEADING = /^ {0,3}(#{1,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
/** Lines that start a block of their own, so they cannot be a setext heading's text. */
const BLOCK_START = /^ {0,3}(?:[-*+>]|\d+[.)])\s/;
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * Headings of levels 1-3 outside fenced code, HTML comments and front matter,
 * in document order. Setext headings count as levels 1 and 2.
 */
export function markdownOutline(markdown: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  const lines = markdown.replace(FRONT_MATTER, '').replace(HTML_COMMENT, '').split(/\r?\n/);
  let fence: string | null = null;
  /** The previous line, while it could still be a setext heading's text. */
  let paragraph: string | null = null;
  for (const line of lines) {
    if (fence !== null) {
      // A fence closes only with the same character, at least as long.
      const marker = FENCE_CLOSE.exec(line)?.[1];
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    const opening = FENCE_OPEN.exec(line)?.[1];
    if (opening) {
      fence = opening;
      paragraph = null;
      continue;
    }
    const atx = ATX_HEADING.exec(line);
    const underline = SETEXT_UNDERLINE.exec(line)?.[1];
    if (atx) headings.push({ level: atx[1].length, text: atx[2].trim() });
    else if (underline && paragraph !== null)
      headings.push({ level: underline.startsWith('=') ? 1 : 2, text: paragraph });
    // Only a lone plain line can take an underline; a longer paragraph is not tracked.
    const plain = !atx && !underline && line.trim() !== '' && !BLOCK_START.test(line);
    paragraph = plain && paragraph === null ? line.trim() : null;
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
 * source: link syntax, backslash escapes, emphasis and code markers, list,
 * quote and heading markers, typographic quotes and dashes, whitespace and
 * case. Both sides go through it, so whatever it removes is removed alike.
 */
export function normalizeForMatch(text: string): string {
  return (
    text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\\([!-/:-@[-`{-~])/g, '$1')
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”‟]/g, '"')
      // Before the markers, so a spaced dash reads the same whichever kind was typed.
      .replace(/[–—−]/g, '-')
      // At any whitespace boundary, not just a line start: a quote spanning
      // list items arrives with its line breaks collapsed.
      .replace(/(^|\s)(?:#{1,6}|[-*+]|\d+[.)]|>)(?=\s)/g, '$1')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );
}

/** Shortest fragment worth checking; shorter ones match almost anywhere. */
const MIN_FRAGMENT_CHARS = 12;
/** The prompt allows joining two excerpts, no more. */
const MAX_FRAGMENTS = 2;
/**
 * Widest gap an ellipsis may bridge. Without it, true fragments from distant
 * paragraphs could be stitched into a claim the text never makes.
 */
const MAX_ELLIPSIS_GAP_CHARS = 300;

/**
 * Whether `quote` appears in the text whose normalised form is `normalizedSource`.
 * An ellipsis may join two fragments; each must be substantial, and the second
 * must follow the first closely.
 */
export function quoteAppearsIn(quote: string, normalizedSource: string): boolean {
  const fragments = quote
    .split(/\u2026|\.{3}/)
    .map(normalizeForMatch)
    .filter((fragment) => fragment.length > 0);
  if (fragments.length === 0 || fragments.length > MAX_FRAGMENTS) return false;
  if (fragments.some((fragment) => fragment.length < MIN_FRAGMENT_CHARS)) return false;
  const [first, second] = fragments;
  // Any occurrence of the first fragment may be the one the second follows.
  for (let at = normalizedSource.indexOf(first); at >= 0; ) {
    if (second === undefined) return true;
    const end = at + first.length;
    const next = normalizedSource.indexOf(second, end);
    if (next >= 0 && next - end <= MAX_ELLIPSIS_GAP_CHARS) return true;
    at = normalizedSource.indexOf(first, at + 1);
  }
  return false;
}
