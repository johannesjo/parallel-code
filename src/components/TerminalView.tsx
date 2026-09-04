import {
  onMount,
  onCleanup,
  createEffect,
  createMemo,
  createSignal,
  untrack,
  Show,
} from 'solid-js';
import { Terminal, type IMarker } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { TerminalSearchOverlay } from './TerminalSearchOverlay';
import { TerminalBookmarkGutter } from './TerminalBookmarks';
import { invoke, fireAndForget, Channel } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { getTerminalFontFamily } from '../lib/fonts';
import { TERMINAL_SCROLL_OPTIONS, base64ToUint8Array } from '../lib/terminalConstants';
import {
  getTerminalSearchDecorations,
  getTerminalTheme,
  getTerminalThemeForCustom,
} from '../lib/theme';
import { matchesGlobalShortcut } from '../lib/shortcuts';
import { isMac } from '../lib/platform';
import { resolvedBindings } from '../store/keybindings';
import { matchesKeyEvent } from '../lib/keybindings';
import {
  store,
  setTaskLastInputAt,
  retryTaskMcpStartup,
  markTaskUserActivity,
  setTaskTerminalInputPending,
  noteAgentTerminalInput,
} from '../store/store';
import { clearTerminalInputPendingFromQuestion } from '../store/tasks';
import { isLandedTaskState } from '../store/landing';
import { warn as logWarn } from '../lib/log';
import {
  registerTerminal,
  unregisterTerminal,
  markDirty,
  redrawTerminal,
} from '../lib/terminalFitManager';
import { dataTransferToShellArgs, escapePath } from '../lib/terminalDrop';
import { cleanCopiedTerminalText } from '../lib/copy-text';
import { hasTerminalUserActivity, nextTerminalInputPending } from '../lib/terminalInputPending';
import { computeWrappedPathLinks, createTerminalHttpLinkHandler } from '../lib/terminalLinks';
import { recordSharedWebglContextLoss, WEBGL_REATTACH_DELAY_MS } from '../lib/webglContextLoss';
import { isTerminalPaneOnScreen, WEBGL_DETACH_DELAY_MS } from '../lib/terminalPaneVisibility';
import type { PtyOutput } from '../ipc/types';

let windowUnloading = false;
if (typeof window !== 'undefined') {
  const markWindowUnloading = () => {
    windowUnloading = true;
  };
  window.addEventListener('beforeunload', markWindowUnloading);
  window.addEventListener('pagehide', markWindowUnloading);
}

type ClipboardPaste =
  | { kind: 'file'; path: string }
  | { kind: 'image'; path: string }
  | { kind: 'text'; text: string }
  | { kind: 'empty' };

/** A scroll bookmark: an xterm marker anchored to a line, plus a text preview.
 *  Markers are owned by xterm and freed when term.dispose() runs. */
interface ScrollBookmark {
  id: number;
  marker: IMarker;
  preview: string;
}

/** Per-frame placement for the bookmark gutter. `tops` maps a bookmark id to its
 *  vertical px (visible bookmarks sit on their line; off-screen ones fan at an
 *  edge). Bookmarks beyond the fan cap aren't in `tops` and are summarized by the
 *  above/below overflow counts; the "+N" badge jumps to the nearest hidden one. */
interface BookmarkLayout {
  tops: Map<number, number>;
  aboveCount: number;
  aboveTop: number;
  aboveNextId: number | null;
  belowCount: number;
  belowTop: number;
  belowNextId: number | null;
}

/** Shared "nothing to draw" layout, returned by reference so the memo stays
 *  referentially stable (no allocation, no downstream churn) while a pane streams
 *  with no bookmarks — the common case. Its `tops` map is never mutated. */
const EMPTY_BOOKMARK_LAYOUT: BookmarkLayout = {
  tops: new Map(),
  aboveCount: 0,
  aboveTop: 0,
  aboveNextId: null,
  belowCount: 0,
  belowTop: 0,
  belowNextId: null,
};

// Reserved left-strip width. The terminal is inset by this so dots/buttons never
// overlap terminal text.
const BOOKMARK_GUTTER_WIDTH = 24;
// Height of the "bookmark selection" button; used to clamp it inside the gutter.
const CREATE_BUTTON_HEIGHT = 22;
// Matches the container's padding-top — bookmark/button vertical math is relative to it.
const TERMINAL_PADDING_TOP = 4;
// Bookmark-icon box size (mirrors the button in TerminalBookmarks).
const BOOKMARK_ICON_SIZE = 20;
// Off-screen bookmarks fan out at each gutter edge: up to FAN_MAX icons spaced
// FAN_OFFSET px apart, then a "+N" badge for the rest. EDGE_PAD keeps the first
// icon clear of the very edge.
const BOOKMARK_FAN_MAX = 3;
const BOOKMARK_FAN_OFFSET = 16;
const BOOKMARK_EDGE_PAD = 3;
// C0/C1 control bytes + DEL — stripped from bookmark previews so raw terminal
// output can't garble the tooltip label.
// eslint-disable-next-line no-control-regex -- intentionally matching control chars
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

interface TerminalViewProps {
  taskId: string;
  agentId: string;
  /** False while this pane is hidden inside its task (an unselected tab).
   *  Task-level visibility (focus mode, tiling scroll) is read from the store. */
  visible?: boolean;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Path to a `KEY=VALUE` file merged into the agent's environment at spawn. */
  envFile?: string;
  isShell?: boolean;
  /** Scroll bookmarks reserve a 24px left gutter. Only agent terminals use it;
   *  shell terminals (in-task shells and standalone full-size panels) opt out
   *  (pass false) so they fill the pane with no left inset. */
  bookmarksEnabled?: boolean;
  stepsEnabled?: boolean;
  dockerMode?: boolean;
  dockerImage?: string;
  spawnDelayMs?: number;
  attachExisting?: boolean;
  preserveSessionOnCleanup?: boolean;
  dockerMountWorktreeParent?: boolean;
  onExit?: (exitInfo: {
    exit_code: number | null;
    signal: string | null;
    last_output: string[];
  }) => void;
  onData?: (data: Uint8Array) => void;
  onPromptDetected?: (text: string) => void;
  onFileLink?: (filePath: string) => void;
  onReady?: (focusFn: () => void) => void;
  onBufferReady?: (getBuffer: () => string) => void;
  /** Exposes step-bookmark API: `mark(i)` registers a marker at the current line for
   *  step index `i`; `jump(i)` scrolls the viewport so that marker is visible.
   *  Called with `undefined` on unmount so the consumer can reset its state — important
   *  on agent restart, where this component remounts but the parent does not. */
  onStepNavReady?: (
    api: { mark: (i: number) => void; jump: (i: number) => boolean } | undefined,
  ) => void;
  fontSize?: number;
  autoFocus?: boolean;
  initialCommand?: string;
  isFocused?: boolean;
}

// Status parsing only needs recent output. Capping forwarded bytes avoids
// expensive full-chunk decoding during large terminal bursts.
const STATUS_ANALYSIS_MAX_BYTES = 8 * 1024;

const openTerminalHttpLinkWithModifier = createTerminalHttpLinkHandler({
  isMac,
  requireModifier: true,
  openExternal: (url) => invoke(IPC.ShellOpenExternal, { url }),
  onOpenError: () => logWarn('terminal.link', 'Failed to open external URL'),
});

/** Terminal-layer bindings — filtered from resolved bindings.
 *  Called in the key handler (hot path); resolveBindings walks the full
 *  defaults list on each call, which is fine at human typing speed. */
function getTerminalBindings() {
  return resolvedBindings().filter((b) => b.layer === 'terminal');
}

export function TerminalView(props: TerminalViewProps) {
  let containerRef!: HTMLDivElement;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let webglAddon: WebglAddon | undefined;
  let searchAddon: SearchAddon | undefined;
  let searchInputRef: HTMLInputElement | undefined;
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal('');
  // resultIndex is -1 when there's no active match (or when xterm's match
  // threshold is exceeded); count is the total. They always change together.
  const [searchResult, setSearchResult] = createSignal({ index: -1, count: 0 });

  const resetSearchResults = () => setSearchResult({ index: -1, count: 0 });

  // Scroll bookmarks — the user selects terminal text and pins it; each pin is an
  // xterm marker anchored to that line. Its icon sits next to the line and scrolls
  // with the content; once the line scrolls out of view the icon fans at the top
  // or bottom edge. Session-only, like step bookmarks; markers are owned by xterm
  // and freed on term.dispose().
  const [bookmarks, setBookmarks] = createSignal<ScrollBookmark[]>([]);
  // Bumped whenever the buffer grows or scrolls, so icon positions (derived from
  // live xterm state, not signals) recompute reactively.
  const [overviewTick, setOverviewTick] = createSignal(0);
  const [selectionActive, setSelectionActive] = createSignal(false);
  let nextBookmarkId = 1;

  // Cell/container geometry, cached so the per-frame layout never reads the DOM.
  // Cell height is font-derived (constant until a resize/font change); both are
  // re-measured lazily after the first render and invalidated on resize.
  let screenEl: HTMLElement | undefined;
  let cellHeightPx = 0;
  let containerHeightPx = 0;
  function measureGutterMetrics() {
    if (term && screenEl && term.rows > 0) cellHeightPx = screenEl.clientHeight / term.rows;
    if (containerRef) containerHeightPx = containerRef.clientHeight;
  }

  // Lays out every bookmark for the current scroll position. Recomputed once per
  // tick (createMemo dedupes the multiple reads in JSX). Bookmarks on screen sit
  // on their line; off-screen ones fan at the nearest edge up to the cap.
  const bookmarkLayout = createMemo<BookmarkLayout>(() => {
    overviewTick();
    const bs = bookmarks();
    // Nothing to draw while a full-screen TUI owns the screen (markers point at
    // normal-buffer lines that aren't visible) or when there are no bookmarks.
    if (!term || term.buffer.active.type !== 'normal' || bs.length === 0) {
      return EMPTY_BOOKMARK_LAYOUT;
    }
    const tops = new Map<number, number>();
    const viewportY = term.buffer.active.viewportY;
    const rows = term.rows;
    const cell = cellHeightPx || 17;
    const bottom = containerHeightPx || rows * cell + TERMINAL_PADDING_TOP;
    const above: ScrollBookmark[] = [];
    const below: ScrollBookmark[] = [];
    for (const b of bs) {
      if (b.marker.isDisposed) continue;
      const row = b.marker.line - viewportY;
      if (row < 0) above.push(b);
      else if (row >= rows) below.push(b);
      else tops.set(b.id, TERMINAL_PADDING_TOP + row * cell + cell / 2);
    }
    // Fan off-screen icons nearest-to-viewport first (so the one about to scroll
    // back in sits closest to the edge).
    above.sort((a, b) => b.marker.line - a.marker.line);
    for (let i = 0; i < above.length && i < BOOKMARK_FAN_MAX; i++) {
      tops.set(above[i].id, BOOKMARK_EDGE_PAD + BOOKMARK_ICON_SIZE / 2 + i * BOOKMARK_FAN_OFFSET);
    }
    below.sort((a, b) => a.marker.line - b.marker.line);
    for (let i = 0; i < below.length && i < BOOKMARK_FAN_MAX; i++) {
      tops.set(
        below[i].id,
        bottom - BOOKMARK_EDGE_PAD - BOOKMARK_ICON_SIZE / 2 - i * BOOKMARK_FAN_OFFSET,
      );
    }
    const aboveCount = above.length - BOOKMARK_FAN_MAX;
    const belowCount = below.length - BOOKMARK_FAN_MAX;
    return {
      tops,
      aboveCount: Math.max(0, aboveCount),
      aboveTop: BOOKMARK_EDGE_PAD + BOOKMARK_ICON_SIZE / 2 + BOOKMARK_FAN_MAX * BOOKMARK_FAN_OFFSET,
      aboveNextId: aboveCount > 0 ? above[BOOKMARK_FAN_MAX].id : null,
      belowCount: Math.max(0, belowCount),
      belowTop:
        bottom -
        BOOKMARK_EDGE_PAD -
        BOOKMARK_ICON_SIZE / 2 -
        BOOKMARK_FAN_MAX * BOOKMARK_FAN_OFFSET,
      belowNextId: belowCount > 0 ? below[BOOKMARK_FAN_MAX].id : null,
    };
  });

  // px top for a bookmark icon, or null when it's folded into an overflow badge.
  const bookmarkTopPx = (id: number): number | null => bookmarkLayout().tops.get(id) ?? null;

  function addBookmarkFromSelection() {
    if (!term) return;
    // Only the normal buffer has scrollback worth bookmarking; a marker made on
    // the alternate buffer is silently cleared when the TUI exits.
    if (term.buffer.active.type !== 'normal') return;
    const range = term.getSelectionPosition();
    if (!range) return;
    const buf = term.buffer.active;
    // Selection y is a 0-based absolute buffer row (despite the d.ts "1-based"
    // note — getSelectionPosition returns raw model coords). Anchor the marker
    // to the selection's top line; registerMarker takes a cursor-relative offset.
    const line0 = range.start.y;
    const marker = term.registerMarker(line0 - buf.baseY - buf.cursorY);
    if (!marker) return;
    const firstLine = term.getSelection().split('\n')[0]?.replace(CONTROL_CHARS, '').trim() ?? '';
    const preview = firstLine.slice(0, 120) || `Line ${line0 + 1}`;
    setBookmarks((bs) => [...bs, { id: nextBookmarkId++, marker, preview }]);
    term.clearSelection();
    setSelectionActive(false);
  }

  function removeBookmark(id: number) {
    const b = bookmarks().find((x) => x.id === id);
    if (!b) return;
    b.marker.dispose();
    setBookmarks((bs) => bs.filter((x) => x.id !== id));
  }

  function jumpToBookmark(id: number) {
    if (!term) return;
    const b = bookmarks().find((x) => x.id === id);
    if (!b) return;
    // A marker scrolled past the scrollback limit is disposed — drop it instead.
    if (b.marker.isDisposed) {
      removeBookmark(id);
      return;
    }
    term.scrollToLine(b.marker.line);
  }

  // The "+N" badges jump to the nearest hidden bookmark in that direction, so
  // repeated clicks walk through the off-screen ones as they scroll into the fan.
  const jumpAboveOverflow = () => {
    const id = bookmarkLayout().aboveNextId;
    if (id !== null) jumpToBookmark(id);
  };
  const jumpBelowOverflow = () => {
    const id = bookmarkLayout().belowNextId;
    if (id !== null) jumpToBookmark(id);
  };

  // Vertical position (px from gutter top) for the "bookmark selection" button,
  // aligned to the selection's top line and clamped to the visible area.
  function selectionButtonTop(): number {
    overviewTick();
    if (!term) return 0;
    const range = term.getSelectionPosition();
    if (!range) return 0;
    const cell = cellHeightPx || 17;
    const viewportRow = range.start.y - term.buffer.active.viewportY;
    const top = TERMINAL_PADDING_TOP + viewportRow * cell;
    const maxTop = (containerHeightPx || containerRef?.clientHeight || 0) - CREATE_BUTTON_HEIGHT;
    return Math.min(Math.max(top, 2), Math.max(2, maxTop));
  }

  // The find addon is loaded lazily on first use: most terminals are never
  // searched, and an idle addon keeps a per-write listener alive on every pane.
  function ensureSearchAddon(): SearchAddon | undefined {
    if (searchAddon || !term) return searchAddon;
    searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddon.onDidChangeResults(({ resultIndex, resultCount }) =>
      setSearchResult({ index: resultIndex, count: resultCount }),
    );
    return searchAddon;
  }

  function runSearch(direction: 'next' | 'prev', incremental = false) {
    if (!searchAddon) return;
    const q = searchQuery();
    if (!q) {
      searchAddon.clearDecorations();
      resetSearchResults();
      return;
    }
    const opts = { incremental, decorations: getTerminalSearchDecorations() };
    if (direction === 'prev') searchAddon.findPrevious(q, opts);
    else searchAddon.findNext(q, opts);
  }

  function onSearchInput(value: string) {
    setSearchQuery(value);
    // incremental keeps the current match if it still matches, so the viewport
    // doesn't jump ahead on every keystroke (browser find-as-you-type feel).
    runSearch('next', true);
  }

  function openSearch() {
    if (!term) return;
    if (searchOpen()) {
      searchInputRef?.focus();
      searchInputRef?.select();
      return;
    }
    ensureSearchAddon();
    // Seed from a single-line selection, like a browser's Find does.
    const sel = term.getSelection();
    if (sel && !sel.includes('\n')) setSearchQuery(sel);
    setSearchOpen(true);
    if (searchQuery()) runSearch('next');
  }

  function closeSearch() {
    setSearchOpen(false);
    searchAddon?.clearDecorations();
    resetSearchResults();
    term?.focus();
  }

  function activeTerminalTheme() {
    const id = store.activeCustomThemeId;
    const custom = id ? store.customThemes[id] : undefined;
    return custom
      ? getTerminalThemeForCustom(custom.terminalBackground)
      : getTerminalTheme(store.themePreset);
  }

  onMount(() => {
    // Capture props eagerly so cleanup/callbacks always use the original values
    const taskId = props.taskId;
    const agentId = props.agentId;
    const initialFontSize = props.fontSize ?? 13;
    const attachExisting = props.attachExisting ?? true;
    const preserveSessionOnCleanup = props.preserveSessionOnCleanup === true;
    let ptyDetachedByLanding = false;

    function taskPtyDetached(): boolean {
      return ptyDetachedByLanding || isLandedTaskState(store.tasks[taskId]?.landingState);
    }

    function canForwardInput(): boolean {
      if (store.tasks[taskId]?.automationWriteInFlight) return false;
      return !taskPtyDetached();
    }

    term = new Terminal({
      cursorBlink: true,
      fontSize: initialFontSize,
      fontFamily: getTerminalFontFamily(store.terminalFont),
      screenReaderMode: store.terminalScreenReaderMode,
      theme: activeTerminalTheme(),
      allowProposedApi: true,
      ...TERMINAL_SCROLL_OPTIONS,
      disableStdin: taskPtyDetached(),
      linkHandler: {
        activate: openTerminalHttpLinkWithModifier,
        allowNonHttpProtocols: false,
      },
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon(openTerminalHttpLinkWithModifier));

    term.open(containerRef);
    // The screen element is created by open(); cache it for cell-height measurement.
    screenEl = (term.element?.querySelector('.xterm-screen') as HTMLElement | null) ?? undefined;

    // Block direct PTY keyboard input only after self-landing has removed the
    // backend PTY. Coordinator automation now waits for user activity instead of
    // disabling the user's terminal.
    createEffect(() => {
      const task = store.tasks[taskId];
      if (isLandedTaskState(task?.landingState)) ptyDetachedByLanding = true;
      if (term) term.options.disableStdin = taskPtyDetached();
    });

    // File path link provider — makes file paths clickable in terminal output
    // Must be registered after term.open() so the DOM is available.
    term.registerLinkProvider({
      provideLinks(y, callback) {
        if (!term) {
          callback(undefined);
          return;
        }
        // Reconstruct wrapped lines so a path that spans multiple rows stays a
        // single clickable link across every row it occupies.
        const links = computeWrappedPathLinks(term.buffer.active, y - 1);
        callback(
          links.map((link) => ({
            range: link.range,
            text: link.text,
            activate(event: MouseEvent, _text: string) {
              // Require Cmd+click (Mac) or Ctrl+click (Linux) to open links
              const modifierHeld = isMac ? event.metaKey : event.ctrlKey;
              if (!modifierHeld) return;
              // Strip line:col suffix for opening
              const filePath = link.text.replace(/:\d+(:\d+)?$/, '');
              // Resolve relative paths against the task's working directory
              const resolved = filePath.startsWith('/') ? filePath : `${props.cwd}/${filePath}`;
              // .md files open in viewer; Shift held = open externally instead
              if (/\.md$/i.test(resolved) && props.onFileLink && !event.shiftKey) {
                props.onFileLink(resolved);
              } else {
                invoke(IPC.OpenPath, { filePath: resolved }).catch(console.error);
              }
            },
          })),
        );
      },
    });

    props.onReady?.(() => term?.focus());

    // Step bookmarks — anchor each agent step to the current scrollback line so the
    // user can jump from the steps panel back to the terminal moment a step was written.
    // Markers auto-track buffer truncation; once the marker scrolls past the scrollback
    // limit xterm disposes it, in which case `jump` returns false so the caller can no-op.
    // The map is owned by xterm and freed implicitly when term.dispose() runs in onCleanup.
    const stepMarkers = new Map<number, IMarker>();
    const stepNavApi = {
      mark(i: number) {
        if (!term || stepMarkers.has(i)) return;
        const m = term.registerMarker(0);
        if (m) stepMarkers.set(i, m);
      },
      jump(i: number): boolean {
        if (!term) return false;
        const m = stepMarkers.get(i);
        if (!m || m.isDisposed) return false;
        term.scrollToLine(m.line);
        return true;
      },
    };
    props.onStepNavReady?.(stepNavApi);
    onCleanup(() => props.onStepNavReady?.(undefined));

    // Scroll-bookmark overview: keep bookmark icon positions in sync with the
    // buffer. onRender fires per visual frame (on new output and on scroll), but
    // we only bump the tick when the buffer length or scroll position actually
    // changed, so streaming output doesn't churn reactivity needlessly. These
    // listeners are owned by xterm and torn down by term.dispose() in onCleanup.
    let lastBufLength = -1;
    let lastViewportY = -1;
    let lastBufferType: 'normal' | 'alternate' | undefined;
    const syncOverview = () => {
      if (!term) return;
      // (Re)measure geometry once it's been invalidated (initial mount or resize);
      // the renderer has laid the screen out by the time onRender fires. Do this
      // before the early-return: a resize often leaves length/viewportY unchanged,
      // and we still need fresh geometry + a recompute.
      const needMeasure = cellHeightPx === 0 || containerHeightPx === 0;
      if (needMeasure) {
        measureGutterMetrics();
        // Pane isn't laid out yet (e.g. hidden) — nothing to position; retry on
        // the next render rather than bumping the tick every frame.
        if (cellHeightPx === 0) return;
      }
      const buf = term.buffer.active;
      // Include buffer.type: an alt↔normal switch (TUI enter/exit) can leave
      // length/viewportY unchanged yet must flip the gutter between hidden/shown.
      if (
        !needMeasure &&
        buf.type === lastBufferType &&
        buf.length === lastBufLength &&
        buf.viewportY === lastViewportY
      )
        return;
      lastBufferType = buf.type;
      lastBufLength = buf.length;
      lastViewportY = buf.viewportY;
      setOverviewTick((t) => t + 1);
      // Drop bookmarks whose line scrolled past the scrollback limit. Check before
      // allocating so the common (no bookmark / none disposed) path stays free —
      // this runs every frame, on every streaming pane.
      const bs = bookmarks();
      if (bs.length && bs.some((b) => b.marker.isDisposed)) {
        setBookmarks(bs.filter((b) => !b.marker.isDisposed));
      }
    };
    // onRender covers content growth + most scrolls; onScroll guarantees the
    // viewport-relative icon positions update on every scroll path. The guard in
    // syncOverview dedupes the overlap.
    term.onRender(syncOverview);
    term.onScroll(syncOverview);
    term.onSelectionChange(() => {
      // Only offer to bookmark selections in the normal buffer — a marker on the
      // alternate buffer (full-screen TUI) is cleared the moment the TUI exits.
      const has = term?.hasSelection() === true && term.buffer.active.type === 'normal';
      setSelectionActive(has);
      if (has) setOverviewTick((t) => t + 1); // refresh the button's position
    });

    props.onBufferReady?.(() => {
      if (!term) return '';
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i <= buf.length - 1; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      // Trim trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return lines.join('\n');
    });

    // eslint-disable-next-line solid/reactivity -- key handler reads current signal/binding values intentionally on each keypress
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') {
        // Suppress Shift+Enter keyup so xterm doesn't echo a bare Enter
        if (e.key === 'Enter' && e.shiftKey) return false;
        return true;
      }

      // Let global app shortcuts pass through to the window handler
      if (matchesGlobalShortcut(e)) return false;

      // Look up terminal bindings from registry
      for (const binding of getTerminalBindings()) {
        if (!matchesKeyEvent(e, binding)) continue;

        e.preventDefault();

        // Special actions that need custom handling
        if (binding.action === 'copy') {
          // Belt to the DOM `copy` listener's braces: covers paths where the
          // browser's `copy` event never fires (e.g. Linux Ctrl+Shift+C goes
          // through here, the macOS Edit→Copy menu role goes through the
          // listener). Both produce identical cleaned output, so a redundant
          // double-write is harmless.
          const sel = term?.getSelection();
          if (sel) navigator.clipboard.writeText(cleanCopiedTerminalText(sel));
          return false;
        }

        if (binding.action === 'paste') {
          (async () => {
            // Single round-trip resolver — main process picks the most useful
            // representation: a file path (Finder copy), then a saved image
            // (screenshot), then plain text. Pasting an image-file copy as
            // its bare basename was the bug we're avoiding here.
            //
            // We funnel the result through term.paste() rather than writing
            // to the PTY directly so xterm wraps the payload in bracketed
            // paste markers (\x1b[200~ … \x1b[201~) when the agent has
            // bracketed-paste mode on. CLI agents like Claude Code use that
            // wrapper to recognise "the user pasted a file path", which is
            // what triggers automatic image attachment instead of treating
            // the path as literal typed text.
            const paste = await invoke<ClipboardPaste>(IPC.ResolveClipboardPaste);
            if (paste.kind === 'file' || paste.kind === 'image') {
              term?.paste(escapePath(paste.path));
              return;
            }
            if (paste.kind === 'text') term?.paste(paste.text);
          })().catch((err: unknown) => {
            logWarn('terminal.paste', 'paste handler failed', { err });
          });
          return false;
        }

        if (binding.action === 'find') {
          openSearch();
          return false;
        }

        if (binding.action?.startsWith('scrollback:')) {
          switch (binding.action) {
            case 'scrollback:line-up':
              term?.scrollLines(-1);
              break;
            case 'scrollback:line-down':
              term?.scrollLines(1);
              break;
            case 'scrollback:page-up':
              term?.scrollPages(-1);
              break;
            case 'scrollback:page-down':
              term?.scrollPages(1);
              break;
          }
          return false;
        }

        // Generic escape sequence bindings
        if (binding.escapeSequence) {
          enqueueInput(binding.escapeSequence);
          return false;
        }
      }

      return true;
    });

    // Drag-and-drop support — when the user drops a file on the terminal,
    // type the absolute path(s) into the agent so it can read the file. By
    // default xterm/Browsers would only insert the basename (text/plain),
    // which a CLI agent like Claude Code can't open.
    function handleDragOver(e: DragEvent) {
      if (!e.dataTransfer || e.dataTransfer.types.indexOf('Files') === -1) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    }
    function handleDrop(e: DragEvent) {
      if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const dt = e.dataTransfer;
      void (async () => {
        try {
          const args = await dataTransferToShellArgs(dt);
          if (args) {
            term?.focus();
            // Use term.paste() so xterm emits bracketed-paste markers for
            // agents that have bracketed-paste mode on (Claude Code,
            // Codex). Without the markers the agent sees the path as
            // literal typing and skips the file-attachment recognition.
            term?.paste(args);
          }
        } catch (err) {
          logWarn('terminal.drop', 'drop handler failed', { err });
        }
      })();
    }
    // Use capture so we run before xterm's own listeners (which would otherwise
    // insert just the basename via the dragged item's text/plain payload).
    containerRef.addEventListener('dragover', handleDragOver, true);
    containerRef.addEventListener('drop', handleDrop, true);

    // Clean the selection before it reaches the clipboard: strip per-line
    // padding (TUIs commonly fill rendered lines out to column width), then
    // reflow wrapped paragraphs whose interior lines are uniformly long.
    // Catches both the keybinding path and the Electron Edit→Copy menu role
    // (which fires a synthetic `copy` event and bypasses our
    // attachCustomKeyEventHandler hook). Capture phase runs ahead of any
    // xterm-internal listener.
    function handleCopy(event: ClipboardEvent) {
      const sel = term?.getSelection();
      if (!sel || !event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', cleanCopiedTerminalText(sel));
    }
    containerRef.addEventListener('copy', handleCopy, true);

    onCleanup(() => {
      containerRef.removeEventListener('dragover', handleDragOver, true);
      containerRef.removeEventListener('drop', handleDrop, true);
      containerRef.removeEventListener('copy', handleCopy, true);
    });

    fitAddon.fit();
    registerTerminal(agentId, containerRef, fitAddon, term);

    if (props.autoFocus) {
      term.focus();
    }

    let outputRaf: number | undefined;
    let outputQueue: Uint8Array[] = [];
    let outputQueuedBytes = 0;
    let outputWriteInFlight = false;
    let watermark = 0;
    let ptyPaused = false;
    const FLOW_HIGH = 256 * 1024; // 256KB — pause PTY reader
    const FLOW_LOW = 32 * 1024; // 32KB — resume PTY reader
    let pendingExitPayload: {
      exit_code: number | null;
      signal: string | null;
      last_output: string[];
    } | null = null;

    function emitExit(payload: {
      exit_code: number | null;
      signal: string | null;
      last_output: string[];
    }) {
      if (!term) return;
      term.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
      props.onExit?.(payload);
    }

    function flushOutputQueue() {
      if (!term || outputWriteInFlight || outputQueue.length === 0) return;

      const chunks = outputQueue;
      const totalBytes = outputQueuedBytes;
      outputQueue = [];
      outputQueuedBytes = 0;

      let payload: Uint8Array;
      if (chunks.length === 1) {
        payload = chunks[0];
      } else {
        payload = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          payload.set(chunk, offset);
          offset += chunk.length;
        }
      }

      const statusPayload =
        payload.length > STATUS_ANALYSIS_MAX_BYTES
          ? payload.subarray(payload.length - STATUS_ANALYSIS_MAX_BYTES)
          : payload;

      outputWriteInFlight = true;
      // eslint-disable-next-line solid/reactivity -- write callback is not a reactive context
      term.write(payload, () => {
        outputWriteInFlight = false;
        watermark = Math.max(watermark - payload.length, 0);

        // Resume PTY reader when xterm.js has caught up
        if (watermark < FLOW_LOW && ptyPaused) {
          ptyPaused = false;
          if (taskPtyDetached()) return;
          invoke(IPC.ResumeAgent, { agentId }).catch((err: unknown) => {
            logWarn('terminal.flow', 'ResumeAgent failed', { err });
            ptyPaused = false;
          });
        }

        props.onData?.(statusPayload);
        if (outputQueue.length > 0) {
          scheduleOutputFlush();
          return;
        }
        if (pendingExitPayload) {
          const exit = pendingExitPayload;
          pendingExitPayload = null;
          emitExit(exit);
        }
      });
    }

    function scheduleOutputFlush() {
      if (outputRaf !== undefined) return;
      outputRaf = requestAnimationFrame(() => {
        outputRaf = undefined;
        flushOutputQueue();
      });
    }

    function enqueueOutput(chunk: Uint8Array) {
      outputQueue.push(chunk);
      outputQueuedBytes += chunk.length;
      watermark += chunk.length;

      // Pause PTY reader when xterm.js falls behind
      if (watermark > FLOW_HIGH && !ptyPaused && !taskPtyDetached()) {
        ptyPaused = true;
        invoke(IPC.PauseAgent, { agentId }).catch((err: unknown) => {
          logWarn('terminal.flow', 'PauseAgent failed', { err });
          ptyPaused = false;
        });
      }

      // Flush large bursts promptly to keep perceived latency low.
      if (outputQueuedBytes >= 64 * 1024) {
        flushOutputQueue();
      } else {
        scheduleOutputFlush();
      }
    }

    const onOutput = new Channel<PtyOutput>();
    let initialCommandSent = false;
    onOutput.onmessage = (msg) => {
      if (msg.type === 'Data') {
        enqueueOutput(base64ToUint8Array(msg.data));
        if (!initialCommandSent && props.initialCommand) {
          const cmd = props.initialCommand;
          initialCommandSent = true;
          setTimeout(() => enqueueInput(cmd + '\r'), 50);
        }
      } else if (msg.type === 'Exit') {
        pendingExitPayload = msg.data;
        flushOutputQueue();
        if (!outputWriteInFlight && outputQueue.length === 0 && pendingExitPayload) {
          const exit = pendingExitPayload;
          pendingExitPayload = null;
          emitExit(exit);
        }
      }
    };

    let inputBuffer = '';
    let pendingInput = '';
    let inputFlushTimer: number | undefined;

    function flushPendingInput() {
      if (!pendingInput) return;
      const data = pendingInput;
      pendingInput = '';
      if (inputFlushTimer !== undefined) {
        clearTimeout(inputFlushTimer);
        inputFlushTimer = undefined;
      }
      if (!canForwardInput()) return;
      fireAndForget(IPC.WriteToAgent, { agentId, taskId, data });
      if (!props.isShell && (data.includes('\r') || data.includes('\n'))) {
        setTaskLastInputAt(props.taskId);
      }
    }

    function enqueueInput(data: string) {
      if (!canForwardInput()) return;
      pendingInput += data;
      if (pendingInput.length >= 2048) {
        flushPendingInput();
        return;
      }
      if (inputFlushTimer !== undefined) return;
      // eslint-disable-next-line solid/reactivity
      inputFlushTimer = window.setTimeout(() => {
        inputFlushTimer = undefined;
        flushPendingInput();
      }, 8);
    }

    function noteUserTerminalInput(data: string) {
      if (props.isShell || !store.tasks[props.taskId]) return;
      const hadActivity = hasTerminalUserActivity(data);
      if (hadActivity) {
        markTaskUserActivity(props.taskId);
        // Real typing overrides the synthetic question-handoff pending flag so
        // that a false-positive/self-resolving question doesn't clear pending
        // while the user still has unsubmitted input in the terminal.
        clearTerminalInputPendingFromQuestion(props.taskId);
      }
      const pending = nextTerminalInputPending(
        store.tasks[props.taskId]?.terminalInputPending === true,
        data,
      );
      setTaskTerminalInputPending(props.taskId, pending);
    }

    // eslint-disable-next-line solid/reactivity -- event handler reads current prop values intentionally
    term.onData((data) => {
      if (!canForwardInput()) return;
      noteUserTerminalInput(data);
      if (!props.isShell) noteAgentTerminalInput(agentId, data);
      if (props.onPromptDetected) {
        for (const ch of data) {
          if (ch === '\r') {
            const trimmed = inputBuffer.trim();
            if (trimmed) props.onPromptDetected?.(trimmed);
            inputBuffer = '';
          } else if (ch === '\x7f') {
            inputBuffer = inputBuffer.slice(0, -1);
          } else if (ch === '\x03' || ch === '\x15') {
            inputBuffer = '';
          } else if (ch === '\x1b') {
            // Skip escape sequences — break out, rest of data may contain seq chars
            break;
          } else if (ch >= ' ') {
            inputBuffer += ch;
          }
        }
      }
      enqueueInput(data);
    });

    let resizeFlushTimer: number | undefined;
    let pendingResize: { cols: number; rows: number } | null = null;
    let lastSentCols = -1;
    let lastSentRows = -1;

    function flushPendingResize() {
      if (!pendingResize) return;
      const { cols, rows } = pendingResize;
      pendingResize = null;
      if (taskPtyDetached()) return;
      if (cols === lastSentCols && rows === lastSentRows) return;
      lastSentCols = cols;
      lastSentRows = rows;
      fireAndForget(IPC.ResizeAgent, { agentId, cols, rows });
    }

    term.onResize(({ cols, rows }) => {
      pendingResize = { cols, rows };
      // Invalidate cached geometry — cell height (font-derived) and container
      // height may both have changed; syncOverview re-measures on the next render.
      cellHeightPx = 0;
      containerHeightPx = 0;
      if (resizeFlushTimer !== undefined) return;
      resizeFlushTimer = window.setTimeout(() => {
        resizeFlushTimer = undefined;
        flushPendingResize();
      }, 33);
    });

    // Only disable cursor blink for non-focused terminals to save one RAF
    // loop per terminal.
    createEffect(() => {
      if (!term) return;
      term.options.cursorBlink = props.isFocused === true;
    });

    // Whether this pane is on screen: the active task in focus mode, a task
    // not scrolled fully out of view in tiling mode, and the selected tab
    // within the task. Hidden panes stay mounted (visibility:hidden keeps
    // their layout so fit() never resizes the pty) but do not keep a WebGL
    // context — see terminalPaneVisibility.ts.
    const paneOnScreen = createMemo(() =>
      isTerminalPaneOnScreen({
        focusMode: store.focusMode,
        activeTaskId: store.activeTaskId,
        taskId,
        viewportVisibility: store.taskViewportVisibility[taskId],
        paneVisible: props.visible,
      }),
    );

    // Load the WebGL addon while the pane is on screen. On context loss (GPU
    // process crash, sleep/wake, or context-cap eviction — see
    // max-active-webgl-contexts in electron/main.ts) reattach after a short
    // delay instead of permanently falling back to the much slower DOM
    // renderer. The loss window is shared app-wide so an eviction rotation
    // (each reattach evicting another pane) trips the brake even though every
    // hop lands on a different pane.
    let webglReattachTimer: number | undefined;
    let webglDetachTimer: number | undefined;

    function attachWebgl() {
      if (!term || webglAddon) return;
      // A pane that went off screen while a reattach was pending stays on the
      // DOM renderer; the visibility effect below attaches when it returns.
      if (!untrack(paneOnScreen)) return;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          addon.dispose();
          webglAddon = undefined;
          if (recordSharedWebglContextLoss()) {
            webglReattachTimer = window.setTimeout(() => {
              webglReattachTimer = undefined;
              attachWebgl();
            }, WEBGL_REATTACH_DELAY_MS);
          }
        });
        term.loadAddon(addon);
        webglAddon = addon;
        // No manual repaint here: loadAddon → RenderService.setRenderer
        // already forces a full refresh of this pane. redrawTerminal would
        // additionally clear the glyph atlas xterm SHARES across panes
        // without invalidating the other owners' render models, garbling
        // glyphs in every healthy terminal.
      } catch {
        // WebGL2 not supported — DOM renderer used automatically
      }
    }

    function detachWebgl() {
      if (webglReattachTimer !== undefined) {
        clearTimeout(webglReattachTimer);
        webglReattachTimer = undefined;
      }
      // Dropping the addon returns this pane to the DOM renderer and releases
      // its GL context. The glyph atlas is shared and ref-counted by xterm, so
      // other panes keep theirs.
      webglAddon?.dispose();
      webglAddon = undefined;
    }

    // Attach on the hidden→visible edge, detach a little after visible→hidden.
    // A pane that returns before the detach delay elapses keeps its context;
    // on macOS it is repainted instead (issue #121): a WebGL surface throttled
    // while backgrounded can come back with a corrupt glyph atlas, and a
    // hidden pane never fires terminalFitManager's IntersectionObserver.
    // Linux never showed the corruption, so it skips that repaint.
    let prevOnScreen: boolean | undefined;
    createEffect(() => {
      const onScreen = paneOnScreen();
      if (onScreen) {
        if (webglDetachTimer !== undefined) {
          clearTimeout(webglDetachTimer);
          webglDetachTimer = undefined;
        }
        if (!webglAddon && webglReattachTimer === undefined) {
          // loadAddon → setRenderer already repaints this pane in full.
          attachWebgl();
        } else if (isMac && prevOnScreen === false) {
          redrawTerminal(agentId);
        }
      } else if (webglDetachTimer === undefined) {
        webglDetachTimer = window.setTimeout(() => {
          webglDetachTimer = undefined;
          detachWebgl();
        }, WEBGL_DETACH_DELAY_MS);
      }
      prevOnScreen = onScreen;
    });

    let spawnTimer: number | undefined;
    let spawnStarted = false;

    function startSpawn() {
      if (!term || spawnStarted) return;
      const landingState = store.tasks[taskId]?.landingState;
      if (isLandedTaskState(landingState)) return;
      spawnStarted = true;
      invoke(IPC.SpawnAgent, {
        taskId,
        agentId,
        command: props.command,
        args: props.args,
        cwd: props.cwd,
        env: props.env ?? {},
        envFile: props.envFile,
        cols: term.cols,
        rows: term.rows,
        isShell: props.isShell,
        stepsEnabled: props.stepsEnabled,
        dockerMode: props.dockerMode,
        dockerImage: props.dockerImage,
        dockerMountWorktreeParent: props.dockerMountWorktreeParent,
        shareDockerAgentAuth: store.shareDockerAgentAuth,
        attachExisting,
        onOutput,
      })
        // eslint-disable-next-line solid/reactivity -- promise callbacks are not reactive contexts
        .then(() => {
          flushPendingResize();
          flushPendingInput();
        })
        // eslint-disable-next-line solid/reactivity -- promise catch handler reads current prop values intentionally
        .catch((err) => {
          // eslint-disable-next-line no-control-regex -- intentionally stripping control/escape chars to prevent terminal injection
          const safeErr = String(err).replace(/[\x00-\x1f\x7f]/g, '');
          term?.write(`\x1b[31mFailed to spawn: ${safeErr}\x1b[0m\r\n`);
          props.onExit?.({
            exit_code: null,
            signal: 'spawn_failed',
            last_output: [`Failed to spawn: ${safeErr}`],
          });
        });
    }

    // For coordinator and coordinated sub-tasks, defer spawn until MCP is ready.
    // Coordinator tasks wait for StartMCPServer to complete; sub-tasks wait for hydrateTask.
    // Always install the watcher when MCP lifecycle is present so that Retry (error → ready)
    // works even when the component mounts in 'error' state.
    const spawnDelayMsVal = props.spawnDelayMs ?? 0;
    const task = store.tasks[taskId];
    if (task?.mcpStartupStatus !== undefined) {
      let spawned = false;
      createEffect(() => {
        if (spawned) return;
        const status = store.tasks[taskId]?.mcpStartupStatus;
        if (status === 'ready') {
          spawned = true;
          if (spawnDelayMsVal > 0) {
            spawnTimer = window.setTimeout(startSpawn, spawnDelayMsVal);
          } else {
            startSpawn();
          }
        }
        // 'error' is handled by the overlay rendered outside onMount
      });
    } else if (spawnDelayMsVal > 0) {
      spawnTimer = window.setTimeout(startSpawn, spawnDelayMsVal);
    } else {
      startSpawn();
    }

    onCleanup(() => {
      const preserveSession = preserveSessionOnCleanup;
      if (!windowUnloading || preserveSession) {
        flushPendingInput();
        flushPendingResize();
      }
      if (spawnTimer !== undefined) clearTimeout(spawnTimer);
      if (inputFlushTimer !== undefined) clearTimeout(inputFlushTimer);
      if (resizeFlushTimer !== undefined) clearTimeout(resizeFlushTimer);
      if (webglReattachTimer !== undefined) clearTimeout(webglReattachTimer);
      if (webglDetachTimer !== undefined) clearTimeout(webglDetachTimer);
      if (outputRaf !== undefined) cancelAnimationFrame(outputRaf);
      onOutput.cleanup?.();
      webglAddon?.dispose();
      webglAddon = undefined;
      searchAddon?.dispose();
      searchAddon = undefined;
      unregisterTerminal(agentId);
      if (ptyPaused && !taskPtyDetached()) {
        fireAndForget(IPC.ResumeAgent, { agentId });
        ptyPaused = false;
      }
      if (!preserveSession && spawnStarted && !taskPtyDetached()) {
        fireAndForget(IPC.KillAgent, { agentId });
      }
      term?.dispose();
    });
  });

  createEffect(() => {
    const size = props.fontSize;
    if (size === undefined || !term || !fitAddon) return;
    term.options.fontSize = size;
    markDirty(props.agentId);
  });

  createEffect(() => {
    const font = store.terminalFont;
    if (!term || !fitAddon) return;
    term.options.fontFamily = getTerminalFontFamily(font);
    markDirty(props.agentId);
  });

  createEffect(() => {
    const screenReaderMode = store.terminalScreenReaderMode;
    if (!term) return;
    term.options.screenReaderMode = screenReaderMode;
  });

  createEffect(() => {
    if (!term) return;
    term.options.theme = activeTerminalTheme();
    markDirty(props.agentId);
  });

  const mcpError = () => store.tasks[props.taskId]?.mcpStartupError;
  const mcpStatus = () => store.tasks[props.taskId]?.mcpStartupStatus;

  // Reserve the bookmark gutter only when bookmarks are enabled AND the terminal
  // is on the normal buffer. Shell terminals (in-task shells and standalone
  // full-size panels) opt out via the prop. Agent terminals opt in, but a
  // full-screen TUI (e.g. Claude Code) switches to the alternate buffer, which
  // has no scrollback to anchor a marker to — so we drop the inset there and give
  // the pane its full width back instead of stranding an empty 24px strip.
  // Driven by overviewTick (bumped on alt<->normal switches); the memo only
  // re-renders the layout on a real buffer flip, not on every streaming frame.
  const reserveGutter = createMemo(() => {
    if (props.bookmarksEnabled === false) return false;
    overviewTick();
    return !term || term.buffer.active.type === 'normal';
  });

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Show when={reserveGutter()}>
        <TerminalBookmarkGutter
          width={BOOKMARK_GUTTER_WIDTH}
          bookmarks={bookmarks()}
          topOf={bookmarkTopPx}
          onJump={jumpToBookmark}
          onRemove={removeBookmark}
          aboveCount={bookmarkLayout().aboveCount}
          aboveTop={bookmarkLayout().aboveTop}
          belowCount={bookmarkLayout().belowCount}
          belowTop={bookmarkLayout().belowTop}
          onJumpAbove={jumpAboveOverflow}
          onJumpBelow={jumpBelowOverflow}
          createVisible={selectionActive()}
          createTop={selectionButtonTop()}
          onCreate={addBookmarkFromSelection}
        />
      </Show>
      <div
        ref={containerRef}
        style={{
          width: reserveGutter() ? `calc(100% - ${BOOKMARK_GUTTER_WIDTH}px)` : '100%',
          height: '100%',
          'margin-left': reserveGutter() ? `${BOOKMARK_GUTTER_WIDTH}px` : '0',
          overflow: 'hidden',
          padding: '4px 0 0 4px',
          contain: 'strict',
        }}
      />
      <Show when={searchOpen()}>
        <TerminalSearchOverlay
          query={searchQuery()}
          resultIndex={searchResult().index}
          resultCount={searchResult().count}
          onInput={onSearchInput}
          onNext={() => runSearch('next')}
          onPrev={() => runSearch('prev')}
          onClose={closeSearch}
          setInputRef={(el) => (searchInputRef = el)}
        />
      </Show>
      <Show when={mcpStatus() === 'error'}>
        <div
          style={{
            position: 'absolute',
            inset: '0',
            display: 'flex',
            'flex-direction': 'column',
            'align-items': 'center',
            'justify-content': 'center',
            gap: '12px',
            background: 'color-mix(in srgb, var(--bg-elevated) 92%, transparent)',
            'font-family': 'var(--font-ui)',
            'z-index': '10',
          }}
        >
          <span
            style={{
              color: 'var(--error)',
              'font-size': '13px',
              'text-align': 'center',
              padding: '0 16px',
            }}
          >
            MCP startup failed: {mcpError() ?? 'unknown error'}
          </span>
          <button
            style={{
              padding: '6px 16px',
              background: 'var(--accent)',
              color: 'var(--accent-text)',
              border: 'none',
              'border-radius': 'var(--radius-xs)',
              'font-size': '13px',
              cursor: 'pointer',
            }}
            onClick={() => retryTaskMcpStartup(props.taskId)}
          >
            Retry
          </button>
        </div>
      </Show>
    </div>
  );
}
