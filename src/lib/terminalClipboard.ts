import type { IDisposable, IParser } from '@xterm/xterm';

/** ~750 KB of text; larger copies are dropped rather than parked in the clipboard. */
export const OSC52_MAX_BASE64_LENGTH = 1_000_000;
/** How long after the user's last click or key in a pane its program may still copy. */
const OSC52_GESTURE_WINDOW_MS = 2_000;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decode the text of an OSC 52 clipboard write (`52;<targets>;<base64>`; `data`
 * is what follows `52;`). Returns undefined for anything that is not a plain
 * write: clipboard queries (`?`), clear requests, oversized or malformed payloads.
 */
export function parseOsc52Write(data: string): string | undefined {
  const separator = data.indexOf(';');
  if (separator < 0) return undefined;
  const payload = data.slice(separator + 1);
  if (payload.length > OSC52_MAX_BASE64_LENGTH) return undefined;
  if (!BASE64.test(payload)) return undefined;
  // atob throws on padding that doesn't fill a 4-char group (`AB=`) and on a
  // 4n+1 length; an exception here would stall xterm's parser, so decode the
  // unpadded form and reject the one length no encoder produces.
  const digits = payload.replace(/=+$/, '');
  if (digits.length % 4 === 1) return undefined;
  const bytes = Uint8Array.from(atob(digits), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Copy what programs send with OSC 52 via `write`, while `allowed()` holds.
 * TUIs that capture the mouse (Claude Code's fullscreen mode) keep the selection
 * themselves and copy this way, so xterm has no selection for our own copy paths.
 * Never answers clipboard queries: a program in the terminal must not read the
 * user's clipboard.
 */
export function handleOsc52Writes(
  term: { parser: IParser },
  options: { allowed: () => boolean; write: (text: string) => void },
): IDisposable {
  return term.parser.registerOscHandler(52, (data) => {
    const text = parseOsc52Write(data);
    if (text && options.allowed()) options.write(text);
    // Handled either way, so no other handler answers a query.
    return true;
  });
}

/**
 * Track whether the user recently clicked or typed in `container`. A drag that
 * starts in the pane counts when it ends, even if released outside it.
 */
export function trackRecentGesture(container: HTMLElement): {
  isRecent: () => boolean;
  dispose: () => void;
} {
  let lastAt = Number.NEGATIVE_INFINITY;
  let pressedHere = false;
  const mark = () => {
    lastAt = performance.now();
  };
  const onMouseDown = () => {
    pressedHere = true;
    mark();
  };
  const onMouseUp = () => {
    if (!pressedHere) return;
    pressedHere = false;
    mark();
  };
  container.addEventListener('mousedown', onMouseDown, true);
  container.addEventListener('keydown', mark, true);
  window.addEventListener('mouseup', onMouseUp, true);
  return {
    isRecent: () => performance.now() - lastAt <= OSC52_GESTURE_WINDOW_MS,
    dispose: () => {
      container.removeEventListener('mousedown', onMouseDown, true);
      container.removeEventListener('keydown', mark, true);
      window.removeEventListener('mouseup', onMouseUp, true);
    },
  };
}
