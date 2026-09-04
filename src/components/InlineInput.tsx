import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store } from '../store/store';
import { warn as logWarn } from '../lib/log';
import type { DiffInteractionMode } from './review-types';
import { isSupportedAskCodeImagePath } from './ask-code-image';

interface InlineInputProps {
  onSubmit: (text: string, mode: DiffInteractionMode, imagePaths?: string[]) => void;
  onDismiss: () => void;
}

/** Shape of the resolved clipboard content returned by the main process. */
interface ResolvedPaste {
  kind: string;
  path?: string;
}

export function InlineInput(props: InlineInputProps) {
  const [text, setText] = createSignal('');
  const [mode, setMode] = createSignal<DiffInteractionMode>('review');
  const [imagePaths, setImagePaths] = createSignal<string[]>([]);
  const [imagePasteHint, setImagePasteHint] = createSignal('');
  let inputRef: HTMLInputElement | undefined;

  /** Images are only sent to a provider whose model accepts image input. */
  const imageInputEnabled = () => mode() === 'ask' && store.askCodeProvider === 'minimax';

  onMount(() => {
    requestAnimationFrame(() => inputRef?.focus());
    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        props.onDismiss();
      }
    };
    document.addEventListener('keydown', onGlobalKeyDown, true);
    onCleanup(() => document.removeEventListener('keydown', onGlobalKeyDown, true));
  });

  const borderColor = () => (mode() === 'review' ? theme.warning : theme.accent);
  const placeholder = () =>
    mode() === 'review' ? 'Add review comment...' : 'Ask about this code...';

  function submit() {
    const t = text().trim();
    if (!t) return;
    props.onSubmit(t, mode(), imageInputEnabled() ? imagePaths() : undefined);
  }

  /**
   * Attaches a pasted image to the question. The main process already turns
   * clipboard images into temp files, so the same path is reused here.
   */
  function handlePaste(e: ClipboardEvent) {
    if (store.askCodeProvider !== 'minimax') return;
    const hasImage = Array.from(e.clipboardData?.items ?? []).some((item) =>
      item.type.startsWith('image/'),
    );
    if (!hasImage) return;

    e.preventDefault();
    setImagePasteHint('');
    invoke<ResolvedPaste>(IPC.ResolveClipboardPaste)
      .then((paste) => {
        if (
          paste.path &&
          (paste.kind === 'image' ||
            (paste.kind === 'file' && isSupportedAskCodeImagePath(paste.path)))
        ) {
          const attached = paste.path;
          setImagePaths((prev) => (prev.includes(attached) ? prev : [...prev, attached]));
        } else {
          setImagePasteHint('Only PNG, JPEG, WEBP, and GIF images can be attached.');
        }
      })
      .catch((err: unknown) => {
        logWarn('askCode.paste', 'ResolveClipboardPaste failed', { err });
        setImagePasteHint('Could not attach the clipboard image.');
      });
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
        onPaste={handlePaste}
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

      {/* Attached images */}
      <Show when={store.askCodeProvider === 'minimax' && imagePaths().length > 0}>
        <button
          onClick={() => setImagePaths([])}
          title="Remove attached images"
          style={{
            background: 'transparent',
            border: `1px solid ${theme.borderSubtle}`,
            color: theme.fgMuted,
            cursor: 'pointer',
            padding: '4px 8px',
            'border-radius': '4px',
            'font-size': sf(11),
            'white-space': 'nowrap',
            'align-self': 'center',
          }}
        >
          {imagePaths().length === 1 ? '1 image ×' : `${imagePaths().length} images ×`}
        </button>
      </Show>

      <Show when={imagePasteHint()}>
        {(hint) => (
          <span
            aria-live="polite"
            style={{ color: theme.warning, 'font-size': sf(11), 'align-self': 'center' }}
          >
            {hint()}
          </span>
        )}
      </Show>

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

      {/* Cancel button */}
      <button
        onClick={() => props.onDismiss()}
        title="Cancel (Esc)"
        aria-label="Cancel"
        style={{
          background: 'transparent',
          border: `1px solid ${theme.borderSubtle}`,
          color: theme.fgMuted,
          cursor: 'pointer',
          padding: '4px 8px',
          'border-radius': '4px',
          'font-size': sf(14),
          'line-height': '1',
          'align-self': 'center',
        }}
      >
        &times;
      </button>
    </div>
  );
}
