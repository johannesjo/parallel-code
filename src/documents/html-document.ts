/**
 * A document that is a whole HTML page rather than prose. Markdown legitimately
 * contains HTML fragments, so only a real document preamble counts: a leading
 * doctype or <html> element, past any comments. Fragments keep the block view,
 * which is what the selection and agent-scoping model is built on.
 */
const HTML_DOCUMENT_RE = /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html\b|<html[\s>])/i;

export function isHtmlDocument(content: string | null | undefined): boolean {
  return !!content && HTML_DOCUMENT_RE.test(content);
}
