import { onMount, onCleanup, createSignal, Show, For } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  subscribeAgent,
  unsubscribeAgent,
  onOutput,
  onScrollback,
  sendInput,
  agents,
  status,
} from './ws';

// Base64 decode (same approach as desktop)
const B64 = new Uint8Array(128);
for (let i = 0; i < 64; i++) {
  B64['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
}

function b64decode(b64: string): Uint8Array {
  let end = b64.length;
  while (end > 0 && b64.charCodeAt(end - 1) === 61) end--;
  const out = new Uint8Array((end * 3) >>> 2);
  let j = 0;
  for (let i = 0; i < end; ) {
    const a = B64[b64.charCodeAt(i++)];
    const b = i < end ? B64[b64.charCodeAt(i++)] : 0;
    const c = i < end ? B64[b64.charCodeAt(i++)] : 0;
    const d = i < end ? B64[b64.charCodeAt(i++)] : 0;
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;
    out[j++] = (triplet >>> 16) & 0xff;
    if (j < out.length) out[j++] = (triplet >>> 8) & 0xff;
    if (j < out.length) out[j++] = triplet & 0xff;
  }
  return out;
}

// Build control characters at runtime via lookup — avoids Vite stripping \r during build
const KEYS: Record<number, string> = {};
[3, 4, 13, 27].forEach((c) => {
  KEYS[c] = String.fromCharCode(c);
});
function key(c: number): string {
  return KEYS[c];
}

interface AgentDetailProps {
  agentId: string;
  taskName: string;
  onBack: () => void;
}

export function AgentDetail(props: AgentDetailProps) {
  let termContainer: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  const [inputText, setInputText] = createSignal('');
  const [atBottom, setAtBottom] = createSignal(true);
  const [termFontSize, setTermFontSize] = createSignal(10);

  const MIN_FONT = 6;
  const MAX_FONT = 24;

  const agentInfo = () => agents().find((a) => a.agentId === props.agentId);

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
      scrollback: 5000,
      cursorBlink: false,
      disableStdin: true,
      convertEol: false,
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

    const cleanupScrollback = onScrollback(props.agentId, (data, cols) => {
      if (term && cols > 0) {
        term.resize(cols, term.rows);
      }
      // Clear before writing — on reconnect the server re-sends the full
      // scrollback buffer, so we must avoid duplicate content.
      term?.clear();
      const bytes = b64decode(data);
      term?.write(bytes, () => term?.scrollToBottom());
    });

    const cleanupOutput = onOutput(props.agentId, (data) => {
      const bytes = b64decode(data);
      term?.write(bytes);
    });

    subscribeAgent(props.agentId);

    let resizeRaf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => fitAddon?.fit());
    });
    observer.observe(termContainer);

    // Refit terminal when soft keyboard opens/closes on mobile
    if (window.visualViewport) {
      const onViewportResize = () => fitAddon?.fit();
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
            'font-size': '16px',
            cursor: 'pointer',
            padding: '8px 10px',
            'touch-action': 'manipulation',
          }}
        >
          &#8592; Back
        </button>
        <span
          style={{
            'font-size': '14px',
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

      {/* Connection status banner */}
      <Show when={status() !== 'connected'}>
        <div
          style={{
            padding: '6px 16px',
            background: status() === 'connecting' ? '#78350f' : '#7f1d1d',
            color: status() === 'connecting' ? '#fde68a' : '#fca5a5',
            'font-size': '12px',
            'text-align': 'center',
            'flex-shrink': '0',
          }}
        >
          {status() === 'connecting' ? 'Reconnecting...' : 'Disconnected — check your network'}
        </div>
      </Show>

      {/* Terminal — overflow:hidden clips xterm.js overlays so they don't
           capture touch events over the header/input areas */}
      <div
        ref={termContainer}
        style={{
          flex: '1',
          'min-height': '0',
          padding: '4px',
          position: 'relative',
          overflow: 'hidden',
        }}
      />

      {/* Scroll to bottom FAB */}
      <Show when={!atBottom()}>
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
            'font-size': '16px',
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
          display: 'flex',
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
              'font-size': '14px',
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
              { label: '\u2191', data: () => key(27) + '[A' },
              { label: '\u2193', data: () => key(27) + '[B' },
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
                  'font-size': '13px',
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
              onClick={() => {
                const next = Math.max(MIN_FONT, termFontSize() - 1);
                setTermFontSize(next);
                if (term) {
                  term.options.fontSize = next;
                  fitAddon?.fit();
                }
              }}
              disabled={termFontSize() <= MIN_FONT}
              style={{
                background: '#1a2430',
                border: '1px solid #223040',
                'border-radius': '8px',
                padding: '10px 14px',
                color: termFontSize() <= MIN_FONT ? '#344050' : '#9bb0c3',
                'font-size': '13px',
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
              onClick={() => {
                const next = Math.min(MAX_FONT, termFontSize() + 1);
                setTermFontSize(next);
                if (term) {
                  term.options.fontSize = next;
                  fitAddon?.fit();
                }
              }}
              disabled={termFontSize() >= MAX_FONT}
              style={{
                background: '#1a2430',
                border: '1px solid #223040',
                'border-radius': '8px',
                padding: '10px 14px',
                color: termFontSize() >= MAX_FONT ? '#344050' : '#9bb0c3',
                'font-size': '13px',
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
