import { Show, onMount } from 'solid-js';
import { bannerStyle, theme } from '../lib/theme';
import type { PushRun } from './push-run';

/** The push option of the finish dialog: live output and errors of a push. */
export function PushSection(props: { run: PushRun }) {
  let outputRef: HTMLPreElement | undefined;
  onMount(() =>
    props.run.onOutput(() =>
      requestAnimationFrame(() => {
        if (outputRef) outputRef.scrollTop = outputRef.scrollHeight;
      }),
    ),
  );
  return (
    <>
      <Show when={props.run.pushing() || props.run.output()}>
        <pre
          ref={outputRef}
          style={{
            margin: '0',
            'font-family': "'JetBrains Mono', monospace",
            'font-size': '12px',
            'line-height': '1.5',
            'white-space': 'pre-wrap',
            'word-break': 'break-all',
            padding: '8px 12px',
            'max-height': '200px',
            'overflow-y': 'auto',
            background: theme.bgInput,
            'border-radius': 'var(--radius-md)',
            border: `1px solid ${theme.border}`,
            color: theme.fgMuted,
          }}
        >
          {props.run.output() || 'Pushing...'}
        </pre>
      </Show>
      <Show when={props.run.error()}>
        <div style={{ ...bannerStyle(theme.error), 'margin-top': '12px', 'font-size': '13px' }}>
          {props.run.error()}
        </div>
      </Show>
    </>
  );
}
