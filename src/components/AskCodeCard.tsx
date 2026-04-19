import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { Channel, invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';

interface AskCodeCardProps {
  requestId: string;
  question: string;
  filePath: string;
  startLine: number;
  endLine: number;
  selectedText: string;
  worktreePath: string;
  onDismiss: () => void;
}

interface AskCodeMessage {
  type: 'chunk' | 'error' | 'done';
  text?: string;
  exitCode?: number;
}

const MAX_RESPONSE_LENGTH = 100_000;

export function AskCodeCard(props: AskCodeCardProps) {
  const [response, setResponse] = createSignal('');
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(true);

  const channel = new Channel<AskCodeMessage>();

  channel.onmessage = (msg) => {
    if (msg.type === 'chunk') {
      setResponse((prev) => {
        if (prev.length >= MAX_RESPONSE_LENGTH) return prev;
        const next = prev + (msg.text ?? '');
        if (next.length >= MAX_RESPONSE_LENGTH) {
          return next.slice(0, MAX_RESPONSE_LENGTH) + '\n\n[Response truncated]';
        }
        return next;
      });
    } else if (msg.type === 'error') {
      setError((prev) => prev + (msg.text ?? ''));
    } else if (msg.type === 'done') {
      setLoading(false);
    }
  };

  onMount(() => {
    // Build prompt with actual code context
    const lang = props.filePath.split('.').pop() ?? '';
    const lineRef =
      props.startLine === props.endLine
        ? `line ${props.startLine}`
        : `lines ${props.startLine}-${props.endLine}`;
    const prompt = `In file ${props.filePath}, ${lineRef}:\n\n\`\`\`${lang}\n${props.selectedText}\n\`\`\`\n\n${props.question}`;

    invoke(IPC.AskAboutCode, {
      requestId: props.requestId,
      prompt,
      cwd: props.worktreePath,
      onOutput: channel,
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    });
  });

  function cancel() {
    invoke(IPC.CancelAskAboutCode, { requestId: props.requestId }).catch(() => {});
    channel.cleanup?.();
  }

  function dismiss() {
    cancel();
    props.onDismiss();
  }

  onCleanup(cancel);

  return (
    <div
      style={{
        margin: '4px 40px 4px 80px',
        border: `1px solid ${theme.border}`,
        'border-left': `3px solid ${theme.accent}`,
        'border-radius': '4px',
        background: theme.bgElevated,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          padding: '4px 10px',
          'border-bottom': `1px solid ${theme.borderSubtle}`,
          background: 'rgba(255,255,255,0.03)',
        }}
      >
        <span
          style={{
            'font-size': sf(12),
            color: theme.fgMuted,
            'font-family': "'JetBrains Mono', monospace",
          }}
        >
          Q: {props.question}
        </span>
        <button
          onClick={dismiss}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: 'pointer',
            padding: '2px 4px',
            'border-radius': '3px',
            'font-size': sf(15),
            'line-height': '1',
          }}
          title="Dismiss"
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div
        style={{
          padding: '8px 12px',
          'font-size': sf(13),
          'font-family': "'JetBrains Mono', monospace",
          'line-height': '1.5',
          color: theme.fg,
          'white-space': 'pre-wrap',
          'word-break': 'break-word',
          'max-height': '300px',
          'overflow-y': 'auto',
        }}
      >
        <Show when={loading() && !response()}>
          <span
            style={{
              color: theme.fgSubtle,
              animation: 'askcode-pulse 1.5s ease-in-out infinite',
            }}
          >
            Thinking...
          </span>
        </Show>
        <Show when={response()}>{response()}</Show>
        <Show when={loading() && response()}>
          <span
            style={{
              color: theme.accent,
              'font-size': sf(11),
              animation: 'askcode-pulse 1s ease-in-out infinite',
            }}
          >
            {' '}
            ●
          </span>
        </Show>
        <Show when={error()}>
          <div style={{ color: theme.error, 'margin-top': '4px' }}>{error()}</div>
        </Show>
      </div>
    </div>
  );
}
