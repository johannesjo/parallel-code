import DOMPurify from 'dompurify';
import { Marked, type Token, type Tokens } from 'marked';
import { highlightLines } from './shiki-highlighter';

/**
 * A top-level markdown block with its source line range. Blocks are the unit
 * of selection, scope and change marking in document workspaces: prose is
 * rewritten paragraph by paragraph, so line-level diffs would be noise.
 */
export interface DocumentBlock {
  index: number;
  type: string;
  /** 1-based, inclusive source lines. */
  startLine: number;
  endLine: number;
  raw: string;
  html: string;
  headingLevel?: number;
  headingText?: string;
}

export type BlockChange = 'same' | 'added' | 'changed' | 'removed';

interface TokenLike {
  type: string;
  lang?: string;
  text?: string;
  tokens?: TokenLike[];
  items?: { tokens?: TokenLike[] }[];
}

function collectCodeTokens(tokens: readonly TokenLike[], out: { lang: string; text: string }[]) {
  for (const token of tokens) {
    if (token.type === 'code' && token.lang !== 'mermaid') {
      out.push({ lang: token.lang ?? '', text: token.text ?? '' });
    }
    if (Array.isArray(token.tokens)) collectCodeTokens(token.tokens, out);
    if (Array.isArray(token.items)) {
      for (const item of token.items) {
        if (Array.isArray(item.tokens)) collectCodeTokens(item.tokens, out);
      }
    }
  }
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Normalizes line endings the same way marked does, so offsets line up. */
export function normalizeSource(source: string): string {
  return source.replace(/\r\n|\r/g, '\n');
}

/**
 * Splits a document into top-level blocks, each rendered to sanitized HTML
 * with Shiki-highlighted code. Blank-line tokens are dropped; their lines are
 * absorbed into the gap between blocks.
 */
export async function renderDocumentBlocks(rawSource: string): Promise<DocumentBlock[]> {
  const source = normalizeSource(rawSource);
  const marked = new Marked();
  const tokens = marked.lexer(source);

  const codeBlocks: { lang: string; text: string }[] = [];
  collectCodeTokens(tokens as unknown as TokenLike[], codeBlocks);
  const highlighted = await Promise.all(
    codeBlocks.map(({ text, lang }) =>
      highlightLines(text, lang || 'plaintext').catch(() => null as string[] | null),
    ),
  );

  let codeIndex = 0;
  marked.use({
    renderer: {
      code(token: Tokens.Code): string {
        if (token.lang === 'mermaid') {
          return `<div class="mermaid-block" data-mermaid="${escapeAttr(token.text ?? '')}">${escapeHtml(token.text ?? '')}</div>`;
        }
        const lines = codeIndex < highlighted.length ? highlighted[codeIndex] : null;
        codeIndex++;
        const langAttr = token.lang ? ` data-lang="${escapeAttr(token.lang)}"` : '';
        const body = lines ? lines.join('\n') : escapeHtml(token.text ?? '');
        return `<pre class="shiki-block"${langAttr}><code>${body}</code></pre>`;
      },
    },
  });

  const blocks: DocumentBlock[] = [];
  let offset = 0;
  for (const token of tokens as Token[]) {
    const raw = token.raw ?? '';
    const startLine = countNewlines(source.slice(0, offset)) + 1;
    offset += raw.length;
    if (token.type === 'space' || !raw.trim()) continue;
    const endLine = startLine + countNewlines(raw.trimEnd());
    const html = DOMPurify.sanitize(marked.parser([token]), { ADD_ATTR: ['data-lang'] });
    const block: DocumentBlock = {
      index: blocks.length,
      type: token.type,
      startLine,
      endLine,
      raw,
      html,
    };
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading;
      block.headingLevel = heading.depth;
      block.headingText = heading.text.trim();
    }
    blocks.push(block);
  }
  return blocks;
}

/** Blocks from a heading through the end of its section (next heading of the same or a higher level). */
export function sectionRange(
  blocks: readonly DocumentBlock[],
  headingIndex: number,
): [number, number] {
  const heading = blocks[headingIndex];
  if (!heading || heading.headingLevel === undefined) return [headingIndex, headingIndex];
  let end = headingIndex;
  for (let i = headingIndex + 1; i < blocks.length; i++) {
    const level = blocks[i].headingLevel;
    if (level !== undefined && level <= heading.headingLevel) break;
    end = i;
  }
  return [headingIndex, end];
}

/** Nearest heading at or above a block, for labelling a selection. */
export function nearestHeading(
  blocks: readonly DocumentBlock[],
  index: number,
): string | undefined {
  for (let i = Math.min(index, blocks.length - 1); i >= 0; i--) {
    if (blocks[i].headingText) return blocks[i].headingText;
  }
  return undefined;
}

function blockKey(block: DocumentBlock): string {
  return block.raw.replace(/\s+/g, ' ').trim();
}

/**
 * Marks which blocks changed between a base and a candidate using a longest
 * common subsequence over block text. Unmatched base blocks that sit next
 * to unmatched candidate blocks count as `changed` rather than removed+added.
 */
export function diffBlocks(
  base: readonly DocumentBlock[],
  candidate: readonly DocumentBlock[],
): { base: BlockChange[]; candidate: BlockChange[] } {
  const a = base.map(blockKey);
  const b = candidate.map(blockKey);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const baseStatus: BlockChange[] = new Array(n).fill('removed');
  const candStatus: BlockChange[] = new Array(m).fill('added');
  let i = 0;
  let j = 0;
  // Walk the LCS; between matches, pair up the unmatched runs as "changed".
  const pairRuns = (bi: number, bj: number, ei: number, ej: number) => {
    const baseRun = ei - bi;
    const candRun = ej - bj;
    if (baseRun > 0 && candRun > 0) {
      for (let k = bj; k < ej; k++) candStatus[k] = 'changed';
      for (let k = bi; k < ei; k++) baseStatus[k] = 'changed';
    }
  };
  let runStartI = 0;
  let runStartJ = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairRuns(runStartI, runStartJ, i, j);
      baseStatus[i] = 'same';
      candStatus[j] = 'same';
      i++;
      j++;
      runStartI = i;
      runStartJ = j;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  pairRuns(runStartI, runStartJ, n, m);
  return { base: baseStatus, candidate: candStatus };
}

/** Plain text of a block range, suitable for quoting in a prompt. */
export function blockRangeText(blocks: readonly DocumentBlock[], from: number, to: number): string {
  return blocks
    .slice(from, to + 1)
    .map((b) => b.raw.replace(/\n+$/, ''))
    .join('\n\n');
}
