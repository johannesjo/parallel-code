import type { TaskAttentionState, TaskDotStatus } from '../store/taskStatus';
import { theme } from '../lib/theme';

const SIZES = { sm: 6, md: 8 } as const;
/** Fixed lane so task names line up whatever glyph sits in front of them. */
const LANES = { sm: 12, md: 14 } as const;
const SPINNERS = { sm: 10, md: 12 } as const;
const REVIEW_COLOR = theme.review;

/** Shape carries the state, colour only reinforces it — a scan of the list
 *  should separate "spinning", "asking", and "resting" without reading hue. */
type StatusGlyph = 'spinner' | 'question' | 'dot';

function getDotColor(status: TaskDotStatus, attention?: TaskAttentionState): string {
  if (attention === 'active') return theme.accent;
  if (attention === 'needs_input') return theme.warning;
  if (attention === 'error') return theme.error;
  if (attention === 'review') return REVIEW_COLOR;
  if (attention === 'ready') return theme.success;
  // Amber is reserved for "needs you"; a task with nothing to report is quiet.
  return {
    busy: theme.fgMuted,
    waiting: theme.fgSubtle,
    ready: theme.success,
    review: REVIEW_COLOR,
  }[status];
}

function getDotShadow(attention?: TaskAttentionState): string | undefined {
  if (!attention || attention === 'idle' || attention === 'ready') return undefined;
  const color =
    attention === 'active'
      ? theme.accent
      : attention === 'needs_input'
        ? theme.warning
        : attention === 'review'
          ? REVIEW_COLOR
          : theme.error;
  return `0 0 0 2px color-mix(in srgb, ${color} 22%, transparent)`;
}

export function getDotTooltip(status: TaskDotStatus, attention?: TaskAttentionState): string {
  if (attention === 'active') return 'Active — agent is working';
  if (attention === 'needs_input') return 'Waiting for input';
  if (attention === 'error') return 'Error — agent exited with an error';
  // Without this, a review-flagged task whose agent is still active falls
  // through to the dot-status map and reads "Busy" under a purple dot.
  if (attention === 'review') return 'Ready for review';
  if (attention === 'ready') return 'Ready to merge';
  return {
    busy: 'Busy — agent recently active',
    waiting: 'Waiting — no changes yet',
    ready: 'Ready to merge',
    review: 'Ready for review',
  }[status];
}

export function getStatusGlyph(status: TaskDotStatus, attention?: TaskAttentionState): StatusGlyph {
  if (attention === 'needs_input') return 'question';
  // Error and review outrank activity in the attention state, so a busy task
  // in either shows that state's dot rather than a spinner in its colour.
  if (attention === 'active' || (status === 'busy' && !attention)) return 'spinner';
  return 'dot';
}

export function StatusDot(props: {
  status: TaskDotStatus;
  size?: 'sm' | 'md';
  attention?: TaskAttentionState;
}) {
  const size = () => props.size ?? 'sm';
  const glyph = () => getStatusGlyph(props.status, props.attention);
  const color = () => getDotColor(props.status, props.attention);
  return (
    <span
      class="status-glyph"
      title={getDotTooltip(props.status, props.attention)}
      style={{
        // Lane size travels as a variable so a host row can restyle the box —
        // the sidebar shrinks it to one text line to keep it off wrapped names.
        '--glyph-lane': `${LANES[size()]}px`,
        color: color(),
      }}
    >
      {glyph() === 'spinner' ? (
        <span
          class="status-glyph-spinner"
          style={{ width: `${SPINNERS[size()]}px`, height: `${SPINNERS[size()]}px` }}
        />
      ) : glyph() === 'question' ? (
        <span
          class="status-glyph-question"
          style={{
            width: `${SPINNERS[size()]}px`,
            height: `${SPINNERS[size()]}px`,
            'line-height': `${SPINNERS[size()]}px`,
            'font-size': `${SPINNERS[size()] - 2}px`,
            background: color(),
            color: theme.bg,
            'box-shadow': getDotShadow(props.attention),
          }}
        >
          ?
        </span>
      ) : (
        <span
          style={{
            display: 'inline-block',
            width: `${SIZES[size()]}px`,
            height: `${SIZES[size()]}px`,
            'border-radius': '50%',
            background: color(),
            'box-shadow': getDotShadow(props.attention),
          }}
        />
      )}
    </span>
  );
}
