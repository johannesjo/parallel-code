import DOMPurify from 'dompurify';
import { Marked, type Tokens } from 'marked';
import { createSignal, createEffect } from 'solid-js';
import { highlightLines } from './shiki-highlighter';

/**
 * Render markdown to HTML with Shiki syntax highlighting for fenced code blocks.
 *
 * Two-pass approach:
 *  1. Walk tokens to collect code blocks, highlight them in parallel via Shiki.
 *  2. Render markdown, substituting highlighted HTML for each code block.
 */
export async function renderMarkdownWithHighlighting(markdown: string): Promise<string> {
  const marked = new Marked();

  // First pass — collect code blocks
  const codeBlocks: { lang: string; text: string }[] = [];
  const tokens = marked.lexer(markdown);
  collectCodeTokens(tokens, codeBlocks);

  // Highlight all blocks in parallel
  const highlighted = await Promise.all(
    codeBlocks.map(({ text, lang }) => highlightLines(text, lang || 'plaintext')),
  );

  // Second pass — render with a custom renderer that swaps in highlighted HTML
  let blockIndex = 0;
  const renderer = {
    code(token: Tokens.Code): string {
      // Mermaid blocks → render as placeholder for client-side rendering
      if (token.lang === 'mermaid') {
        return `<div class="mermaid-block" data-mermaid="${escapeAttr(token.text ?? '')}">${escapeHtml(token.text ?? '')}</div>`;
      }
      const idx = blockIndex++;
      const lines = idx < highlighted.length ? highlighted[idx] : null;
      const langAttr = token.lang ? ` data-lang="${escapeAttr(token.lang)}"` : '';
      if (lines) {
        return `<pre class="shiki-block"${langAttr}><code>${lines.join('\n')}</code></pre>`;
      }
      // Fallback for unmatched blocks
      return `<pre class="shiki-block"${langAttr}><code>${escapeHtml(token.text ?? '')}</code></pre>`;
    },
  };

  marked.use({ renderer });
  const raw = marked.parser(tokens);
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['data-lang'] });
}

interface TokenLike {
  type: string;
  lang?: string;
  text?: string;
  tokens?: TokenLike[];
  items?: { tokens?: TokenLike[] }[];
}

/** Recursively collect code-fence tokens from a token tree (including list items). */
function collectCodeTokens(
  tokens: readonly TokenLike[],
  out: { lang: string; text: string }[],
): void {
  for (const token of tokens) {
    if (token.type === 'code' && token.lang !== 'mermaid') {
      out.push({ lang: (token.lang as string) ?? '', text: (token.text as string) ?? '' });
    }
    if (Array.isArray(token.tokens)) {
      collectCodeTokens(token.tokens, out);
    }
    // List tokens store children under .items[].tokens
    if (Array.isArray(token.items)) {
      for (const item of token.items) {
        if (Array.isArray(item.tokens)) {
          collectCodeTokens(item.tokens, out);
        }
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

/**
 * SolidJS primitive that reactively renders markdown with Shiki syntax highlighting.
 * Returns a signal accessor for the rendered HTML string.
 * Falls back to plain marked rendering on highlighting failure.
 */
export function createHighlightedMarkdown(source: () => string | undefined): () => string {
  const [html, setHtml] = createSignal('');
  let generation = 0;

  createEffect(() => {
    const content = source();
    if (!content) {
      setHtml('');
      return;
    }
    const thisGen = ++generation;
    renderMarkdownWithHighlighting(content)
      .then((result) => {
        if (thisGen === generation) setHtml(result);
      })
      .catch(() => {
        if (thisGen === generation) {
          setHtml(
            DOMPurify.sanitize(new Marked().parse(content, { async: false }) as string, {
              ADD_ATTR: ['data-lang'],
            }),
          );
        }
      });
  });

  return html;
}
