import type { FitAddon } from '@xterm/addon-fit';

interface TerminalEntry {
  container: HTMLElement;
  fitAddon: FitAddon;
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

    entry.fitAddon.fit();

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

export function registerTerminal(id: string, container: HTMLElement, fitAddon: FitAddon): void {
  entries.set(id, { container, fitAddon, dirty: false });
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
