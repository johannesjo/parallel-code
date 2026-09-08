import { Show, createMemo } from 'solid-js';
import { getTaskCurrentState } from '../lib/task-current-state';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import type { Task } from '../store/types';

interface TaskCurrentStateLineProps {
  task: Pick<Task, 'stepsEnabled' | 'stepsContent'>;
  nowMs: number;
  variant: 'sidebar' | 'card';
}

function compactFreshness(freshness: string, stale: boolean): string {
  if (freshness === 'update time unavailable') return '?';
  if (stale) return `${freshness.replace(/^no update /, '')} stale`;
  return freshness.replace(/^updated /, '').replace(/ ago$/, '');
}

export function TaskCurrentStateLine(props: TaskCurrentStateLineProps) {
  const state = createMemo(() => getTaskCurrentState(props.task, props.nowMs));
  const label = () => {
    const current = state();
    if (!current) return '';
    return `${current.phase}: ${current.summary}${current.freshness ? `, ${current.freshness}` : ''}`;
  };

  return (
    <Show when={state()}>
      {(current) => (
        <div
          class={`task-current-state task-current-state-${props.variant}${current().stale ? ' is-stale' : ''}`}
          aria-label={label()}
          title={label()}
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: props.variant === 'card' ? '6px' : '5px',
            'min-width': '0',
            height: props.variant === 'card' ? '24px' : undefined,
            // The sidebar variant is indented by the row itself, which knows
            // how many glyphs sit in front of the title.
            padding: props.variant === 'card' ? '0 12px' : undefined,
            background: props.variant === 'card' ? theme.bgSelectedSubtle : 'transparent',
            'border-bottom': props.variant === 'card' ? `1px solid ${theme.border}` : undefined,
            color: props.variant === 'card' ? theme.fgMuted : theme.fgSubtle,
            'font-size': props.variant === 'card' ? sf(11) : sf(10),
            'line-height': '1.4',
            overflow: 'hidden',
            'white-space': 'nowrap',
          }}
        >
          <span
            style={{
              color: props.variant === 'card' ? theme.fg : theme.fgMuted,
              'font-weight': props.variant === 'card' ? '600' : '500',
              'flex-shrink': '0',
            }}
          >
            {current().phase}
          </span>
          <span aria-hidden="true" style={{ color: theme.fgSubtle, 'flex-shrink': '0' }}>
            ·
          </span>
          <span
            style={{
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'min-width': '0',
              flex: '1',
            }}
          >
            {current().summary}
          </span>
          <Show when={current().freshness}>
            {(freshness) => (
              <span
                style={{
                  // Only a stale timestamp earns its own colour; otherwise it
                  // rides the line's own, quieter than the summary beside it.
                  color: current().stale ? theme.warning : undefined,
                  'flex-shrink': '0',
                }}
              >
                {props.variant === 'sidebar'
                  ? compactFreshness(freshness(), current().stale)
                  : freshness()}
              </span>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
