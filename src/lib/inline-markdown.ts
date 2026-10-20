import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { SANITIZE_UNTRUSTED } from './sanitize';

const marked = new Marked();

/**
 * One line of untrusted Markdown, such as a slide's bullet point, as sanitized
 * inline HTML: code spans, emphasis and links, never a block of its own.
 */
export function renderInlineMarkdown(text: string): string {
  const html = marked.parseInline(text, { async: false });
  // Wrapped, so the text before the first tag survives every DOM parser
  // DOMPurify may run on; happy-dom drops it otherwise.
  return DOMPurify.sanitize(`<span>${html}</span>`, SANITIZE_UNTRUSTED);
}
