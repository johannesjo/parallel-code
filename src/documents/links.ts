/**
 * What a link in a rendered document points at. Links are the seam between
 * documents in one project, so a relative target opens inside the workspace
 * instead of navigating the app window, and web links open in the browser.
 */
export type DocumentLink =
  | { kind: 'external'; url: string }
  | { kind: 'anchor'; id: string }
  | { kind: 'file'; path: string; anchor?: string };

const EXTERNAL_RE = /^(?:https?:|mailto:|tel:)/i;

/** Repo-relative path of `target` resolved from the document at `fromPath`. */
function resolveRelative(fromPath: string, target: string): string | null {
  const base = fromPath.split('/').slice(0, -1);
  const parts = target.startsWith('/') ? [] : base;
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

/**
 * Classifies an `href` found in the document at `fromPath`. Returns null for
 * links the workspace cannot follow (other schemes, paths that climb out of
 * the project), which the viewer then ignores.
 */
export function resolveDocumentLink(href: string, fromPath: string): DocumentLink | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (EXTERNAL_RE.test(trimmed)) return { kind: 'external', url: trimmed };
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  if (trimmed.startsWith('#')) {
    const id = decodeURIComponent(trimmed.slice(1));
    return id ? { kind: 'anchor', id } : null;
  }
  const hashAt = trimmed.indexOf('#');
  const pathPart = hashAt >= 0 ? trimmed.slice(0, hashAt) : trimmed;
  const anchor = hashAt >= 0 ? decodeURIComponent(trimmed.slice(hashAt + 1)) : undefined;
  const path = resolveRelative(fromPath, decodeURIComponent(pathPart.split('?')[0]));
  if (!path) return null;
  return anchor ? { kind: 'file', path, anchor } : { kind: 'file', path };
}

/** GitHub-style slug of a heading, what `#anchors` in Markdown point at. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

/**
 * The element `anchor` names inside a rendered document: an element with
 * that id, or a heading whose slug matches.
 */
export function findAnchorTarget(container: ParentNode, anchor: string): HTMLElement | null {
  const byId = container.querySelector<HTMLElement>(`[id="${CSS.escape(anchor)}"]`);
  if (byId) return byId;
  const wanted = anchor.toLowerCase();
  for (const heading of container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
    if (headingSlug(heading.textContent ?? '') === wanted) return heading;
  }
  return null;
}
