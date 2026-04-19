import type { TaskAttentionState, TaskDotStatus } from '../store/taskStatus';
import { theme } from '../lib/theme';

const SIZES = { sm: 6, md: 8 } as const;

function getDotColor(status: TaskDotStatus, attention?: TaskAttentionState): string {
  if (attention === 'active') return theme.accent;
  if (attention === 'needs_input') return theme.warning;
  if (attention === 'error') return theme.error;
  if (attention === 'ready') return theme.success;
  return { busy: theme.fgMuted, waiting: '#e5a800', ready: theme.success, review: '#c084fc' }[
    status
  ];
}

function getDotShadow(attention?: TaskAttentionState): string | undefined {
  if (!attention || attention === 'idle' || attention === 'ready') return undefined;
  const color =
    attention === 'active'
      ? theme.accent
      : attention === 'needs_input'
        ? theme.warning
        : theme.error;
  return `0 0 0 2px color-mix(in srgb, ${color} 22%, transparent)`;
}

export function StatusDot(props: {
  status: TaskDotStatus;
  size?: 'sm' | 'md';
  attention?: TaskAttentionState;
}) {
  const px = () => SIZES[props.size ?? 'sm'];
  const isPulsing = () => props.attention === 'active' || props.status === 'busy';
  return (
    <span
      class={isPulsing() ? 'status-dot-pulse' : undefined}
      style={{
        display: 'inline-block',
        width: `${px()}px`,
        height: `${px()}px`,
        'border-radius': '50%',
        background: getDotColor(props.status, props.attention),
        'box-shadow': getDotShadow(props.attention),
        'flex-shrink': '0',
      }}
    />
  );
}
