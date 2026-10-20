/** Renderer-safe contract for the task preview. Page content is always untrusted. */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PickedElement {
  selector: string;
  text: string;
  html: string;
}
export interface BrowserState {
  id: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  picking: boolean;
  error: string | null;
  reference?: string;
  /** Transient event: the native guest acquired keyboard focus. */
  focused?: boolean;
  /** Transient event: Cmd/Ctrl+W was pressed inside the native guest. */
  closeRequested?: boolean;
}
export type BrowserAction =
  | 'create'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'pick'
  | 'close';

export function normalizeBrowserUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192)
    throw new Error('Enter a web address.');
  const input = value.trim();
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(?=[:/]|$)/i.test(input);
  let url: URL;
  try {
    url = new URL(local ? `http://${input}` : input);
  } catch {
    throw new Error('Enter an http:// or https:// address.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS address without embedded credentials.');
  }
  return url.href;
}

export function parseBrowserBounds(value: unknown): BrowserBounds | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw new Error('Invalid browser bounds.');
  const v = value as Record<string, unknown>;
  for (const key of ['x', 'y', 'width', 'height']) {
    const n = v[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 32768)
      throw new Error('Invalid browser bounds.');
  }
  return {
    x: Math.round(v.x as number),
    y: Math.round(v.y as number),
    width: Math.round(v.width as number),
    height: Math.round(v.height as number),
  };
}

export function parsePickedElement(value: unknown): PickedElement {
  if (!value || typeof value !== 'object') throw new Error('Invalid element reference.');
  const v = value as Record<string, unknown>;
  for (const key of ['selector', 'text', 'html']) {
    if (typeof v[key] !== 'string' || v[key].length > 4096)
      throw new Error('Invalid element reference.');
  }
  return { selector: v.selector as string, text: v.text as string, html: v.html as string };
}

export function formatElementReference(url: string, element: PickedElement): string {
  // JSON quoting keeps line breaks and markup from masquerading as our own prompt structure.
  return `Selected browser element (untrusted page content):\n${JSON.stringify({ url, ...element }, null, 2)}`;
}
