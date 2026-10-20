const TOKEN_KEY = 'parallel-code-token';
// Elevated token obtained by entering the desktop pairing PIN. Grants
// task-creation; kept separate from the read-only connection token.
const PAIRED_TOKEN_KEY = 'parallel-code-paired-token';

/** Extract token from URL query param and persist to localStorage. */
export function initAuth(): string | null {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');

  if (urlToken) {
    localStorage.setItem(TOKEN_KEY, urlToken);
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    return urlToken;
  }

  return getPairedToken() ?? localStorage.getItem(TOKEN_KEY);
}

/** Prefer the paired credential, which can survive rotation of the connection link. */
export function getToken(): string | null {
  return getPairedToken() ?? localStorage.getItem(TOKEN_KEY);
}

/** Clear stored token. */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** Get the stored paired (task-creation) token, if this device has paired. */
export function getPairedToken(): string | null {
  return localStorage.getItem(PAIRED_TOKEN_KEY) ?? sessionStorage.getItem(PAIRED_TOKEN_KEY);
}

/** Persist the paired token after a successful pairing. */
export function setPairedToken(token: string, remember: boolean): void {
  clearPairedToken();
  (remember ? localStorage : sessionStorage).setItem(PAIRED_TOKEN_KEY, token);
}

/** Clear the paired token (e.g. after access is revoked on the desktop). */
export function clearPairedToken(): void {
  localStorage.removeItem(PAIRED_TOKEN_KEY);
  sessionStorage.removeItem(PAIRED_TOKEN_KEY);
}

export type ConnectResult = 'stored' | 'navigating' | 'invalid';

/**
 * Apply a pasted connection string — a full URL with `?token=…` (as shown by the
 * desktop "Connect Phone" dialog). When the URL points at a different origin
 * (e.g. the desktop's IP/port changed), navigate there so the new origin owns
 * the token; otherwise store it for the current origin.
 */
export function applyConnectionString(input: string): ConnectResult {
  const trimmed = input.trim();
  if (!trimmed) return 'invalid';

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'invalid';
  }

  // The input is user-pasted, so reject non-http(s) schemes — javascript:/data:/
  // file: URLs parse and expose a token but would execute or navigate to
  // attacker-controlled content when assigned to location.href.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'invalid';

  const token = url.searchParams.get('token');
  if (!token) return 'invalid';

  if (url.origin === window.location.origin) {
    localStorage.setItem(TOKEN_KEY, token);
    return 'stored';
  }
  window.location.href = url.href;
  return 'navigating';
}
