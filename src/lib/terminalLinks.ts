export interface TerminalLinkMouseEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  preventDefault: () => void;
}

export interface TerminalLinkHandlerOptions {
  isMac: boolean;
  openExternal: (url: string) => Promise<void> | void;
  onOpenError?: () => void;
  requireModifier?: boolean;
}

export function normalizeHttpUrl(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function createTerminalHttpLinkHandler(options: TerminalLinkHandlerOptions) {
  return (event: TerminalLinkMouseEvent, uri: string): void => {
    if (options.requireModifier && !(options.isMac ? event.metaKey : event.ctrlKey)) return;

    event.preventDefault();
    const url = normalizeHttpUrl(uri);
    if (!url) return;

    try {
      Promise.resolve(options.openExternal(url)).catch(() => options.onOpenError?.());
    } catch {
      options.onOpenError?.();
    }
  };
}

// --- File-path link detection (wrapping-aware) ---------------------------------
//
// xterm stores a soft-wrapped line as several buffer rows, with `isWrapped` set on
// each continuation row. A link provider that only looks at a single row therefore
// misses any path that wraps — only the first-row fragment is clickable. These
// helpers reconstruct the whole logical line (joining wrapped rows) and map string
// offsets back to buffer coordinates, mirroring xterm's own WebLinksAddon so a
// wrapped path resolves to one link whose range spans the rows it occupies.

/** Minimal structural view of the xterm buffer API these helpers need. */
export interface TerminalBufferCell {
  getChars(): string;
  getWidth(): number;
}
export interface TerminalBufferLine {
  readonly length: number;
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
  getCell(x: number, cell?: TerminalBufferCell): TerminalBufferCell | undefined;
}
export interface TerminalBuffer {
  getLine(y: number): TerminalBufferLine | undefined;
  getNullCell(): TerminalBufferCell;
}

export interface PathMatch {
  index: number;
  text: string;
}

export interface TerminalPathLink {
  text: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
}

// Match file paths: absolute, ./ or ../ relative, and bare relative with a slash.
// Supports @scoped packages and line:col suffixes like foo.ts:42:10.
const PATH_REGEX =
  /(?:\/[\w@./-]+|\.{1,2}\/[\w@./-]+|[\w@.][\w@./-]*\/[\w@./-]+)(?::\d+(?::\d+)?)?/g;

/** Find file-path matches within a single (already-joined) line of text. */
export function matchTerminalPaths(line: string): PathMatch[] {
  const matches: PathMatch[] = [];
  PATH_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_REGEX.exec(line)) !== null) {
    // Strip trailing punctuation that's not part of the path.
    const text = match[0].replace(/[.,;:!?)]+$/, '');
    if (!text) continue;
    // Must contain a dot (file extension) to avoid matching plain directories.
    if (!text.includes('.')) continue;
    matches.push({ index: match.index, text });
  }
  return matches;
}

// Cap how far we scan across wrapped rows, matching xterm's own guard.
const MAX_WRAP_SCAN = 2048;

/**
 * Reconstruct the logical line that visual row `row` belongs to by walking back
 * over wrapped continuation rows and forward over the rest. Returns each row's
 * string and the buffer index of the logical line's first row. Ported from
 * xterm's LinkComputer._getWindowedLineStrings.
 */
function windowedLineStrings(
  buffer: TerminalBuffer,
  row: number,
): { strings: string[]; startRow: number } {
  const strings: string[] = [];
  let startRow = row;
  const first = buffer.getLine(row);
  if (!first) return { strings, startRow };
  const current = first.translateToString(true);

  // Walk backward to the logical start (a leading space means this row didn't
  // continue a token, so there's nothing to join backward).
  if (first.isWrapped && current[0] !== ' ') {
    let scanned = 0;
    let r = row;
    for (;;) {
      const prev = buffer.getLine(--r);
      if (!prev || scanned >= MAX_WRAP_SCAN) break;
      const s = prev.translateToString(true);
      scanned += s.length;
      strings.push(s);
      startRow = r;
      if (!prev.isWrapped || s.indexOf(' ') !== -1) break;
    }
    strings.reverse();
  }

  strings.push(current);

  // Walk forward over the continuation rows of this logical line.
  let scanned = 0;
  let r = row;
  for (;;) {
    const next = buffer.getLine(++r);
    if (!next || !next.isWrapped || scanned >= MAX_WRAP_SCAN) break;
    const s = next.translateToString(true);
    scanned += s.length;
    strings.push(s);
    if (s.indexOf(' ') !== -1) break;
  }

  return { strings, startRow };
}

/**
 * Map a string offset within the reconstructed line to a buffer `[row, col]`,
 * accounting for wide (2-cell) characters and the empty cell left when a wide
 * char wraps to the next row. Ported from xterm's LinkComputer._mapStrIdx.
 */
function mapStrIdx(
  buffer: TerminalBuffer,
  startRow: number,
  startCol: number,
  count: number,
): [number, number] {
  const nullCell = buffer.getNullCell();
  let row = startRow;
  let col = startCol;
  let remaining = count;
  while (remaining > 0) {
    const line = buffer.getLine(row);
    if (!line) return [-1, -1];
    for (let a = col; a < line.length; a++) {
      const cell = line.getCell(a, nullCell);
      if (!cell) break;
      const chars = cell.getChars();
      if (cell.getWidth()) {
        remaining -= chars.length || 1;
        // A wide char that couldn't fit at the row edge leaves this last cell
        // empty and wraps to the next row; skip the phantom cell.
        if (a === line.length - 1 && chars === '') {
          const next = buffer.getLine(row + 1);
          if (next?.isWrapped) {
            const nextCell = next.getCell(0, nullCell);
            if (nextCell?.getWidth() === 2) remaining += 1;
          }
        }
      }
      if (remaining < 0) return [row, a];
    }
    row++;
    col = 0;
  }
  return [row, col];
}

/**
 * Compute clickable file-path links for the logical line containing buffer row
 * `row` (0-based). Ranges use 1-based buffer coordinates and may span rows, so a
 * wrapped path is clickable across every row it occupies.
 */
export function computeWrappedPathLinks(buffer: TerminalBuffer, row: number): TerminalPathLink[] {
  const { strings, startRow } = windowedLineStrings(buffer, row);
  if (strings.length === 0) return [];
  const joined = strings.join('');
  const links: TerminalPathLink[] = [];
  for (const match of matchTerminalPaths(joined)) {
    const [sr, sc] = mapStrIdx(buffer, startRow, 0, match.index);
    const [er, ec] = mapStrIdx(buffer, sr, sc, match.text.length);
    if (sr < 0 || sc < 0 || er < 0 || ec < 0) continue;
    links.push({
      text: match.text,
      range: { start: { x: sc + 1, y: sr + 1 }, end: { x: ec, y: er + 1 } },
    });
  }
  return links;
}
