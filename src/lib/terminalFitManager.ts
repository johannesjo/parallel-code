import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

interface TerminalEntry {
  container: HTMLElement;
  fitAddon: FitAddon;
  term: Terminal;
  dirty: boolean;
  /** Last IntersectionObserver verdict; off-screen panes defer their fit. */
  visible: boolean;
  /**
   * Fit in full on the next frame rather than waiting for a resize to settle:
   * the pane just came into view, or a caller asked for a one-off refit (font
   * change, task switch) that has no drag in progress to wait out.
   */
  fitInFull: boolean;
}

const entries = new Map<string, TerminalEntry>();
let rafId: number | undefined;
let trailingTimer: number | undefined;
let settleRequested = false;
let lastFlushTime = 0;
const THROTTLE_MS = 150;
// Changing columns reflows every scrollback line; below this many lines that
// is cheap enough to do on every throttled frame (VS Code uses the same cutoff).
const REFLOW_DEBOUNCE_MIN_LINES = 200;

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
    for (const [, entry] of entries) {
      if (entry.container !== ioe.target) continue;
      entry.visible = ioe.isIntersecting;
      if (ioe.isIntersecting) {
        entry.dirty = true;
        entry.fitInFull = true;
      }
    }
  }
  scheduleFlush();
});

/** Run a resize without losing the user's place in scrollback. */
function resizePreservingScroll(term: Terminal, resize: () => void): void {
  // Resizing rows moves the buffer's viewport before xterm synchronizes
  // its scrollbar. scrollToLine applies a relative delta to that scrollbar,
  // so restoring synchronously can overshoot all the way to line zero.
  const buf = term.buffer.active;
  const wasScrolledUp = buf.viewportY < buf.baseY;
  const savedViewportY = buf.viewportY;

  resize();

  if (wasScrolledUp && buf.viewportY !== savedViewportY) {
    const target = Math.min(savedViewportY, buf.baseY);
    term.scrollToLine(target);
    // The first call reconciles the buffer and scrollbar, but can land at
    // the wrong line. Correct that offset before the browser paints.
    if (buf.viewportY !== target) term.scrollToLine(target);
  }
}

/**
 * While a resize is still in motion, apply only the row change to terminals
 * with long scrollback and leave the column change (a full reflow) for the
 * settled fit. Returns true when the column change was deferred.
 */
function deferColumnReflow(entry: TerminalEntry): boolean {
  const { term } = entry;
  if (term.buffer.normal.length <= REFLOW_DEBOUNCE_MIN_LINES) return false;
  const dims = entry.fitAddon.proposeDimensions();
  if (!dims || dims.cols === term.cols) return false;
  if (dims.rows !== term.rows) {
    resizePreservingScroll(term, () => term.resize(term.cols, dims.rows));
  }
  return true;
}

function flush(settled: boolean) {
  let didWork = false;
  for (const [, entry] of entries) {
    // Off-screen panes stay dirty and fit when they come back into view.
    if (!entry.dirty || !entry.visible) continue;
    didWork = true;
    if (!settled && !entry.fitInFull && deferColumnReflow(entry)) continue;
    entry.dirty = false;
    entry.fitInFull = false;
    resizePreservingScroll(entry.term, () => entry.fitAddon.fit());
  }
  // Only update throttle timestamp when we actually fitted something —
  // a no-op flush should not delay the next real fit.
  if (didWork) lastFlushTime = performance.now();
}

function requestFlushFrame(settled: boolean) {
  // A trailing request upgrades an already-pending leading frame.
  if (settled) settleRequested = true;
  if (rafId !== undefined) return;
  rafId = requestAnimationFrame(() => {
    rafId = undefined;
    const settledNow = settleRequested;
    settleRequested = false;
    flush(settledNow);
  });
}

function scheduleFlush() {
  // Leading edge: fit immediately if enough time has passed since last fit
  if (performance.now() - lastFlushTime >= THROTTLE_MS) requestFlushFrame(false);

  // Trailing edge: once resizing has been quiet for THROTTLE_MS, fit in full
  // so the final size (including any deferred column change) is applied.
  if (trailingTimer !== undefined) clearTimeout(trailingTimer);
  trailingTimer = window.setTimeout(() => {
    trailingTimer = undefined;
    requestFlushFrame(true);
  }, THROTTLE_MS);
}

export function registerTerminal(
  id: string,
  container: HTMLElement,
  fitAddon: FitAddon,
  term: Terminal,
): void {
  entries.set(id, {
    container,
    fitAddon,
    term,
    dirty: false,
    visible: true,
    fitInFull: false,
  });
  resizeObserver.observe(container);
  intersectionObserver.observe(container);
}

export function unregisterTerminal(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  resizeObserver.unobserve(entry.container);
  intersectionObserver.unobserve(entry.container);
  entries.delete(id);
  if (entries.size === 0) cancelPendingFlush();
}

// With no terminals left a flush is a no-op; a dangling timer would otherwise
// fire after teardown (e.g. when a test environment has removed rAF).
function cancelPendingFlush(): void {
  if (trailingTimer !== undefined) clearTimeout(trailingTimer);
  if (rafId !== undefined) cancelAnimationFrame(rafId);
  trailingTimer = undefined;
  rafId = undefined;
  settleRequested = false;
}

export function markDirty(id: string): void {
  const entry = entries.get(id);
  if (entry) {
    entry.dirty = true;
    entry.fitInFull = true;
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

/**
 * Repaint every terminal. There is deliberately no single-terminal variant:
 * xterm shares one glyph atlas between all WebGL terminals with the same font
 * and theme, and clearing it only resets the calling terminal's render model.
 * The others keep pointing at atlas cells that are then refilled with other
 * glyphs, which garbles them (issue #121). The repaints are deferred to the
 * next frame, so every model is cleared before any glyph is drawn again.
 *
 * Requests made in the same tick share one repaint: every pane of a task that
 * returns on screen asks at once.
 */
let redrawQueued = false;
export function redrawAllTerminals(): void {
  if (redrawQueued) return;
  redrawQueued = true;
  queueMicrotask(() => {
    redrawQueued = false;
    for (const [, entry] of entries) redraw(entry.term);
  });
}
