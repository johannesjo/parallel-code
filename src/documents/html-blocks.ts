/**
 * A whole HTML page as element blocks. The innermost block-level elements of
 * <body> (a paragraph, a heading, a list, a table; not the <main> or <div>
 * around them) are the unit of selection and change marking, the way
 * markdown's top-level tokens are, and each carries its source line range so
 * scope, quotes and anchors work unchanged. The page's markup is kept whole,
 * with the blocks marked in place, so its own layout and stylesheet still
 * apply when it is shown inline.
 */
import DOMPurify from 'dompurify';
import { SANITIZE_UNTRUSTED } from '../lib/sanitize';
import {
  defaultTreeAdapter,
  html as htmlSpec,
  parse,
  serialize,
  serializeOuter,
  type DefaultTreeAdapterMap,
} from 'parse5';
import type { DocumentBlock } from './markdown-blocks';

type Node = DefaultTreeAdapterMap['node'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type Element = DefaultTreeAdapterMap['element'];
type TextNode = DefaultTreeAdapterMap['textNode'];

export interface HtmlDocumentRender {
  blocks: DocumentBlock[];
  /** The page's <style> contents in document order; the viewer scopes them. */
  stylesheet: string;
  /**
   * The body's sanitized markup with every block carrying `data-block-index`
   * and the `doc-block` class, for rendering the page as one piece.
   */
  html: string;
}

const HEADING_RE = /^h([1-6])$/;
/** Page machinery rather than content: never a block of its own. */
const SKIPPED_TAGS = new Set(['script', 'style', 'template', 'noscript', 'link', 'meta', 'title']);
/** Elements that group blocks; one of these holding block children is structure, not a block. */
const WRAPPER_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'center',
  'details',
  'dialog',
  'div',
  'fieldset',
  'footer',
  'form',
  'header',
  'hgroup',
  'main',
  'nav',
  'section',
]);
/** Elements that make their parent a wrapper rather than a block of inline content. */
const BLOCK_TAGS = new Set([
  ...WRAPPER_TAGS,
  'canvas',
  'dl',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'ol',
  'p',
  'picture',
  'pre',
  'svg',
  'table',
  'ul',
  'video',
]);

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function isText(node: Node): node is TextNode {
  return node.nodeName === '#text';
}

function childNodes(node: Node): Node[] {
  return 'childNodes' in node ? (node as ParentNode).childNodes : [];
}

function findChild(node: Node, tagName: string): Element | undefined {
  return childNodes(node).find((c): c is Element => isElement(c) && c.tagName === tagName);
}

function textOf(node: Node): string {
  if (isText(node)) return node.value;
  return childNodes(node).map(textOf).join('');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Source lines of a node, trimmed of the surrounding whitespace parse5 keeps. */
function sourceLines(
  node: Node,
  source: string,
  fallbackLine: number,
): Pick<DocumentBlock, 'startLine' | 'endLine' | 'raw' | 'startOffset' | 'endOffset'> {
  const loc = node.sourceCodeLocation;
  if (!loc) return { startLine: fallbackLine, endLine: fallbackLine, raw: '' };
  const full = source.slice(loc.startOffset, loc.endOffset);
  const raw = full.trim();
  const startLine =
    loc.startLine + countNewlines(full.slice(0, full.length - full.trimStart().length));
  const startOffset = loc.startOffset + full.length - full.trimStart().length;
  return {
    startLine,
    endLine: startLine + countNewlines(raw),
    raw,
    startOffset,
    endOffset: startOffset + raw.length,
  };
}

function blockFor(
  node: Node,
  source: string,
  index: number,
  fallbackLine: number,
): DocumentBlock | null {
  if (isElement(node)) {
    if (SKIPPED_TAGS.has(node.tagName)) return null;
    const block: DocumentBlock = {
      index,
      type: node.tagName,
      ...sourceLines(node, source, fallbackLine),
      html: DOMPurify.sanitize(serializeOuter(node), SANITIZE_UNTRUSTED),
    };
    const heading = HEADING_RE.exec(node.tagName);
    if (heading) {
      block.headingLevel = Number(heading[1]);
      block.headingText = textOf(node).trim();
    }
    return block;
  }
  if (isText(node) && node.value.trim()) {
    return {
      index,
      type: 'text',
      ...sourceLines(node, source, fallbackLine),
      html: escapeHtml(node.value.trim()),
    };
  }
  return null;
}

/** A wrapper is structure to look through; anything else is a block. */
function isWrapper(node: Element): boolean {
  return (
    WRAPPER_TAGS.has(node.tagName) &&
    node.childNodes.some((c) => isElement(c) && BLOCK_TAGS.has(c.tagName))
  );
}

/**
 * The innermost block-level nodes under `parent`, in document order. Page
 * machinery met on the way is detached so it never reaches the rendered
 * markup; its styles were collected before.
 */
function collectLeaves(parent: Node, out: Node[]): void {
  for (const child of [...childNodes(parent)]) {
    if (isElement(child) && SKIPPED_TAGS.has(child.tagName)) defaultTreeAdapter.detachNode(child);
    else if (isElement(child) && isWrapper(child)) collectLeaves(child, out);
    else out.push(child);
  }
}

/** Marks a block in the tree so the rendered page carries its index. */
function markBlock(node: Node, index: number): void {
  const attrs = [
    { name: 'data-block-index', value: String(index) },
    { name: 'class', value: 'doc-block' },
  ];
  if (isElement(node)) {
    const cls = node.attrs.find((a) => a.name === 'class');
    if (cls) cls.value = `${cls.value} doc-block`;
    node.attrs.push(...attrs.filter((a) => a.name !== 'class' || !cls));
    return;
  }
  // Bare text has nowhere to hang an attribute; a span changes nothing inline.
  if (!isText(node) || !node.parentNode) return;
  const span = defaultTreeAdapter.createElement('span', htmlSpec.NS.HTML, attrs);
  defaultTreeAdapter.insertBefore(node.parentNode, span, node);
  defaultTreeAdapter.detachNode(node);
  defaultTreeAdapter.appendChild(span, node);
}

function collectStyles(node: Node, out: string[]): void {
  if (isElement(node) && node.tagName === 'template') return;
  if (isElement(node) && node.tagName === 'style') {
    out.push(textOf(node).trim());
    return;
  }
  for (const child of childNodes(node)) collectStyles(child, out);
}

/**
 * Splits a page into blocks, one per innermost block-level element (or run of
 * bare text), each sanitized like a markdown block, and returns the body's
 * markup with the blocks marked in place. Scripts never reach the DOM; <link>
 * stylesheets are not followed.
 */
export function renderHtmlBlocks(source: string): HtmlDocumentRender {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const styles: string[] = [];
  collectStyles(document, styles);
  const html = findChild(document, 'html');
  const body = html && findChild(html, 'body');
  const leaves: Node[] = [];
  if (body) collectLeaves(body, leaves);
  const blocks: DocumentBlock[] = [];
  let line = 1;
  for (const node of leaves) {
    const block = blockFor(node, source, blocks.length, line);
    if (!block) continue;
    line = block.endLine;
    blocks.push(block);
    markBlock(node, block.index);
  }
  return {
    blocks,
    stylesheet: styles.filter(Boolean).join('\n'),
    // A <style> nested inside a block would escape the scoped stylesheet.
    html: body ? DOMPurify.sanitize(serialize(body), SANITIZE_UNTRUSTED) : '',
  };
}

/** At-rules that are global by name and so cannot sit inside @scope. */
const GLOBAL_AT_RULES = ['@font-face', '@keyframes', '@-webkit-keyframes'];
/**
 * `html`, `:root` and `body` where a selector can start or continue. `:root`
 * belongs here with the rest: a page keeps its custom properties there, and
 * dropped they take every colour and size defined with them along.
 */
const ROOT_SELECTOR_RE = /(^|[\s,>+~{};])(?::root|html|body)(?=[\s,>+~{.#[:]|$)/g;

/** Index just past the `}` closing the block that starts at `from`. */
function blockEnd(css: string, from: number): number {
  let depth = 0;
  for (let i = from; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return i + 1;
  }
  return css.length;
}

/**
 * Lifts the at-rules that cannot sit inside `@scope` out of the sheet, and
 * balances what is left. Balancing is the point: a page's `}` with nothing
 * open would close the `@scope` wrapper this is about to go inside, and every
 * rule after it would apply to the whole app. Unmatched closers are dropped
 * and unclosed blocks are closed here instead.
 */
function splitGlobalAtRules(css: string): { hoisted: string; rest: string } {
  const hoisted: string[] = [];
  const kept: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < css.length; ) {
    const rule = depth === 0 ? GLOBAL_AT_RULES.find((r) => css.startsWith(r, i)) : undefined;
    if (rule) {
      const end = blockEnd(css, i);
      kept.push(css.slice(from, i));
      hoisted.push(css.slice(i, end));
      i = end;
      from = end;
      continue;
    }
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      if (depth === 0) {
        kept.push(css.slice(from, i));
        from = i + 1;
      } else depth--;
    }
    i++;
  }
  kept.push(css.slice(from));
  return { hoisted: hoisted.join('\n'), rest: kept.join('') + '}'.repeat(depth) };
}

/**
 * The app's own elements inside a page (markers, bubbles, § buttons, the block
 * toolbar) stay out of its CSS.
 */
export const PAGE_SCOPE_LIMIT = '.docws-marker-anchor, .docws-section-btn, .docws-block-actions';
/**
 * The app resets every element's margin, padding, box model and scrollbars; a
 * page starts from the browser's defaults instead. The scope root stands in
 * for the page's <body>, so it is reverted with the rest. Zero specificity
 * keeps this below any rule the page has, and it comes first so even the
 * page's own `*` rules win. The scrollbars take `initial` rather than
 * `revert`: their colour is inherited, so reverting it would only pick the
 * app's own up again from the ancestor.
 */
const BROWSER_DEFAULTS =
  ':where(:scope, :scope *) { margin: revert; padding: revert; box-sizing: revert; scrollbar-width: initial; scrollbar-color: initial; }';

/** A selector that is nothing but `*`, optionally with pseudos: `*`, `*::before`, `*:not(pre)`. */
const UNIVERSAL_SELECTOR_RE = /^\s*\*(?:::?[\w-]+(?:\([^()]*\))?)*\s*$/;
/** A rule's selector list: what stands between the end of the last block and its `{`. */
const SELECTOR_LIST_RE = /(^|[{};])([^{};@]*)(?=\{)/g;

/**
 * `*` matches everything in the scope but never the scope root itself, so a
 * page's own reset (`* { margin: 0 }`) would skip the element standing in for
 * its <body> and leave the browser's body margin on it. Every universal
 * selector gets a `:scope` twin, which does match the root.
 */
function widenUniversalSelectors(css: string): string {
  return css.replace(SELECTOR_LIST_RE, (match, lead: string, selectors: string) => {
    const twins = selectors
      .split(',')
      .filter((s) => UNIVERSAL_SELECTOR_RE.test(s))
      .map((s) => s.trim().replace('*', ':scope'));
    return twins.length > 0 ? `${lead}${selectors.trimEnd()}, ${twins.join(', ')} ` : match;
  });
}

/** The root font size every `rem` in the sheet is measured against. */
const DEFAULT_ROOT_PX = 16;
/** A root rule's declarations: only `html`/`:root` move what `rem` means. */
const ROOT_RULE_RE = /(?:^|[};])\s*(?::root|html)\s*\{([^{}]*)\}/g;
const ROOT_FONT_SIZE_RE = /(?:^|;)\s*font-size\s*:\s*(\d*\.?\d+)(px|%)/gi;
const REM_LENGTH_RE = /(-?\d*\.?\d+)rem\b/g;

/** The page's root font size in px, from its last `html`/`:root` declaration. */
function rootFontSizePx(css: string): number {
  let px = DEFAULT_ROOT_PX;
  for (const [, declarations] of css.matchAll(ROOT_RULE_RE))
    for (const [, size, unit] of declarations.matchAll(ROOT_FONT_SIZE_RE))
      px = unit === '%' ? (Number(size) / 100) * DEFAULT_ROOT_PX : Number(size);
  return px;
}

/**
 * A page's `rem` is measured against the app's root element, not the page's,
 * so a page that moves its root size (`:root { font-size: 62.5% }`, to make
 * `1.6rem` mean 16px) renders every rem-sized thing at the app's scale
 * instead. Those lengths are resolved here, against the size the page set.
 *
 * shortcut: pages that leave the root size alone are untouched, since the
 * app's root is the browser default the page would have had. Root sizes in
 * `em` are left alone too, rather than resolved by hand.
 */
function resolveRemLengths(css: string): string {
  const rootPx = rootFontSizePx(css);
  if (rootPx === DEFAULT_ROOT_PX) return css;
  return css.replace(REM_LENGTH_RE, (_m, length: string) => `${Number(length) * rootPx}px`);
}

/**
 * Confines a page's stylesheet to one viewer. `@scope` keeps every selector
 * inside the scope root and out of the app's elements placed within it;
 * `html`, `:root` and `body` rules are pointed at the root so page-level
 * fonts, colours, custom properties and widths still apply. `@import` is
 * dropped so a document cannot pull a whole sheet in; a hoisted `@font-face`
 * can still fetch its `src`, which wants a Content-Security-Policy rather
 * than more parsing here.
 *
 * shortcut: the rewrites are regexes, not a CSS parser, so the words inside
 * strings or attribute values would be rewritten too.
 */
export function scopePageCss(css: string, scope: string): string {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import\b[^;]*;/g, '');
  const { hoisted, rest } = splitGlobalAtRules(resolveRemLengths(cleaned));
  const scoped = widenUniversalSelectors(rest).replace(ROOT_SELECTOR_RE, '$1:scope');
  return `${hoisted}\n@scope (${scope}) to (${PAGE_SCOPE_LIMIT}) {\n${BROWSER_DEFAULTS}\n${scoped}\n}`;
}
