import { onMount, onCleanup, createSignal, createEffect, untrack, Show, For } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { TERMINAL_SCROLL_OPTIONS, base64ToUint8Array } from '../lib/terminalConstants';
import { createFling } from './fling';
import { createTerminalHttpLinkHandler } from '../lib/terminalLinks';
import { PARALLEL_CODE_TERMINAL_THEME } from '../lib/parallelCodeTerminalTheme';
import { fetchNotes, saveNotes, ApiError } from './api';
import { TaskDiffView } from './TaskDiffView';
import { TaskActionsDialog } from './TaskActionsDialog';
import { clearPairedToken } from './auth';
import { readLocal, writeLocal } from './storage';
import { messageForTerminal, terminalBufferText } from './terminalText';
import { TaskHeader } from './TaskHeader';
import { needsYou } from './attention';
import { MAX_SCROLL_LINES } from '../../electron/remote/protocol';
import {
  subscribeAgent,
  unsubscribeAgent,
  onOutput,
  onScrollback,
  onTerminalSize,
  scrollAgent,
  sendInput,
  agents,
  status,
  canControl,
} from './ws';

interface AgentDetailProps {
  agentId: string;
  taskName: string;
  onBack: () => void;
  onNeedsPairing: () => void;
  onNextTask: (taskId: string) => void;
}

// Rows of swipe per wheel notch in a full-screen agent UI. Agents scroll about
// three lines per notch, so this keeps the transcript roughly under the finger.
const ROWS_PER_WHEEL_NOTCH = 3;

const openRemoteHttpLink = createTerminalHttpLinkHandler({
  isMac: false,
  openExternal: (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
});

export function AgentDetail(props: AgentDetailProps) {
  let termContainer: HTMLDivElement | undefined;
  let outputArea: HTMLDivElement | undefined;
  let terminalScroller: HTMLDivElement | undefined;
  let textView: HTMLPreElement | undefined;
  let inputRef: HTMLTextAreaElement | undefined;
  let term: Terminal | undefined;
  let disposed = false;
  let renderFrame = 0;
  // The parent keys this component by agent ID.
  // eslint-disable-next-line solid/reactivity
  const draftKey = `reply:${props.agentId}`;
  // eslint-disable-next-line solid/reactivity
  const notesKey = `notes:${props.agentId}`;
  // eslint-disable-next-line solid/reactivity
  const bashKey = `reply:${props.agentId}:bash`;
  const [inputText, setInputText] = createSignal(readLocal(draftKey));
  const [bashMode, setBashMode] = createSignal(readLocal(bashKey) === 'true');
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal('');
  const [sent, setSent] = createSignal(false);
  const [view, setView] = createSignal<'terminal' | 'notes' | 'diff'>('terminal');
  // Bumped to force the diff tab to refetch; the resource keys on it.
  const [diffToken, setDiffToken] = createSignal(0);
  const [showActions, setShowActions] = createSignal(false);
  const [multilinePaste, setMultilinePaste] = createSignal(false);
  const [terminalBottom, setTerminalBottom] = createSignal(true);
  const [zoom, setZoom] = createSignal(1);
  // xterm only selects with a mouse, so touch selection works on a plain-text copy.
  const [selectableText, setSelectableText] = createSignal<string>();
  const fontSize = 14;
  let terminalLineHeight = fontSize * 1.2;
  // xterm draws history only at whole rows, so a swipe stepped it a row at a time
  // while the grid around it panned by the pixel. The pixels short of the next row
  // shift the drawn rows instead, so history follows the finger like the grid does.
  let historyOffset = 0;
  // xterm draws scrolled rows on its next frame. Shifting them sooner moved the
  // old rows by the new amount for a frame, so a fling juddered at each row.
  let awaitingRows = false;
  const shiftRows = () => {
    const screen = term?.element?.querySelector<HTMLElement>('.xterm-screen');
    if (screen) screen.style.transform = historyOffset ? `translateY(${-historyOffset}px)` : '';
  };
  /** Shift the drawn rows by `offset`, once xterm has drawn any rows that moved. */
  const setHistoryOffset = (offset: number, rowsMoved: boolean) => {
    historyOffset = offset;
    awaitingRows ||= rowsMoved;
    if (!awaitingRows) shiftRows();
  };
  const resetHistoryOffset = () => {
    historyOffset = 0;
    awaitingRows = false;
    shiftRows();
  };
  const [notesText, setNotesText] = createSignal(readLocal(notesKey));
  const [notesDirty, setNotesDirty] = createSignal(readLocal(`${notesKey}:dirty`) === 'true');
  const [notesLoading, setNotesLoading] = createSignal(false);
  const [notesSaving, setNotesSaving] = createSignal(false);
  const [notesError, setNotesError] = createSignal('');
  const [notesSaved, setNotesSaved] = createSignal(false);
  const agent = () => agents().find((a) => a.agentId === props.agentId);
  const taskId = () => agent()?.taskId;
  const nextAttentionTask = () => agents().find((a) => a.agentId !== props.agentId && needsYou(a));
  const nextTask = () => {
    const list = agents();
    if (list.length < 2) return undefined;
    return list[(list.findIndex((a) => a.agentId === props.agentId) + 1) % list.length];
  };

  createEffect(() => writeLocal(draftKey, inputText()));
  createEffect(() => writeLocal(bashKey, bashMode() ? 'true' : ''));
  createEffect(() => {
    if (notesDirty()) {
      writeLocal(notesKey, notesText());
      writeLocal(`${notesKey}:dirty`, 'true');
    }
  });
  createEffect(() => {
    inputText();
    resizeComposer();
  });
  function resizeComposer() {
    if (inputRef) {
      inputRef.style.height = 'auto';
      inputRef.style.height = `${Math.min(160, inputRef.scrollHeight)}px`;
    }
  }

  function fitTerminal() {
    cancelAnimationFrame(renderFrame);
    renderFrame = requestAnimationFrame(() => {
      if (disposed || !term || !termContainer || !outputArea) return;
      const followTerminal = terminalBottom();
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (context) context.font = `${fontSize}px monospace`;
      const charWidth = context?.measureText('M').width ?? fontSize * 0.61;
      const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
      // Size cells from the grid rendered at the base font size: xterm rows are
      // taller than fontSize * lineHeight, and fitting to that estimate overflowed
      // the pane, so vertical swipes scrolled the pane before reaching history.
      // Measuring at one fixed size keeps repeated fits from drifting.
      term.options.fontSize = fontSize;
      const cellWidth = (screen?.offsetWidth ?? 0) / term.cols / fontSize || charWidth / fontSize;
      const cellHeight = (screen?.offsetHeight ?? 0) / term.rows / fontSize || 1.2;
      const availableWidth = outputArea.clientWidth;
      const availableHeight = outputArea.clientHeight;
      // Fitting a wide agent grid to the phone's width alone shrinks it to a few
      // pixels per row and leaves the pane mostly empty — and since nothing then
      // overflows, there is nothing to pan either, so a full-screen agent UI (which
      // has no scrollback to fall through to) cannot be scrolled at all. Fill the
      // pane on whichever axis binds less and let the other overflow into the pan
      // gestures below. Each fit is the largest font size that axis still allows;
      // zero means the axis is unmeasured, not that it is infinitely tight.
      const widthFit =
        availableWidth > 0 ? Math.max(1, availableWidth - 24) / (term.cols * cellWidth) : 0;
      const heightFit =
        availableHeight > 0 ? Math.max(1, availableHeight - 8) / (term.rows * cellHeight) : 0;
      const fittedFontSize = Math.min(fontSize, Math.max(widthFit, heightFit) || fontSize);
      // Scale through xterm so rendering, link hit testing and selection share cell dimensions.
      term.options.fontSize = Math.max(1, fittedFontSize * zoom());
      // Cells snap to device pixels, so the fit can still overshoot its axis by a
      // row. xterm resizes the grid synchronously, so shrink before the next paint.
      const fitsHeight = heightFit >= widthFit;
      const size = () => (fitsHeight ? screen?.offsetHeight : screen?.offsetWidth) ?? 0;
      const limit = (fitsHeight ? availableHeight - 8 : availableWidth - 24) * zoom();
      for (let i = 0; limit > 0 && size() > limit && i < 8; i++) {
        // Step at least 3%: a smaller step may not shrink a snapped row.
        term.options.fontSize = Math.max(1, term.options.fontSize / Math.max(size() / limit, 1.03));
      }
      const renderedFontSize = term.options.fontSize;
      const width = screen?.offsetWidth || Math.ceil(term.cols * cellWidth * renderedFontSize);
      const height = screen?.offsetHeight || Math.ceil(term.rows * renderedFontSize * cellHeight);
      termContainer.style.width = `${width + 24}px`;
      termContainer.style.height = `${height + 8}px`;
      terminalLineHeight = height / term.rows;
      // An offset measured in the old row height would misplace the rows.
      resetHistoryOffset();
      // Repaint once the task's visible layout has settled, including a return from Notes.
      term.refresh(0, term.rows - 1);
      if (followTerminal && view() === 'terminal') jumpToLatest();
      else updateTerminalBottom();
    });
  }

  function updateTerminalBottom() {
    if (!term || !terminalScroller) return;
    setTerminalBottom(
      term.buffer.active.viewportY >= term.buffer.active.baseY &&
        terminalScroller.scrollHeight - terminalScroller.scrollTop - terminalScroller.clientHeight <
          48,
    );
  }

  function jumpToLatest() {
    term?.scrollToBottom();
    resetHistoryOffset();
    if (terminalScroller) terminalScroller.scrollTop = terminalScroller.scrollHeight;
    setTerminalBottom(true);
  }

  onMount(() => {
    if (!termContainer || !terminalScroller) return;
    term = new Terminal({
      cols: 80,
      rows: 24,
      fontSize,
      fontFamily: 'monospace',
      lineHeight: 1.2,
      // The phone screen's background, with the desktop default look's ANSI colours.
      theme: { background: '#080c10', ...PARALLEL_CODE_TERMINAL_THEME },
      ...TERMINAL_SCROLL_OPTIONS,
      cursorBlink: false,
      disableStdin: true,
      linkHandler: { activate: openRemoteHttpLink, allowNonHttpProtocols: false },
    });
    term.open(termContainer);
    fitTerminal();
    let terminalFrame = 0;
    const updateOutput = () => {
      if (term) setMultilinePaste(term.modes.bracketedPasteMode);
    };
    // Set while a swipe moves history, so its own row steps are not mistaken for output.
    let scrollingHistory = false;
    const scrollListener = term.onScroll(() => {
      // A swipe that stops just short of the latest row leaves it partly hidden, and
      // output then follows with it hidden. Rows are moving anyway: take up the slack.
      if (
        !scrollingHistory &&
        historyOffset < 0 &&
        term?.buffer.active.viewportY === term?.buffer.active.baseY
      ) {
        setHistoryOffset(0, true);
      }
      updateTerminalBottom();
    });
    const renderListener = term.onRender(() => {
      if (!awaitingRows) return;
      awaitingRows = false;
      shiftRows();
    });
    const parsedListener = term.onWriteParsed(updateOutput);
    // A full-screen agent draws its own screen, which must not inherit history's part-row shift.
    const bufferListener = term.buffer.onBufferChange(resetHistoryOffset);
    // eslint-disable-next-line solid/reactivity -- socket callbacks read the latest layout settings
    const cleanupScrollback = onScrollback(props.agentId, (data, cols, rows) => {
      if (!term) return;
      const followTerminal = terminalBottom();
      // Reset parser and screen so reconnecting cannot duplicate an old frame.
      term.reset();
      resetHistoryOffset();
      term.resize(Math.max(1, cols || 80), Math.max(1, rows || 24));
      fitTerminal();
      term.write(base64ToUint8Array(data), () => {
        updateOutput();
        cancelAnimationFrame(terminalFrame);
        terminalFrame = requestAnimationFrame(() => {
          if (disposed) return;
          if (followTerminal && view() === 'terminal') jumpToLatest();
          else updateTerminalBottom();
        });
      });
    });
    const cleanupOutput = onOutput(props.agentId, (data) =>
      term?.write(base64ToUint8Array(data), updateOutput),
    );
    // Follow the PTY's width, or the agent's later lines wrap at the wrong column.
    // xterm parses queued output before resizing, so earlier lines keep their width.
    const cleanupSize = onTerminalSize(props.agentId, (cols, rows) => {
      term?.resize(cols, rows);
      fitTerminal();
    });
    subscribeAgent(props.agentId);
    const observer = new ResizeObserver(fitTerminal);
    if (outputArea) observer.observe(outputArea);
    // Own gestures across the entire pane, including space below a fitted grid.
    // Pan the desktop grid first, then scroll terminal history at its edges.
    let touchX = 0;
    let touchY = 0;
    let touchId: number | undefined;
    // Lock each swipe to its first direction so history scrolling never drifts sideways.
    let touchAxis: 'x' | 'y' | undefined;
    let wheelPixels = 0;
    // A full-screen agent UI keeps its transcript out of the terminal history:
    // turn the wheel over the cell under the finger, as the desktop pane does.
    const scrollFullScreen = (lines: number, x: number, y: number) => {
      if (!term) return;
      const rect = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
      const cell = (offset: number, size: number | undefined, cells: number) =>
        size
          ? Math.min(cells, Math.max(1, Math.floor((offset / size) * cells) + 1))
          : Math.ceil(cells / 2);
      scrollAgent(
        props.agentId,
        Math.max(-MAX_SCROLL_LINES, Math.min(MAX_SCROLL_LINES, lines)),
        cell(x - (rect?.left ?? 0), rect?.width, term.cols),
        cell(y - (rect?.top ?? 0), rect?.height, term.rows),
      );
    };
    /** Pan the grid; returns the vertical pixels it had no room for. */
    const scrollPane = (dx: number, dy: number) => {
      if (!terminalScroller) return dy;
      terminalScroller.scrollLeft += dx;
      const previousTop = terminalScroller.scrollTop;
      terminalScroller.scrollTop = Math.max(
        0,
        Math.min(terminalScroller.scrollHeight - terminalScroller.clientHeight, previousTop + dy),
      );
      return dy - (terminalScroller.scrollTop - previousTop);
    };
    // The agent redraws its own screen, so it can only move by whole wheel notches.
    // Agents scroll several lines per notch, so a notch per row outran the finger.
    const turnWheel = (dy: number, x: number, y: number) => {
      const notchPixels = terminalLineHeight * ROWS_PER_WHEEL_NOTCH;
      wheelPixels += dy;
      const notches = Math.trunc(wheelPixels / notchPixels);
      if (!notches) return;
      scrollFullScreen(notches, x, y);
      wheelPixels -= notches * notchPixels;
    };
    const scrollHistory = (dy: number, x: number, y: number) => {
      // Nothing to move, and redrawing from the other row would flip the blank strip's edge.
      if (!term || !dy) return;
      const buffer = term.buffer.active;
      if (buffer.type === 'alternate') return turnWheel(dy, x, y);
      const top = Math.max(
        0,
        Math.min(
          buffer.baseY * terminalLineHeight,
          buffer.viewportY * terminalLineHeight + historyOffset + dy,
        ),
      );
      const rows = top / terminalLineHeight;
      // Float error must not turn a whole-row scroll into a row and a sliver.
      const whole = Math.abs(rows - Math.round(rows)) < 1e-6;
      // xterm draws no row past either edge, so one edge shows a blank strip of
      // up to a row. Put it where rows leave, so the rows coming in slide in whole.
      const line = whole ? Math.round(rows) : (dy > 0 ? Math.ceil : Math.floor)(rows);
      const rowsMoved = line !== buffer.viewportY;
      // Set first, so the draw the scroll triggers applies the new shift.
      setHistoryOffset(whole ? 0 : top - line * terminalLineHeight, rowsMoved);
      scrollingHistory = true;
      if (rowsMoved) term.scrollLines(line - buffer.viewportY);
      scrollingHistory = false;
    };
    // Grid and history chain as one scroller: a swipe or flick that runs out of
    // grid carries on into history instead of stopping at the edge.
    const scrollTerminal = (dx: number, dy: number, x: number, y: number) => {
      const rest = scrollPane(dx, dy);
      if (Math.abs(dy) >= Math.abs(dx)) scrollHistory(rest, x, y);
      updateTerminalBottom();
    };
    // Coasts over the cell where the swipe left off.
    const fling = createFling((dx, dy) => scrollTerminal(dx, dy, touchX, touchY));
    const touchStart = (e: TouchEvent) => {
      e.stopPropagation();
      fling.stop();
      wheelPixels = 0;
      touchId = undefined;
      touchAxis = undefined;
      if (e.touches.length === 1) {
        touchId = e.touches[0].identifier;
        touchX = e.touches[0].clientX;
        touchY = e.touches[0].clientY;
      }
    };
    const touchMove = (e: TouchEvent) => {
      e.stopPropagation();
      // Let the browser handle pinch zoom.
      if (e.touches.length !== 1) {
        touchId = undefined;
        fling.stop();
        return;
      }
      const touch = e.touches[0];
      if (touchId !== touch.identifier) {
        touchStart(e);
        return;
      }
      e.preventDefault();
      const dx = touchX - touch.clientX;
      const dy = touchY - touch.clientY;
      // Touch-down jitter is not a direction: keep the start point until the swipe has one.
      if (!touchAxis && Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
      touchAxis ??= Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      const [moveX, moveY] = touchAxis === 'x' ? [dx, 0] : [0, dy];
      scrollTerminal(moveX, moveY, touch.clientX, touch.clientY);
      fling.track(moveX, moveY);
      touchX = touch.clientX;
      touchY = touch.clientY;
    };
    const touchEnd = (e: TouchEvent) => {
      e.stopPropagation();
      const lifted = touchId !== undefined && e.type === 'touchend' && e.touches.length === 0;
      touchId = undefined;
      wheelPixels = 0;
      if (lifted) fling.release();
      else fling.stop();
    };
    const wheel = (e: WheelEvent) => {
      e.stopPropagation();
      if (e.ctrlKey) return; // Preserve browser pinch-to-zoom.
      e.preventDefault();
      fling.stop();
      const scale =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? terminalLineHeight
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? (terminalScroller?.clientHeight ?? terminalLineHeight)
            : 1;
      scrollTerminal(e.deltaX * scale, e.deltaY * scale, e.clientX, e.clientY);
    };
    terminalScroller.addEventListener('touchstart', touchStart, { passive: true });
    terminalScroller.addEventListener('touchmove', touchMove, { passive: false });
    terminalScroller.addEventListener('touchend', touchEnd, { passive: true });
    terminalScroller.addEventListener('touchcancel', touchEnd, { passive: true });
    terminalScroller.addEventListener('wheel', wheel, { passive: false, capture: true });
    onCleanup(() => {
      disposed = true;
      fling.stop();
      cancelAnimationFrame(renderFrame);
      cancelAnimationFrame(terminalFrame);
      observer.disconnect();
      terminalScroller?.removeEventListener('touchstart', touchStart);
      terminalScroller?.removeEventListener('touchmove', touchMove);
      terminalScroller?.removeEventListener('touchend', touchEnd);
      terminalScroller?.removeEventListener('touchcancel', touchEnd);
      terminalScroller?.removeEventListener('wheel', wheel, true);
      unsubscribeAgent(props.agentId);
      cleanupScrollback();
      cleanupOutput();
      cleanupSize();
      scrollListener.dispose();
      renderListener.dispose();
      parsedListener.dispose();
      bufferListener.dispose();
      term?.dispose();
      term = undefined;
    });
  });

  createEffect(() => {
    const id = taskId();
    if (view() !== 'notes' || !id || untrack(notesDirty)) return;
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    setNotesLoading(true);
    setNotesError('');
    fetchNotes(id)
      .then((text) => {
        if (!cancelled && !untrack(notesDirty)) setNotesText(text);
      })
      .catch((err: unknown) => {
        if (!cancelled) setNotesError(err instanceof Error ? err.message : 'Could not load notes');
      })
      .finally(() => {
        if (!cancelled) setNotesLoading(false);
      });
  });

  async function handleSaveNotes() {
    const id = taskId();
    if (!id || notesSaving()) return;
    if (!canControl()) {
      props.onNeedsPairing();
      return;
    }
    const text = notesText();
    setNotesSaving(true);
    setNotesError('');
    try {
      await saveNotes(id, text);
      if (disposed) return;
      if (notesText() === text) {
        setNotesDirty(false);
        setNotesSaved(true);
        writeLocal(notesKey, '');
        writeLocal(`${notesKey}:dirty`, '');
      }
    } catch (err) {
      if (disposed) return;
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearPairedToken();
        props.onNeedsPairing();
      } else setNotesError(err instanceof Error ? err.message : 'Could not save notes');
    } finally {
      if (!disposed) setNotesSaving(false);
    }
  }

  async function handleSend() {
    if (sending() || !inputText().trim()) return;
    if (!canControl()) {
      props.onNeedsPairing();
      return;
    }
    const text = inputText();
    const data = messageForTerminal(text, term?.modes.bracketedPasteMode ?? false);
    if (!data) return;
    setSending(true);
    setSendError('');
    setSent(false);
    try {
      // The server types the `!` in a write of its own, so the TUI reads it as a
      // keystroke and opens its shell prompt; inside the paste it would stay text.
      await sendInput(props.agentId, data, {
        submit: true,
        ...(bashMode() ? { prefixKey: '!' } : {}),
      });
      // Clear only the accepted draft, including when the user navigated away.
      if (readLocal(draftKey) === text) {
        writeLocal(draftKey, '');
        writeLocal(bashKey, '');
      }
      if (!disposed) {
        if (inputText() === text) setInputText('');
        setBashMode(false);
        setSent(true);
        // Whoever sends a message wants to see it land, even from scrolled-back history.
        jumpToLatest();
      }
    } catch (err) {
      if (!disposed)
        setSendError(err instanceof Error ? err.message : 'Could not send. Your draft is saved.');
    } finally {
      if (!disposed) setSending(false);
    }
  }

  async function quickKey(data: string) {
    if (!canControl() || sending()) return;
    setSending(true);
    setSendError('');
    setSent(false);
    try {
      await sendInput(props.agentId, data);
    } catch (err) {
      if (!disposed) setSendError(err instanceof Error ? err.message : 'Could not send key');
    } finally {
      if (!disposed) setSending(false);
    }
  }

  const composerPlaceholder = () => {
    if (bashMode()) return 'Shell command…';
    return agent()?.attention === 'needs_input' ? 'Reply to agent…' : 'Message agent…';
  };

  function composerInput(field: HTMLTextAreaElement) {
    // Mirror the desktop TUI: `!` opening an empty prompt switches to the shell
    // rather than being typed. Only a typed bang counts, so a restored or pasted
    // draft that happens to start with one still goes to the agent as text.
    if (field.value === '!' && !inputText() && !bashMode()) {
      setBashMode(true);
      // The signal never left '', so no reactive update would clear the field.
      field.value = '';
    } else setInputText(field.value);
    setSent(false);
  }

  function toggleTextSelection() {
    if (selectableText() !== undefined || !term) {
      setSelectableText(undefined);
      fitTerminal();
      return;
    }
    const buffer = term.buffer.active;
    // Open where the terminal was showing; the copy wraps differently, so this is approximate.
    const position = terminalBottom() ? 1 : buffer.viewportY / Math.max(1, buffer.length);
    setSelectableText(terminalBufferText(buffer));
    if (textView) textView.scrollTop = position * textView.scrollHeight;
  }

  function selectView(next: 'terminal' | 'notes' | 'diff') {
    const wasDiff = view() === 'diff';
    setSelectableText(undefined);
    setView(next);
    // Re-entering the diff tab refetches, so returning to it always shows the
    // agent's newest work rather than a snapshot from the first visit.
    if (next === 'diff' && wasDiff) setDiffToken((n) => n + 1);
    requestAnimationFrame(() => {
      if (!disposed) {
        fitTerminal();
        if (next === 'terminal') jumpToLatest();
      }
    });
  }

  return (
    <div class="mobile-screen">
      <TaskHeader
        agentId={props.agentId}
        taskName={props.taskName}
        onBack={props.onBack}
        onNeedsPairing={props.onNeedsPairing}
      >
        <Show when={!nextAttentionTask() && nextTask()}>
          {(next) => (
            <button
              class="mobile-button quiet mobile-next-task"
              aria-label={`Next task: ${next().taskName}`}
              title={`Next task: ${next().taskName}`}
              onClick={() => props.onNextTask(next().taskId)}
            >
              <span aria-hidden="true">→</span>
            </button>
          )}
        </Show>
      </TaskHeader>
      <div class="mobile-tabs">
        <nav class="mobile-view-tabs" aria-label="Task views">
          <For
            each={[
              { id: 'terminal' as const, label: 'Terminal' },
              { id: 'notes' as const, label: 'Notes' },
              { id: 'diff' as const, label: 'Diff' },
            ]}
          >
            {(tab) => (
              <button aria-pressed={view() === tab.id} onClick={() => selectView(tab.id)}>
                {tab.label}
              </button>
            )}
          </For>
        </nav>
        <Show when={view() === 'terminal'}>
          <div class="mobile-text-size" role="group" aria-label="Terminal text size">
            <button
              class="mobile-button"
              aria-label="Select terminal text"
              aria-pressed={selectableText() !== undefined}
              onClick={toggleTextSelection}
            >
              Select
            </button>
            <button
              class="mobile-button"
              aria-label="Smaller terminal text"
              disabled={zoom() <= 0.5}
              onClick={() => {
                setZoom((scale) => scale - 0.25);
                fitTerminal();
              }}
            >
              A−
            </button>
            <button
              class="mobile-button"
              aria-label="Larger terminal text"
              disabled={zoom() >= 2}
              onClick={() => {
                setZoom((scale) => scale + 0.25);
                fitTerminal();
              }}
            >
              A+
            </button>
          </div>
        </Show>
      </div>
      <div ref={outputArea} class="mobile-output-area">
        <div
          ref={terminalScroller}
          onScroll={updateTerminalBottom}
          class="mobile-terminal-scroll"
          classList={{
            'mobile-terminal-hidden': view() !== 'terminal' || selectableText() !== undefined,
          }}
          aria-hidden={view() !== 'terminal' || selectableText() !== undefined}
        >
          <div ref={termContainer} class="mobile-terminal" />
        </div>
        <Show when={selectableText() !== undefined}>
          <pre
            ref={textView}
            class="mobile-terminal-text"
            style={{ 'font-size': `${fontSize * zoom()}px` }}
          >
            {selectableText()}
          </pre>
        </Show>
        <Show when={view() === 'notes'}>
          <div class="mobile-scroll mobile-notes">
            <Show when={notesError()}>
              <p class="mobile-error" role="alert">
                {notesError()}
              </p>
            </Show>
            <label class="muted" for="task-notes">
              Task notes
            </label>
            <p class="muted">Keep context here. Saving notes won’t send a message to the agent.</p>
            <textarea
              id="task-notes"
              class="mobile-input"
              rows={12}
              value={notesText()}
              disabled={notesLoading()}
              onInput={(e) => {
                setNotesText(e.currentTarget.value);
                setNotesDirty(true);
                setNotesSaved(false);
              }}
              placeholder={notesLoading() ? 'Loading notes…' : 'Keep context for this task…'}
            />
          </div>
        </Show>
        <Show when={view() === 'diff'}>
          <div class="mobile-scroll">
            <TaskDiffView taskId={taskId()} reloadToken={diffToken()} />
            <Show when={taskId()}>
              <button
                class="mobile-button mobile-diff-actions"
                onClick={() => setShowActions(true)}
              >
                Review &amp; merge
              </button>
            </Show>
          </div>
        </Show>
        <Show when={view() === 'terminal' && selectableText() === undefined}>
          <div class="mobile-output-actions">
            <Show when={nextAttentionTask()}>
              {(next) => (
                <button
                  class="mobile-button mobile-next-task"
                  aria-label={`Next task needing you: ${next().taskName}`}
                  onClick={() => props.onNextTask(next().taskId)}
                >
                  Next task →
                </button>
              )}
            </Show>
            <Show when={!terminalBottom()}>
              <button class="mobile-button" onClick={jumpToLatest}>
                ↓ Latest output
              </button>
            </Show>
          </div>
        </Show>
      </div>
      {/* The composer types into the agent's terminal, so it belongs to the
          terminal view only. The notes footer belongs to Notes alone, and the
          read-only Diff tab gets neither. */}
      <Show
        when={view() === 'notes'}
        fallback={
          <Show when={view() === 'terminal'}>
            <div class="mobile-composer-dock">
              {/* Notices float above the composer instead of growing it, so the
                  terminal keeps its rows and nothing jumps while typing. */}
              <div class="mobile-composer-notices">
                <Show when={inputText().includes('\n') && !multilinePaste()}>
                  <p class="muted">This terminal sends line breaks as spaces.</p>
                </Show>
                <Show when={sendError()}>
                  <p class="mobile-error" role="alert">
                    {sendError()}
                  </p>
                </Show>
                <Show when={inputText().length >= 3600}>
                  <p class="muted" role="status">
                    {4000 - inputText().length} characters remaining
                  </p>
                </Show>
              </div>
              <div class="mobile-composer">
                <div class="mobile-composer-row">
                  <Show when={bashMode()}>
                    <button
                      class="mobile-button mobile-bash"
                      aria-label="Shell command mode"
                      aria-pressed="true"
                      disabled={sending()}
                      onClick={() => {
                        setBashMode(false);
                        inputRef?.focus();
                      }}
                    >
                      !
                    </button>
                  </Show>
                  <textarea
                    ref={(element) => {
                      inputRef = element;
                      queueMicrotask(() => {
                        if (!disposed) resizeComposer();
                      });
                    }}
                    class="mobile-input"
                    rows={1}
                    maxlength={4000}
                    aria-label="Message agent"
                    placeholder={composerPlaceholder()}
                    value={inputText()}
                    onInput={(e) => composerInput(e.currentTarget)}
                    disabled={sending()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                  />
                  <button
                    class="mobile-button primary"
                    classList={{ 'mobile-success': sent() }}
                    disabled={!inputText().trim() || sending() || status() !== 'connected'}
                    // Keep focus in the field: a blur would close the keyboard and
                    // bring back the key row, moving Send before the tap lands.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void handleSend()}
                  >
                    {sending()
                      ? 'Sending…'
                      : !canControl()
                        ? 'Authorize'
                        : sent()
                          ? 'Sent'
                          : 'Send'}
                  </button>
                </div>
                <Show when={sent()}>
                  <span class="mobile-sr-only" role="status">
                    Accepted by terminal
                  </span>
                </Show>
                <div id="terminal-keys" class="mobile-keys" role="group" aria-label="Terminal keys">
                  <For
                    each={[
                      { label: 'Enter', name: 'Enter', data: '\r' },
                      { label: '/', name: 'Slash', data: '/' },
                      { label: 'Tab', name: 'Tab', data: '\t' },
                      { label: '↑', name: 'Arrow up', data: '\x1b[A' },
                      { label: '↓', name: 'Arrow down', data: '\x1b[B' },
                      { label: 'Esc', name: 'Escape', data: '\x1b' },
                      { label: 'Ctrl+C', name: 'Interrupt agent (Control C)', data: '\x03' },
                    ]}
                  >
                    {(key) => (
                      <button
                        class="mobile-button"
                        aria-label={key.name}
                        disabled={!canControl() || sending()}
                        onClick={() => void quickKey(key.data)}
                      >
                        {key.label}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </Show>
        }
      >
        <footer class="mobile-footer mobile-notes-footer">
          <span class="muted" role="status">
            {notesSaved()
              ? 'Saved to your computer'
              : notesDirty()
                ? 'Draft saved on this phone'
                : ''}
          </span>
          <button
            class="mobile-button primary"
            disabled={notesSaving() || notesLoading() || !notesDirty() || status() !== 'connected'}
            onClick={() => void handleSaveNotes()}
          >
            {notesSaving() ? 'Saving…' : canControl() ? 'Save notes' : 'Authorize'}
          </button>
        </footer>
      </Show>
      <Show when={showActions()}>
        <TaskActionsDialog
          taskId={taskId()}
          taskName={props.taskName}
          canAct={canControl()}
          onClose={() => setShowActions(false)}
          onNeedsPairing={props.onNeedsPairing}
          // Merging with cleanup, or closing, removes the task. Returning to the
          // list avoids leaving the user on a screen for an agent that is gone.
          onDone={() => {
            setShowActions(false);
            props.onBack();
          }}
        />
      </Show>
    </div>
  );
}
