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

function scheduleFlush() {
  if (rafId !== undefined) return;
  rafId = requestAnimationFrame(() => {
    rafId = undefined;
    for (const [, entry] of entries) {
      if (!entry.dirty) continue;
      entry.dirty = false;
      entry.fitAddon.fit();
    }
  });
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
