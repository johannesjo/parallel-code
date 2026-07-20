import { onMount, onCleanup, createSignal, Show, For } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TERMINAL_SCROLLBACK_LINES, base64ToUint8Array } from '../lib/terminalConstants';
import { createTerminalHttpLinkHandler } from '../lib/terminalLinks';
import { fetchNotes, saveNotes } from './api';
import {
  subscribeAgent,
  unsubscribeAgent,
  onOutput,
  onScrollback,
  sendInput,
  agents,
  status,
} from './ws';

// Build control characters at runtime via lookup — avoids Vite stripping \r during build
const KEYS: Record<number, string> = {};
[3, 4, 13, 27].forEach((c) => {
  KEYS[c] = String.fromCharCode(c);
});
function key(c: number): string {
  return KEYS[c];
}

const TERM_FONT_FAMILY = "'JetBrains Mono', 'Courier New', monospace";

// Measure the average monospace advance width per 1px of font-size. Used to pick
// a font size that makes the desktop's column count exactly fill the phone's
// width, so the terminal uses all available horizontal space instead of leaving
// a gap (desktop narrower than phone) or overflowing (desktop wider).
let measureCanvas: HTMLCanvasElement | undefined;
function charWidthPerPx(): number {
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  const ctx = measureCanvas.getContext('2d');
  if (!ctx) return 0.6;
  ctx.font = `100px ${TERM_FONT_FAMILY}`;
  // Average over a run of glyphs to smooth out sub-pixel rounding.
  return ctx.measureText('MMMMMMMMMM').width / 10 / 100;
}

interface AgentDetailProps {
  agentId: string;
  taskName: string;
  onBack: () => void;
}

const openRemoteHttpLink = createTerminalHttpLinkHandler({
  isMac: false,
  openExternal: (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
});

export function AgentDetail(props: AgentDetailProps) {
  let termContainer: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  const [inputText, setInputText] = createSignal('');
  const [atBottom, setAtBottom] = createSignal(true);
  const [termFontSize, setTermFontSize] = createSignal(10);
  // Desktop PTY column count (from scrollback). The mobile client can't resize
  // the PTY, so the terminal must adapt its font to this width, not vice versa.
  const [serverCols, setServerCols] = createSignal(0);
  // Once the user picks a font with A-/A+, stop auto-fitting so their choice sticks.
  const [manualFont, setManualFont] = createSignal(false);

  // Notes editing
  const [view, setView] = createSignal<'terminal' | 'notes'>('terminal');
  const [notesText, setNotesText] = createSignal('');
  const [notesLoading, setNotesLoading] = createSignal(false);
  const [notesSaving, setNotesSaving] = createSignal(false);
  const [notesError, setNotesError] = createSignal<string | null>(null);
  const [notesDirty, setNotesDirty] = createSignal(false);
  const [notesSaved, setNotesSaved] = createSignal(false);

  const MIN_FONT = 6;
  const MAX_FONT = 24;

  const agentInfo = () => agents().find((a) => a.agentId === props.agentId);
  const taskId = () => agentInfo()?.taskId;

  // Pick the largest font (within bounds) that fits `serverCols` columns into the
  // available width, then render exactly that many columns — filling the width.
  function autoFitFont(): void {
    if (!term || !termContainer || manualFont()) return;
    const cols = serverCols();
    if (cols <= 0) return;
    const cs = getComputedStyle(termContainer);
    const padX = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
    // Small safety margin so metric rounding never overflows into a wrapped line.
    const avail = termContainer.clientWidth - padX - 4;
    const perChar = charWidthPerPx();
    if (avail <= 0 || perChar <= 0) return;
    let fs = Math.floor(avail / (cols * perChar));
    fs = Math.max(MIN_FONT, Math.min(MAX_FONT, fs));
    if (term.options.fontSize !== fs) {
      term.options.fontSize = fs;
      setTermFontSize(fs);
    }
  }

  // Re-fit the terminal to the container. In auto mode the font tracks the
  // desktop column count; in manual mode the columns track the chosen font.
  function refit(): void {
    if (!term) return;
    if (manualFont()) {
      fitAddon?.fit();
      return;
    }
    autoFitFont();
    fitAddon?.fit();
    const cols = serverCols();
    if (cols > 0) term.resize(cols, term.rows);
  }

  function changeFont(delta: number): void {
    const next = Math.max(MIN_FONT, Math.min(MAX_FONT, termFontSize() + delta));
    if (next === termFontSize()) return;
    setManualFont(true);
    setTermFontSize(next);
    if (term) {
      term.options.fontSize = next;
      fitAddon?.fit();
    }
  }

  async function openNotes(): Promise<void> {
    setView('notes');
    const id = taskId();
    if (!id) return;
    setNotesLoading(true);
    setNotesError(null);
    try {
      const n = await fetchNotes(id);
      // Don't clobber unsaved local edits if the user reopens the tab.
      if (!notesDirty()) setNotesText(n);
    } catch (e) {
      setNotesError(e instanceof Error ? e.message : String(e));
    } finally {
      setNotesLoading(false);
    }
  }

  async function handleSaveNotes(): Promise<void> {
    const id = taskId();
    if (!id || notesSaving()) return;
    setNotesSaving(true);
    setNotesError(null);
    try {
      await saveNotes(id, notesText());
      setNotesDirty(false);
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 1500);
    } catch (e) {
      setNotesError(e instanceof Error ? e.message : String(e));
    } finally {
      setNotesSaving(false);
    }
  }

  onMount(() => {
    if (!termContainer) return;

    // Attach native Enter detection directly to the input element.
    // SolidJS event delegation + Android IMEs are unreliable for form submit.
    if (inputRef) {
      const enterHandler = (e: Event) => {
        const ke = e as KeyboardEvent;
        if (ke.key === 'Enter' || ke.keyCode === 13) {
          e.preventDefault();
          handleSend();
        }
      };
      inputRef.addEventListener('keydown', enterHandler);
      onCleanup(() => {
        inputRef?.removeEventListener('keydown', enterHandler);
      });
    }

    // Disable xterm helper elements that capture touch events over
    // the header/input areas (not needed since disableStdin is true)
    const style = document.createElement('style');
    style.textContent =
      '.xterm-helper-textarea, .xterm-composition-view { pointer-events: none !important; }';
    document.head.appendChild(style);
    onCleanup(() => style.remove());

    term = new Terminal({
      fontSize: 10,
      fontFamily: "'JetBrains Mono', 'Courier New', monospace",
      theme: { background: '#0b0f14' },
      scrollback: TERMINAL_SCROLLBACK_LINES,
      cursorBlink: false,
      disableStdin: true,
      convertEol: false,
      linkHandler: {
        activate: openRemoteHttpLink,
        allowNonHttpProtocols: false,
      },
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termContainer);
    fitAddon.fit();

    term.onScroll(() => {
      if (!term) return;
      const isBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
      setAtBottom(isBottom);
    });

    // eslint-disable-next-line solid/reactivity -- output subscription is not a reactive context; refit reads current signal values intentionally
    const cleanupScrollback = onScrollback(props.agentId, (data, cols) => {
      if (cols > 0) setServerCols(cols);
      // Fit the font/geometry to the desktop's column count so the terminal
      // fills the available width.
      refit();
      // Clear before writing — on reconnect the server re-sends the full
      // scrollback buffer, so we must avoid duplicate content.
      term?.clear();
      const bytes = base64ToUint8Array(data);
      term?.write(bytes, () => term?.scrollToBottom());
    });

    const cleanupOutput = onOutput(props.agentId, (data) => {
      const bytes = base64ToUint8Array(data);
      term?.write(bytes);
    });

    subscribeAgent(props.agentId);

    let resizeRaf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => refit());
    });
    observer.observe(termContainer);

    // Refit terminal when soft keyboard opens/closes on mobile
    if (window.visualViewport) {
      const onViewportResize = () => refit();
      window.visualViewport.addEventListener('resize', onViewportResize);
      onCleanup(() => window.visualViewport?.removeEventListener('resize', onViewportResize));
    }

    // Manual touch scrolling for mobile — xterm.js doesn't handle this well
    let touchStartY = 0;
    let touchActive = false;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
        touchActive = true;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!touchActive || !term || e.touches.length !== 1) return;
      const dy = touchStartY - e.touches[0].clientY;
      const lineHeight = term.options.fontSize ?? 13;
      const lines = Math.trunc(dy / lineHeight);
      if (lines !== 0) {
        term.scrollLines(lines);
        touchStartY = e.touches[0].clientY;
      }
      e.preventDefault();
    };
    const onTouchEnd = () => {
      touchActive = false;
    };
    termContainer.addEventListener('touchstart', onTouchStart, { passive: true });
    termContainer.addEventListener('touchmove', onTouchMove, { passive: false });
    termContainer.addEventListener('touchend', onTouchEnd, { passive: true });

    onCleanup(() => {
      termContainer.removeEventListener('touchstart', onTouchStart);
      termContainer.removeEventListener('touchmove', onTouchMove);
      termContainer.removeEventListener('touchend', onTouchEnd);
      observer.disconnect();
      unsubscribeAgent(props.agentId);
      cleanupScrollback();
      cleanupOutput();
      term?.dispose();
    });
  });

  // Dedup guard: multiple event sources (keydown, onInput fallback) can
  // fire handleSend for the same Enter press. The sendId ensures only
  // the latest invocation sends the delayed \r.
  let lastSendId = 0;

  function handleSend() {
    const text = inputText();
    if (!text) return;
    // Keep the typed text while disconnected — send() silently drops
    // messages on a non-open socket, so clearing here would lose input.
    if (status() !== 'connected') return;
    const id = ++lastSendId;
    // Send text and Enter separately — TUI apps (Claude Code, Codex)
    // treat \r inside a pasted block as a literal, not as confirmation.
    sendInput(props.agentId, text);
    setInputText('');
    setTimeout(() => {
      if (lastSendId === id) sendInput(props.agentId, key(13));
    }, 50);
  }

  function handleQuickAction(data: string) {
    sendInput(props.agentId, data);
  }

  function scrollToBottom() {
    term?.scrollToBottom();
  }

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: '#0b0f14',
        position: 'relative',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '10px',
          padding: '10px 14px',
          'border-bottom': '1px solid #223040',
          'flex-shrink': '0',
          position: 'relative',
          'z-index': '10',
          background: '#12181f',
        }}
      >
        <button
          onClick={() => props.onBack()}
          style={{
            background: 'none',
            border: 'none',
            color: '#2ec8ff',
            'font-size': '17px',
            cursor: 'pointer',
            padding: '8px 10px',
            'touch-action': 'manipulation',
          }}
        >
          &#8592; Back
        </button>
        <span
          style={{
            'font-size': '15px',
            'font-weight': '500',
            color: '#d7e4f0',
            flex: '1',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
          }}
        >
          {props.taskName}
        </span>
        <div
          style={{
            width: '8px',
            height: '8px',
            'border-radius': '50%',
            background: agentInfo()?.status === 'running' ? '#2fd198' : '#678197',
          }}
        />
      </div>

      {/* Terminal / Notes tabs */}
      <div
        style={{
          display: 'flex',
          'flex-shrink': '0',
          'border-bottom': '1px solid #223040',
          background: '#12181f',
          position: 'relative',
          'z-index': '10',
        }}
      >
        <For
          each={[
            { id: 'terminal' as const, label: 'Terminal' },
            { id: 'notes' as const, label: 'Notes' },
          ]}
        >
          {(tab) => (
            <button
              onClick={() => {
                if (tab.id === 'notes') {
                  void openNotes();
                } else {
                  setView('terminal');
                  // The terminal was display:none while Notes was open; re-fit
                  // once it's laid out again so it fills the width.
                  requestAnimationFrame(() => refit());
                }
              }}
              style={{
                flex: '1',
                padding: '10px 0',
                background: 'none',
                border: 'none',
                'border-bottom': view() === tab.id ? '2px solid #2ec8ff' : '2px solid transparent',
                color: view() === tab.id ? '#d7e4f0' : '#678197',
                'font-size': '14px',
                'font-weight': '500',
                cursor: 'pointer',
                'touch-action': 'manipulation',
              }}
            >
              {tab.label}
            </button>
          )}
        </For>
      </div>

      {/* Connection status banner */}
      <Show when={status() !== 'connected'}>
        <div
          style={{
            padding: '6px 16px',
            background: status() === 'connecting' ? '#78350f' : '#7f1d1d',
            color: status() === 'connecting' ? '#fde68a' : '#fca5a5',
            'font-size': '13px',
            'text-align': 'center',
            'flex-shrink': '0',
          }}
        >
          {status() === 'connecting' ? 'Reconnecting...' : 'Disconnected — check your network'}
        </div>
      </Show>

      {/* Terminal — overflow:hidden clips xterm.js overlays so they don't
           capture touch events over the header/input areas. Kept mounted (hidden,
           not unmounted) when the Notes tab is active so output keeps streaming. */}
      <div
        ref={termContainer}
        style={{
          flex: '1',
          'min-height': '0',
          padding: '4px',
          position: 'relative',
          overflow: 'hidden',
          display: view() === 'terminal' ? 'block' : 'none',
        }}
      />

      {/* Notes editor */}
      <Show when={view() === 'notes'}>
        <div
          style={{
            flex: '1',
            'min-height': '0',
            display: 'flex',
            'flex-direction': 'column',
            background: '#0b0f14',
          }}
        >
          <Show when={notesError()}>
            <div
              style={{
                padding: '8px 14px',
                background: '#7f1d1d',
                color: '#fca5a5',
                'font-size': '13px',
                'flex-shrink': '0',
              }}
            >
              {notesError()}
            </div>
          </Show>
          <textarea
            value={notesText()}
            disabled={notesLoading()}
            onInput={(e) => {
              setNotesText(e.currentTarget.value);
              setNotesDirty(true);
            }}
            placeholder={notesLoading() ? 'Loading notes…' : 'Notes for this task…'}
            style={{
              flex: '1',
              'min-height': '0',
              width: '100%',
              background: '#0b0f14',
              border: 'none',
              padding: '12px 14px',
              color: '#d7e4f0',
              'font-size': '15px',
              'font-family': "'JetBrains Mono', 'Courier New', monospace",
              'line-height': '1.5',
              resize: 'none',
              outline: 'none',
              'box-sizing': 'border-box',
            }}
          />
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '10px',
              padding: '10px 14px max(10px, env(safe-area-inset-bottom)) 14px',
              'border-top': '1px solid #223040',
              background: '#12181f',
              'flex-shrink': '0',
            }}
          >
            <span style={{ 'font-size': '13px', color: '#678197' }}>
              {notesSaving()
                ? 'Saving…'
                : notesSaved()
                  ? 'Saved'
                  : notesDirty()
                    ? 'Unsaved changes'
                    : ''}
            </span>
            <button
              type="button"
              disabled={notesSaving() || notesLoading() || !taskId()}
              onClick={() => void handleSaveNotes()}
              style={{
                'margin-left': 'auto',
                background: notesSaving() || notesLoading() || !taskId() ? '#1a2430' : '#2ec8ff',
                color: notesSaving() || notesLoading() || !taskId() ? '#678197' : '#031018',
                border: 'none',
                'border-radius': '10px',
                padding: '10px 22px',
                'font-size': '15px',
                'font-weight': '600',
                cursor: notesSaving() || notesLoading() || !taskId() ? 'default' : 'pointer',
                'touch-action': 'manipulation',
              }}
            >
              Save
            </button>
          </div>
        </div>
      </Show>

      {/* Scroll to bottom FAB */}
      <Show when={view() === 'terminal' && !atBottom()}>
        <button
          onClick={scrollToBottom}
          style={{
            position: 'absolute',
            bottom: '140px',
            right: '16px',
            width: '40px',
            height: '40px',
            'border-radius': '50%',
            background: '#12181f',
            border: '1px solid #223040',
            color: '#d7e4f0',
            'font-size': '17px',
            cursor: 'pointer',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            'z-index': '10',
            'touch-action': 'manipulation',
          }}
        >
          &#8595;
        </button>
      </Show>

      {/* Input area */}
      <div
        style={{
          'border-top': '1px solid #223040',
          padding: '8px 10px max(8px, env(safe-area-inset-bottom)) 10px',
          display: view() === 'terminal' ? 'flex' : 'none',
          'flex-direction': 'column',
          gap: '6px',
          'flex-shrink': '0',
          background: '#12181f',
          position: 'relative',
          'z-index': '10',
        }}
      >
        {/* No <form> — it triggers Chrome's autofill heuristics on Android.
             name/id/autocomplete use gibberish so Chrome can't classify the field. */}
        <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
          <input
            ref={inputRef}
            type="text"
            enterkeyhint="send"
            name="xq9k_cmd"
            id="xq9k_cmd"
            autocomplete="xq9k_cmd"
            autocorrect="off"
            autocapitalize="off"
            spellcheck={false}
            inputmode="text"
            value={inputText()}
            onInput={(e) => {
              const val = e.currentTarget.value;
              // Fallback: some Android IMEs insert newline into the value
              const last = val.charCodeAt(val.length - 1);
              if (last === 10 || last === 13) {
                const clean = val.slice(0, -1);
                setInputText(clean);
                e.currentTarget.value = clean;
                handleSend();
                return;
              }
              setInputText(val);
            }}
            placeholder="Type command..."
            style={{
              flex: '1',
              background: '#10161d',
              border: '1px solid #223040',
              'border-radius': '12px',
              padding: '10px 14px',
              color: '#d7e4f0',
              'font-size': '15px',
              'font-family': "'JetBrains Mono', 'Courier New', monospace",
              outline: 'none',
              transition: 'border-color 0.16s ease',
            }}
          />
          <button
            type="button"
            disabled={!inputText().trim()}
            onClick={() => handleSend()}
            style={{
              background: inputText().trim() ? '#2ec8ff' : '#1a2430',
              border: 'none',
              'border-radius': '50%',
              width: '40px',
              height: '40px',
              color: inputText().trim() ? '#031018' : '#678197',
              cursor: inputText().trim() ? 'pointer' : 'default',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              padding: '0',
              'flex-shrink': '0',
              'touch-action': 'manipulation',
              transition: 'background 0.15s, color 0.15s',
            }}
            title="Send"
          >
            <svg width="18" height="18" viewBox="0 0 14 14" fill="none">
              <path
                d="M7 12V2M7 2L3 6M7 2l4 4"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>

        <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
          <For
            each={[
              { label: 'Enter', data: () => key(13) },
              { label: '↑', data: () => key(27) + '[A' },
              { label: '↓', data: () => key(27) + '[B' },
              { label: 'Ctrl+C', data: () => key(3) },
            ]}
          >
            {(action) => (
              <button
                onClick={() => handleQuickAction(action.data())}
                style={{
                  background: '#1a2430',
                  border: '1px solid #223040',
                  'border-radius': '8px',
                  padding: '10px 16px',
                  color: '#9bb0c3',
                  'font-size': '14px',
                  'font-family': "'JetBrains Mono', 'Courier New', monospace",
                  cursor: 'pointer',
                  'touch-action': 'manipulation',
                  transition: 'background 0.16s ease',
                }}
              >
                {action.label}
              </button>
            )}
          </For>
          <div style={{ 'margin-left': 'auto', display: 'flex', gap: '6px' }}>
            <button
              onClick={() => changeFont(-1)}
              disabled={termFontSize() <= MIN_FONT}
              style={{
                background: '#1a2430',
                border: '1px solid #223040',
                'border-radius': '8px',
                padding: '10px 14px',
                color: termFontSize() <= MIN_FONT ? '#344050' : '#9bb0c3',
                'font-size': '14px',
                'font-weight': '700',
                'font-family': "'JetBrains Mono', 'Courier New', monospace",
                cursor: termFontSize() <= MIN_FONT ? 'default' : 'pointer',
                'touch-action': 'manipulation',
                transition: 'background 0.16s ease',
              }}
              title="Decrease font size"
            >
              A-
            </button>
            <button
              onClick={() => changeFont(1)}
              disabled={termFontSize() >= MAX_FONT}
              style={{
                background: '#1a2430',
                border: '1px solid #223040',
                'border-radius': '8px',
                padding: '10px 14px',
                color: termFontSize() >= MAX_FONT ? '#344050' : '#9bb0c3',
                'font-size': '14px',
                'font-weight': '700',
                'font-family': "'JetBrains Mono', 'Courier New', monospace",
                cursor: termFontSize() >= MAX_FONT ? 'default' : 'pointer',
                'touch-action': 'manipulation',
                transition: 'background 0.16s ease',
              }}
              title="Increase font size"
            >
              A+
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
