/** Source offsets used by canvas persistence. */

export interface BlockWrite {
  startOffset: number;
  endOffset: number;
  replacement: string;
}

export const normalizeLineEndings = (markdown: string): string =>
  markdown.replace(/\r\n?|\n/g, '\n');

export const preferredLineEnding = (markdown: string): string => {
  const counts = new Map<string, number>();
  for (const match of markdown.matchAll(/\r\n|\r|\n/g)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  let preferred = '\n';
  let highest = 0;
  for (const [lineEnding, count] of counts) {
    if (count > highest) {
      preferred = lineEnding;
      highest = count;
    }
  }
  return preferred;
};

const rawOffsetAt = (source: string, normalizedOffset: number): number => {
  let raw = 0;
  let normalized = 0;
  while (normalized < normalizedOffset && raw < source.length) {
    raw += source[raw] === '\r' && source[raw + 1] === '\n' ? 2 : 1;
    normalized++;
  }
  return raw;
};

/** The smallest raw-source write that produces normalized `replacement`. */
export function minimalBlockWrite(source: string, replacement: string): BlockWrite {
  const normalizedSource = normalizeLineEndings(source);
  let start = 0;
  while (start < normalizedSource.length && normalizedSource[start] === replacement[start]) start++;
  let sourceEnd = normalizedSource.length;
  let replacementEnd = replacement.length;
  while (
    sourceEnd > start &&
    replacementEnd > start &&
    normalizedSource[sourceEnd - 1] === replacement[replacementEnd - 1]
  ) {
    sourceEnd--;
    replacementEnd--;
  }
  return {
    startOffset: rawOffsetAt(source, start),
    endOffset: rawOffsetAt(source, sourceEnd),
    replacement: replacement
      .slice(start, replacementEnd)
      .replace(/\n/g, preferredLineEnding(source)),
  };
}

/** The source as it reads once `write` has been applied to it. */
export function applyBlockWrite(source: string, write: BlockWrite): string {
  return source.slice(0, write.startOffset) + write.replacement + source.slice(write.endOffset);
}
