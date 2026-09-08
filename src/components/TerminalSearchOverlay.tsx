import { onMount, type JSX } from 'solid-js';
import { CloseIcon } from './icons';

export interface TerminalSearchOverlayProps {
  query: string;
  /** 0-based index of the active match, or -1 when none / not computed. */
  resultIndex: number;
  resultCount: number;
  onInput: (value: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /** Hands the input element back to the owner so it can refocus on reopen. */
  setInputRef: (el: HTMLInputElement) => void;
}

const ICON_BUTTON_STYLE: JSX.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--fg-subtle)',
  cursor: 'pointer',
  'font-size': '13px',
  'line-height': '1',
  padding: '2px 5px',
  'border-radius': 'var(--radius-xs)',
};

/** Browser-style find bar for a single terminal pane. Purely presentational —
 *  the owning TerminalView drives the xterm search addon and feeds results back
 *  in through props. */
export function TerminalSearchOverlay(props: TerminalSearchOverlayProps): JSX.Element {
  let inputRef!: HTMLInputElement;

  onMount(() => {
    inputRef.focus();
    inputRef.select();
  });

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) props.onPrev();
      else props.onNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Defensive: the app's window-level Esc handler already ignores keys while
      // an input is focused, but stop propagation anyway so this Esc only ever
      // closes the find bar — never an enclosing panel.
      e.stopPropagation();
      props.onClose();
    }
  }

  const countLabel = () => {
    if (props.query === '') return '';
    if (props.resultCount === 0) return 'No results';
    // Some buffers report a count without a resolved active index — show the
    // total rather than a misleading "0/N".
    if (props.resultIndex < 0) return `${props.resultCount}`;
    return `${props.resultIndex + 1}/${props.resultCount}`;
  };

  const hasNoMatches = () => props.query !== '' && props.resultCount === 0;

  // Clicking a button must not steal focus from the input, so the user can keep
  // typing and pressing Enter after stepping through matches.
  const keepInputFocus = (e: MouseEvent) => e.preventDefault();

  return (
    <div
      style={{
        position: 'absolute',
        top: '6px',
        right: '10px',
        'z-index': '6',
        display: 'flex',
        'align-items': 'center',
        gap: '2px',
        padding: '4px 6px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        'border-radius': 'var(--radius-sm)',
        'box-shadow': '0 2px 8px rgba(0, 0, 0, 0.35)',
        'font-family': 'var(--font-ui)',
      }}
    >
      <input
        ref={(el) => {
          inputRef = el;
          props.setInputRef(el);
        }}
        type="text"
        placeholder="Find"
        spellcheck={false}
        autocomplete="off"
        value={props.query}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        style={{
          width: '160px',
          padding: '2px 6px',
          background: 'var(--bg-input)',
          border: '1px solid var(--border)',
          'border-radius': 'var(--radius-xs)',
          color: hasNoMatches() ? 'var(--error)' : 'var(--fg)',
          'font-family': 'var(--font-ui)',
          'font-size': '12px',
          outline: 'none',
        }}
      />
      <span
        style={{
          'min-width': '52px',
          'text-align': 'right',
          padding: '0 4px',
          'font-size': '11px',
          color: 'var(--fg-subtle)',
          'white-space': 'nowrap',
        }}
      >
        {countLabel()}
      </span>
      <button
        type="button"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        onMouseDown={keepInputFocus}
        onClick={() => props.onPrev()}
        style={ICON_BUTTON_STYLE}
      >
        ↑
      </button>
      <button
        type="button"
        title="Next match (Enter)"
        aria-label="Next match"
        onMouseDown={keepInputFocus}
        onClick={() => props.onNext()}
        style={ICON_BUTTON_STYLE}
      >
        ↓
      </button>
      <button
        type="button"
        title="Close (Esc)"
        aria-label="Close search"
        onMouseDown={keepInputFocus}
        onClick={() => props.onClose()}
        style={ICON_BUTTON_STYLE}
      >
        <CloseIcon size={13} />
      </button>
    </div>
  );
}
