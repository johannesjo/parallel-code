import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

interface TerminalEntry {
  container: HTMLElement;
  fitAddon: FitAddon;
  term: Terminal;
  dirty: boolean;
}

const entries = new Map<string, TerminalEntry>();
let rafId: number | undefined;
let trailingTimer: number | undefined;
let lastFlushTime = 0;
const THROTTLE_MS = 150;

const resizeObserver = new ResizeObserver((resizeEntries) => {
  for (const re of resizeEntries) {
    for (const [, entry] of entries) {
      if (entry.container === re.target || entry.container.contains(re.target as Node)) {
        entry.dirty = true;
      }
    }
  }
  scheduleFlush();
});

const intersectionObserver = new IntersectionObserver((ioEntries) => {
  for (const ioe of ioEntries) {
    if (!ioe.isIntersecting) continue;
    for (const [, entry] of entries) {
      if (entry.container === ioe.target) {
        entry.dirty = true;
      }
    }
  }
  scheduleFlush();
});

function flush() {
  let didWork = false;
  for (const [, entry] of entries) {
    if (!entry.dirty) continue;
    entry.dirty = false;
    if (entry.container.offsetWidth <= 0 || entry.container.offsetHeight <= 0) continue;

    // xterm.js scroll position workaround (xtermjs/xterm.js#5096):
    // fit() → resize() → Viewport._sync() can reset scrollTop to 0 when
    // it encounters a transient dimension mismatch. Save the viewport
    // scroll position before fitting and restore it if clobbered.
    const buf = entry.term.buffer.active;
    const wasScrolledUp = buf.viewportY < buf.baseY;
    const savedViewportY = buf.viewportY;

    entry.fitAddon.fit();

    if (wasScrolledUp && buf.viewportY !== savedViewportY) {
      entry.term.scrollToLine(Math.min(savedViewportY, buf.baseY));
    }

    didWork = true;
  }
  // Only update throttle timestamp when we actually fitted something —
  // a no-op flush should not delay the next real fit.
  if (didWork) lastFlushTime = performance.now();
}

function scheduleFlush() {
  // Leading edge: fit immediately if enough time has passed since last fit
  if (performance.now() - lastFlushTime >= THROTTLE_MS) {
    if (rafId === undefined) {
      rafId = requestAnimationFrame(() => {
        rafId = undefined;
        flush();
      });
    }
  }

  // Trailing edge: always schedule a delayed fit so the final resize is captured
  if (trailingTimer !== undefined) clearTimeout(trailingTimer);
  trailingTimer = window.setTimeout(() => {
    trailingTimer = undefined;
    if (rafId !== undefined) return;
    rafId = requestAnimationFrame(() => {
      rafId = undefined;
      flush();
    });
  }, THROTTLE_MS);
}

export function registerTerminal(
  id: string,
  container: HTMLElement,
  fitAddon: FitAddon,
  term: Terminal,
): void {
  entries.set(id, { container, fitAddon, term, dirty: false });
  resizeObserver.observe(container);
  intersectionObserver.observe(container);
}

export function unregisterTerminal(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  resizeObserver.unobserve(entry.container);
  intersectionObserver.unobserve(entry.container);
  entries.delete(id);
}

export function markDirty(id: string): void {
  const entry = entries.get(id);
  if (entry) {
    entry.dirty = true;
    scheduleFlush();
  }
}

/**
 * Force a clean repaint of a terminal: discard the renderer's glyph texture
 * atlas, then mark every row dirty so the next frame re-rasterizes from a
 * fresh atlas. Recovers from xterm WebGL atlas corruption (issue #121) where
 * glyphs render from stale/wrong atlas cells — the buffer is intact, only the
 * GPU glyph cache is bad, so a plain refresh() would just redraw the same
 * garbage. clearTextureAtlas() is a safe no-op under the DOM renderer.
 */
function redraw(term: Terminal): void {
  try {
    term.clearTextureAtlas();
    term.refresh(0, term.rows - 1);
  } catch {
    // The terminal may be mid-dispose (e.g. a window-focus event racing
    // teardown). A best-effort cosmetic redraw must never crash the app.
  }
}

export function redrawTerminal(id: string): void {
  const entry = entries.get(id);
  if (entry) redraw(entry.term);
}

export function redrawAllTerminals(): void {
  for (const [, entry] of entries) redraw(entry.term);
}
