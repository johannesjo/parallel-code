import headless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';

const { Terminal } = headless;
const { SerializeAddon } = serializeAddon;

/**
 * Lines kept above the viewport. Widening a terminal unwraps lines and pulls
 * scrollback back into view, which moves the cursor row, so the mirror needs
 * about a screen's worth to agree with the renderer's xterm. Far below the
 * renderer's 10k because one mirror runs per PTY in the main process.
 */
export const MIRROR_SCROLLBACK_LINES = 200;

/**
 * Lines kept while Remote Access is on. Phones are sent this history when they
 * open a terminal, so it matches the renderer's scrollback (TERMINAL_SCROLL_OPTIONS).
 * A phone may open any agent, so the history must exist before it subscribes.
 */
export const REMOTE_SCROLLBACK_LINES = 10_000;

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
  /** Change how many lines are kept above the viewport; lowering it drops the oldest. */
  setScrollback(lines: number): void;
  /**
   * What the renderer's xterm sends for `lines` wheel turns over a 1-based cell,
   * negative scrolling up. Null when the program is not reading SGR wheel reports.
   */
  wheelReport(lines: number, col: number, row: number): string | null;
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
  scrollback?: number;
}): TerminalQueryResponder {
  const term = new Terminal({
    cols: Math.max(1, opts.cols),
    rows: Math.max(1, opts.rows),
    scrollback: opts.scrollback ?? MIRROR_SCROLLBACK_LINES,
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  let muted = 0;
  let disposed = false;
  let pendingWrites = 0;
  // xterm keeps the report encoding private, so follow the same modes it does:
  // 1006 selects SGR reports, 1016 SGR pixel reports, and resetting either the default.
  let sgrReports = false;
  const trackMouseEncoding = (params: (number | number[])[], set: boolean) => {
    for (const param of params) {
      if (param === 1006) sgrReports = set;
      else if (param === 1016) sgrReports = false;
    }
    return false;
  };
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) =>
    trackMouseEncoding(params, true),
  );
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) =>
    trackMouseEncoding(params, false),
  );
  term.parser.registerEscHandler({ final: 'c' }, () => {
    sgrReports = false;
    return false;
  });

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
    setScrollback(lines) {
      if (!disposed) term.options.scrollback = lines;
    },
    wheelReport(lines, col, row) {
      const tracking = term.modes.mouseTrackingMode;
      // X10 tracking reports presses only. The renderer sends other encodings as
      // binary events the desktop pane never forwards, so the wheel does nothing there.
      if (disposed || !lines || !sgrReports || tracking === 'none' || tracking === 'x10')
        return null;
      const x = Math.min(term.cols, Math.max(1, col));
      const y = Math.min(term.rows, Math.max(1, row));
      return `\x1b[<${lines < 0 ? 64 : 65};${x};${y}M`.repeat(Math.abs(lines));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      term.dispose();
    },
  };
}
