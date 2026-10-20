import DOMPurify from 'dompurify';
import { Marked, type RendererObject, type Tokens } from 'marked';
import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { renderMarkdownWithHighlighting } from '../../lib/marked-shiki';
import { tableScrollRenderer } from '../../lib/marked-table';
import { SANITIZE_UNTRUSTED } from '../../lib/sanitize';
import { warn, errMessage } from '../../lib/log';

/** Where a link to a worktree file points; the chat view routes these to the editor. */
export const FILE_LINK_PREFIX = '#parallel-code-file=';

/** A path the agent cited, not a web address. `README.md:12` looks like a URL
 *  scheme, so a bare file-and-location is accepted before the scheme test. */
function isLocalPath(url: string): boolean {
  return (
    !!url &&
    !url.startsWith('#') &&
    !url.startsWith('//') &&
    (!/^[a-z][a-z0-9+.-]*:/i.test(url) || /^[^/:]+\.[^/:]+:\d+(?::\d+)?$/.test(url))
  );
}

const SAFE_LINK = /^(?:https?:|mailto:|#)/i;

const BREAK = /^<br\s*\/?>$/i;

const chatRenderer: RendererObject = {
  // Agent text is untrusted, and the sanitizer keeps `style`, `id` and `data-*`,
  // enough to lay a fake control over the app. Raw HTML shows as the text it is;
  // only a line break, common in tables, still breaks the line.
  html(token: Tokens.HTML | Tokens.Tag) {
    const text = token.text.trim();
    if (BREAK.test(text)) return '<br>';
    return 'block' in token && token.block
      ? `<p>${escapeHtml(text)}</p>\n`
      : escapeHtml(token.text);
  },
  link(token: Tokens.Link) {
    // Web, mail and in-page links keep marked's own rendering. Any other scheme
    // is shown as its text: no link beats trusting the sanitizer with `javascript:`.
    if (!isLocalPath(token.href))
      return SAFE_LINK.test(token.href) ? false : this.parser.parseInline(token.tokens);
    const title = token.title ? ` title="${escapeAttr(token.title)}"` : '';
    const href = `${FILE_LINK_PREFIX}${encodeURIComponent(token.href)}`;
    return `<a href="${escapeAttr(href)}"${title}>${this.parser.parseInline(token.tokens)}</a>`;
  },
  image(token: Tokens.Image) {
    // An image loads as soon as it renders, so a remote one would send whatever its
    // URL carries without a click. A web image shows as a link to it instead, any
    // other scheme as its alt text; only inline data, which fetches nothing, stays.
    if (/^data:/i.test(token.href)) return false;
    const alt = this.parser.parseInline(token.tokens, this.parser.textRenderer);
    // Marked escapes markup while preserving entities already present in the alt text.
    const label = this.text({ type: 'text', raw: alt, text: alt });
    const href = /^https?:/i.test(token.href) ? webHref(token.href) : null;
    if (href === null) return label;
    const title = token.title ? ` title="${escapeAttr(token.title)}"` : '';
    return `<a href="${escapeAttr(href)}"${title}>${label || escapeHtml(token.href)}</a>`;
  },
};

/** The href marked itself writes for a link, or null where marked writes no link. */
function webHref(href: string): string | null {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (error) {
    // A lone surrogate cannot be encoded; marked shows such a link as its text.
    if (error instanceof URIError) return null;
    throw error;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

const CODE_FENCE = /^ {0,3}(```|~~~)/m;

const plain = new Marked({ renderer: { ...chatRenderer, ...tableScrollRenderer } });

/** Synchronous and unhighlighted: cheap enough to run on every streamed frame. */
export function renderChatMarkdown(markdown: string): string {
  return DOMPurify.sanitize(plain.parse(markdown, { async: false }), SANITIZE_UNTRUSTED);
}

/** Streamed text changes every animation frame; re-parsing a long message that
 *  often costs more than the reader can see, so streaming renders are spaced out. */
const STREAM_RENDER_MS = 60;

/**
 * Chat message HTML. While the text streams it is re-parsed plainly, at most every
 * STREAM_RENDER_MS; once it settles, Shiki highlights its code blocks. The plain
 * result stays on screen until the highlighted one is ready, so nothing flashes.
 */
export function createChatMarkdown(text: () => string, streaming: () => boolean): () => string {
  const [html, setHtml] = createSignal(untrack(() => renderChatMarkdown(text())));
  let rendered = untrack(text);
  let renderedAt = -Infinity;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const renderPlain = (source: string) => {
    rendered = source;
    renderedAt = performance.now();
    setHtml(renderChatMarkdown(source));
  };
  createEffect(() => {
    const source = text();
    const thisGeneration = ++generation;
    clearTimeout(timer);
    // Replacing the HTML drops the reader's selection, so only do it for new text
    // or for colour.
    const fresh = source !== rendered;
    if (streaming()) {
      const wait = STREAM_RENDER_MS - (performance.now() - renderedAt);
      if (fresh && wait <= 0) renderPlain(source);
      else if (fresh) timer = setTimeout(() => renderPlain(source), wait);
      return;
    }
    if (fresh) renderPlain(source);
    if (!CODE_FENCE.test(source)) return;
    renderMarkdownWithHighlighting(source, chatRenderer)
      .then((result) => {
        if (thisGeneration === generation) setHtml(result);
      })
      .catch((error: unknown) => {
        // The plain rendering is already showing; only the colours are missing.
        warn('chat', 'Code highlighting failed', { error: errMessage(error) });
      });
  });
  return html;
}
