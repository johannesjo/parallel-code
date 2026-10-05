import { onMount, onCleanup, createSignal, createEffect, untrack, Show, For } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { TERMINAL_SCROLL_OPTIONS, base64ToUint8Array } from '../lib/terminalConstants';
import { createTerminalHttpLinkHandler } from '../lib/terminalLinks';
import { fetchNotes, saveNotes, ApiError } from './api';
import { TaskDiffView } from './TaskDiffView';
import { TaskActionsDialog } from './TaskActionsDialog';
import { clearPairedToken } from './auth';
import { readLocal, writeLocal } from './storage';
import { messageForTerminal } from './terminalText';
import { TaskHeader } from './TaskHeader';
import {
  subscribeAgent,
  unsubscribeAgent,
  onOutput,
  onScrollback,
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
  const fontSize = 14;
  let terminalLineHeight = fontSize * 1.2;
  const [notesText, setNotesText] = createSignal(readLocal(notesKey));
  const [notesDirty, setNotesDirty] = createSignal(readLocal(`${notesKey}:dirty`) === 'true');
  const [notesLoading, setNotesLoading] = createSignal(false);
  const [notesSaving, setNotesSaving] = createSignal(false);
  const [notesError, setNotesError] = createSignal('');
  const [notesSaved, setNotesSaved] = createSignal(false);
  const agent = () => agents().find((a) => a.agentId === props.agentId);
  const taskId = () => agent()?.taskId;
  const nextAttentionTask = () =>
    agents().find(
      (a) =>
        a.agentId !== props.agentId && (a.attention === 'needs_input' || a.attention === 'error'),
    );
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
        availableWidth > 0
          ? (fontSize * Math.max(1, availableWidth - 24)) / (term.cols * charWidth)
          : 0;
      const heightFit =
        availableHeight > 0 ? Math.max(1, availableHeight - 8) / (term.rows * 1.2) : 0;
      const fittedFontSize = Math.min(fontSize, Math.max(widthFit, heightFit) || fontSize);
      // Scale through xterm so rendering, link hit testing and selection share cell dimensions.
      const renderedFontSize = Math.max(1, fittedFontSize * zoom());
      term.options.fontSize = renderedFontSize;
      const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
      const width =
        screen?.offsetWidth || Math.ceil((term.cols * charWidth * renderedFontSize) / fontSize);
      const height = screen?.offsetHeight || Math.ceil(term.rows * renderedFontSize * 1.2);
      termContainer.style.width = `${width + 24}px`;
      termContainer.style.height = `${height + 8}px`;
      terminalLineHeight = height / term.rows;
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
      theme: { background: '#0b0f14', foreground: '#dce7f1' },
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
    const scrollListener = term.onScroll(updateTerminalBottom);
    const parsedListener = term.onWriteParsed(updateOutput);
    // eslint-disable-next-line solid/reactivity -- socket callbacks read the latest layout settings
    const cleanupScrollback = onScrollback(props.agentId, (data, cols, rows) => {
      if (!term) return;
      const followTerminal = terminalBottom();
      // Reset parser and screen so reconnecting cannot duplicate an old frame.
      term.reset();
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
    subscribeAgent(props.agentId);
    const observer = new ResizeObserver(fitTerminal);
    if (outputArea) observer.observe(outputArea);
    // Own gestures across the entire pane, including space below a fitted grid.
    // Pan the desktop grid first, then scroll terminal history at its edges.
    let touchX = 0;
    let touchY = 0;
    let touchId: number | undefined;
    let historyPixels = 0;
    const scrollTerminal = (dx: number, dy: number) => {
      if (!term || !terminalScroller) return;
      terminalScroller.scrollLeft += dx;
      const previousTop = terminalScroller.scrollTop;
      terminalScroller.scrollTop = Math.max(
        0,
        Math.min(terminalScroller.scrollHeight - terminalScroller.clientHeight, previousTop + dy),
      );
      if (Math.abs(dy) >= Math.abs(dx)) {
        historyPixels += dy - (terminalScroller.scrollTop - previousTop);
        const lines = Math.trunc(historyPixels / terminalLineHeight);
        if (lines) {
          term.scrollLines(lines);
          historyPixels -= lines * terminalLineHeight;
        }
      }
      updateTerminalBottom();
    };
    const touchStart = (e: TouchEvent) => {
      e.stopPropagation();
      historyPixels = 0;
      touchId = undefined;
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
        return;
      }
      const touch = e.touches[0];
      if (touchId !== touch.identifier) {
        touchStart(e);
        return;
      }
      e.preventDefault();
      scrollTerminal(touchX - touch.clientX, touchY - touch.clientY);
      touchX = touch.clientX;
      touchY = touch.clientY;
    };
    const touchEnd = (e: TouchEvent) => {
      e.stopPropagation();
      touchId = undefined;
      historyPixels = 0;
    };
    const wheel = (e: WheelEvent) => {
      e.stopPropagation();
      if (e.ctrlKey) return; // Preserve browser pinch-to-zoom.
      e.preventDefault();
      const scale =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? terminalLineHeight
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? (terminalScroller?.clientHeight ?? terminalLineHeight)
            : 1;
      scrollTerminal(e.deltaX * scale, e.deltaY * scale);
    };
    terminalScroller.addEventListener('touchstart', touchStart, { passive: true });
    terminalScroller.addEventListener('touchmove', touchMove, { passive: false });
    terminalScroller.addEventListener('touchend', touchEnd, { passive: true });
    terminalScroller.addEventListener('touchcancel', touchEnd, { passive: true });
    terminalScroller.addEventListener('wheel', wheel, { passive: false, capture: true });
    onCleanup(() => {
      disposed = true;
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
      scrollListener.dispose();
      parsedListener.dispose();
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

  function selectView(next: 'terminal' | 'notes' | 'diff') {
    const wasDiff = view() === 'diff';
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
          classList={{ 'mobile-terminal-hidden': view() !== 'terminal' }}
          aria-hidden={view() !== 'terminal'}
        >
          <div ref={termContainer} class="mobile-terminal" />
        </div>
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
        <Show when={view() === 'terminal'}>
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
            <div class="mobile-composer">
              <Show when={inputText().includes('\n') && !multilinePaste()}>
                <p class="muted">This terminal sends line breaks as spaces.</p>
              </Show>
              <Show when={sendError()}>
                <p class="mobile-error" role="alert">
                  {sendError()}
                </p>
              </Show>
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
                  disabled={!inputText().trim() || sending() || status() !== 'connected'}
                  onClick={() => void handleSend()}
                >
                  {sending() ? 'Sending…' : canControl() ? 'Send' : 'Authorize'}
                </button>
              </div>
              <Show when={inputText().length >= 3600}>
                <p class="muted" role="status">
                  {4000 - inputText().length} characters remaining
                </p>
              </Show>
              <Show when={sent()}>
                <p class="muted mobile-success" role="status">
                  Accepted by terminal
                </p>
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
