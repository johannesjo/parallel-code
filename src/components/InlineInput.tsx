import { createSignal, onMount } from 'solid-js';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import type { DiffInteractionMode } from './review-types';

interface InlineInputProps {
  onSubmit: (text: string, mode: DiffInteractionMode) => void;
  onDismiss: () => void;
}

export function InlineInput(props: InlineInputProps) {
  const [text, setText] = createSignal('');
  const [mode, setMode] = createSignal<DiffInteractionMode>('review');
  let inputRef: HTMLInputElement | undefined;

  onMount(() => {
    requestAnimationFrame(() => inputRef?.focus());
  });

  const borderColor = () => (mode() === 'review' ? theme.warning : theme.accent);
  const placeholder = () =>
    mode() === 'review' ? 'Add review comment...' : 'Ask about this code...';

  function submit() {
    const t = text().trim();
    if (t) props.onSubmit(t, mode());
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape') {
      props.onDismiss();
    }
  }

  return (
    <div
      onMouseUp={(e) => e.stopPropagation()}
      style={{
        margin: '4px 40px 4px 80px',
        'max-width': '560px',
        display: 'flex',
        gap: '4px',
        padding: '4px',
        background: theme.bgElevated,
        border: `1px solid ${theme.border}`,
        'border-left': `3px solid ${borderColor()}`,
        'border-radius': '4px',
      }}
    >
      {/* Mode toggle */}
      <div
        style={{
          display: 'flex',
          'border-radius': '3px',
          overflow: 'hidden',
          border: `1px solid ${theme.borderSubtle}`,
          'flex-shrink': '0',
          'align-self': 'center',
        }}
      >
        <button
          onClick={() => setMode('review')}
          style={{
            background: mode() === 'review' ? theme.warning : 'transparent',
            color: mode() === 'review' ? theme.accentText : theme.fgMuted,
            border: 'none',
            'font-size': sf(11),
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          Comment
        </button>
        <button
          onClick={() => setMode('ask')}
          style={{
            background: mode() === 'ask' ? theme.accent : 'transparent',
            color: mode() === 'ask' ? theme.accentText : theme.fgMuted,
            border: 'none',
            'font-size': sf(11),
            padding: '2px 8px',
            cursor: 'pointer',
          }}
        >
          Ask
        </button>
      </div>

      {/* Text input */}
      <input
        ref={inputRef}
        type="text"
        placeholder={placeholder()}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        style={{
          flex: '1',
          background: theme.bgInput,
          border: `1px solid ${theme.borderSubtle}`,
          'border-radius': '4px',
          color: theme.fg,
          'font-size': sf(13),
          'font-family': "'JetBrains Mono', monospace",
          padding: '4px 8px',
          outline: 'none',
        }}
      />

      {/* Submit button */}
      <button
        onClick={submit}
        disabled={!text().trim()}
        style={{
          background: text().trim() ? borderColor() : 'transparent',
          border: `1px solid ${text().trim() ? borderColor() : theme.borderSubtle}`,
          color: text().trim() ? theme.accentText : theme.fgMuted,
          cursor: text().trim() ? 'pointer' : 'default',
          padding: '4px 10px',
          'border-radius': '4px',
          'font-size': sf(12),
          'font-weight': '600',
        }}
      >
        {mode() === 'review' ? 'Comment' : 'Ask'}
      </button>
    </div>
  );
}
