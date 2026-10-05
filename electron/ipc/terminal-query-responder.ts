import headless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';

const { Terminal } = headless;
const { SerializeAddon } = serializeAddon;

/**
 * Lines kept above the viewport. Phones are sent this history when they open a
 * terminal, so it matches the desktop renderer's scrollback (10k, see
 * TERMINAL_SCROLL_OPTIONS) — any less and a phone shows a truncated history.
 * Lines are allocated as output arrives, so a short session costs little.
 */
const SCROLLBACK_LINES = 10_000;

// A cursor position report: CSI row;col R, or the DEC form CSI ? row;col R.
// eslint-disable-next-line no-control-regex
const CURSOR_POSITION_REPORT = /^\x1b\[\??\d+;\d+R$/;

/** Answers a PTY's cursor-position queries from the main process. */
export interface TerminalQueryResponder {
  /** Parse process output; a cursor-position query in it is answered through `reply`. */
  feed(data: string): void;
  /**
   * Parse text the pane shows that the process did not write (a banner, replayed
   * scrollback), so the cursor stays where the renderer has it. Queries in it
   * are stale and get no answer.
   */
  feedDisplayOnly(data: string): void;
  /** Current visible screen and input mode; null until queued output has been parsed. */
  snapshot(): { text: string; bracketedPaste: boolean } | null;
  /**
   * The screen and history as ANSI text that redraws them, once everything fed
   * so far is parsed. Null once disposed.
   */
  serialize(): Promise<string | null>;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

/**
 * Mirror a PTY's screen in a headless xterm and answer its cursor-position
 * queries, so the answer never depends on a renderer view being mounted,
 * visible or unthrottled. Codex exits when a query goes unanswered for about
 * two seconds. The renderer's xterm leaves these queries to this responder;
 * other queries (device attributes, colors) still come from the renderer,
 * whose theme and settings they describe.
 */
export function createTerminalQueryResponder(opts: {
  cols: number;
  rows: number;
  reply: (data: string) => void;
}): TerminalQueryResponder {
  const term = new Terminal({
    cols: Math.max(1, opts.cols),
    rows: Math.max(1, opts.rows),
    scrollback: SCROLLBACK_LINES,
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  let muted = 0;
  let disposed = false;
  let pendingWrites = 0;

  term.onData((data) => {
    if (disposed || muted > 0 || !CURSOR_POSITION_REPORT.test(data)) return;
    opts.reply(data);
  });

  return {
    feed(data) {
      if (disposed) return;
      pendingWrites++;
      term.write(data, () => {
        pendingWrites--;
      });
    },
    feedDisplayOnly(data) {
      if (disposed) return;
      muted++;
      pendingWrites++;
      // Writes are parsed in order, so the callback runs before any later feed.
      term.write(data, () => {
        muted--;
        pendingWrites--;
      });
    },
    snapshot() {
      if (disposed || pendingWrites > 0) return null;
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let row = 0; row < term.rows; row++) {
        lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
      }
      return { text: lines.join('\n'), bracketedPaste: term.modes.bracketedPasteMode };
    },
    serialize() {
      if (disposed) return Promise.resolve(null);
      // Writes are parsed in order, so this callback runs after all earlier feeds.
      return new Promise((resolve) => {
        term.write('', () => resolve(disposed ? null : serializer.serialize()));
      });
    },
    resize(cols, rows) {
      if (!disposed && cols > 0 && rows > 0) term.resize(cols, rows);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      term.dispose();
    },
  };
}
