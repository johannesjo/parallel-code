import {
  getReadyLabel,
  getTaskActivityTooltip,
  type TaskAttentionState,
  type TaskDotStatus,
} from '../store/taskStatus';
import { getCiGlyphState, type CiGlyphState } from '../store/pr-checks-state';
import { StatusCheckIcon } from './icons';
import { theme } from '../lib/theme';

const SIZES = { sm: 6, md: 8 } as const;
/** Fixed lane so task names line up whatever glyph sits in front of them. */
const LANES = { sm: 12, md: 14 } as const;
const SPINNERS = { sm: 10, md: 12 } as const;
const REVIEW_COLOR = theme.review;

/** Shape carries the state, colour only reinforces it — a scan of the list
 *  should separate "spinning", "asking", and "resting" without reading hue:
 *  motion means working, a filled badge needs you, an outline is at rest. */
type StatusGlyph =
  | 'spinner'
  | 'question'
  | 'error'
  | 'review'
  | 'ready'
  | 'waiting'
  | 'dot'
  | 'ci_running'
  | 'ci_failed';
/** Keeps the CI pie visible before any check has finished. */
const MIN_CI_SWEEP = 12;

function getDotColor(status: TaskDotStatus, attention?: TaskAttentionState): string {
  if (attention === 'active') return theme.accent;
  // Muted, not accented: a terminal is running, but nothing is waiting on you.
  if (attention === 'shell_busy') return theme.fgMuted;
  if (attention === 'needs_input') return theme.warning;
  if (attention === 'error') return theme.error;
  if (attention === 'review') return REVIEW_COLOR;
  if (attention === 'ready') return theme.success;
  // The warning hue is reserved for "needs you"; a task with nothing to report is quiet.
  return {
    busy: theme.fgMuted,
    waiting: theme.fgSubtle,
    ready: theme.success,
    review: REVIEW_COLOR,
  }[status];
}

function halo(color: string): string {
  return `0 0 0 2px color-mix(in srgb, ${color} 22%, transparent)`;
}

function getDotShadow(attention?: TaskAttentionState): string | undefined {
  if (!attention || attention === 'idle' || attention === 'ready' || attention === 'shell_busy')
    return undefined;
  const color =
    attention === 'active'
      ? theme.accent
      : attention === 'needs_input'
        ? theme.warning
        : attention === 'review'
          ? REVIEW_COLOR
          : theme.error;
  return halo(color);
}

function getCiTooltip(ci: CiGlyphState): string {
  if (ci.state === 'failed') return `CI failed — ${ci.failing} of ${ci.total} checks failing`;
  // Checks may not have registered yet; "0 of 0 done" would read as broken.
  if (ci.total === 0) return 'CI running';
  const failing = ci.failing ? `, ${ci.failing} failing` : '';
  return `CI running — ${ci.done} of ${ci.total} checks done${failing}`;
}

export function getDotTooltip(
  status: TaskDotStatus,
  attention?: TaskAttentionState,
  taskId?: string,
): string {
  const readyLabel = () => (taskId ? getReadyLabel(taskId) : 'Ready');
  const ci = taskId ? getCiGlyphState(taskId) : undefined;
  const glyph = ci ? getStatusGlyph(status, attention, ci.state) : undefined;
  if (ci && (glyph === 'ci_running' || glyph === 'ci_failed')) return getCiTooltip(ci);
  if (attention === 'active') return 'Active — agent is working';
  if (attention === 'shell_busy') return 'Terminal busy — no agent working';
  if (attention === 'needs_input') return 'Waiting for input';
  if (attention === 'error') return 'Error — an agent exited or its turn failed';
  // Without this, a review-flagged task whose agent is still active falls
  // through to the dot-status map and reads "Busy" under a purple dot.
  if (attention === 'review') return 'Ready for review';
  if (attention === 'ready') return readyLabel();
  if (status === 'ready') return readyLabel();
  return {
    busy: 'Busy — agent recently active',
    waiting: 'Waiting — no changes yet',
    review: 'Ready for review',
  }[status];
}

export function getStatusGlyph(
  status: TaskDotStatus,
  attention?: TaskAttentionState,
  ci?: CiGlyphState['state'],
): StatusGlyph {
  if (attention === 'needs_input') return 'question';
  if (attention === 'error') return 'error';
  if (attention === 'active') return 'spinner';
  // CI outranks resting states and shell activity but not a working agent:
  // that agent is often the one fixing CI, and the CI glyph returns when it stops.
  if (ci === 'failed') return 'ci_failed';
  if (ci === 'running') return 'ci_running';
  // Review outranks activity in the attention state, so a busy task under
  // review shows the review ring rather than a spinner in its colour.
  if (attention === 'shell_busy' || (status === 'busy' && !attention)) return 'spinner';
  // Same precedence as the colour: a resting attention state beats the dot status.
  const resting = attention === 'review' || attention === 'ready' ? attention : status;
  if (resting === 'review') return 'review';
  if (resting === 'ready') return 'ready';
  // Hollow: nothing has happened yet, so it must not read as a grey Ready.
  if (resting === 'waiting') return 'waiting';
  return 'dot';
}

export function StatusDot(props: {
  status: TaskDotStatus;
  size?: 'sm' | 'md';
  attention?: TaskAttentionState;
  taskId?: string;
  /** False when the host shows its own hover label; the aria-label stays either way. */
  nativeTitle?: boolean;
  /** A running check to show instead, as a review-coloured spinner; the host
   *  decides when it outranks the task's own state. */
  checking?: string;
}) {
  const size = () => props.size ?? 'sm';
  const ci = () => (props.taskId ? getCiGlyphState(props.taskId) : undefined);
  const glyph = (): StatusGlyph =>
    props.checking ? 'spinner' : getStatusGlyph(props.status, props.attention, ci()?.state);
  const tooltip = () =>
    props.checking || getDotTooltip(props.status, props.attention, props.taskId);
  const color = () => {
    if (props.checking) return REVIEW_COLOR;
    if (glyph() === 'ci_failed') return theme.error;
    // A running pie is a routine wait, so it stays neutral; a failed check turns it red early.
    if (glyph() === 'ci_running') return ci()?.failing ? theme.error : theme.fgMuted;
    return getDotColor(props.status, props.attention);
  };
  const ciSweep = () => Math.max(MIN_CI_SWEEP, ci()?.progress ?? 0);
  const badge = (char: string, shadow: string | undefined) => (
    <span
      class="status-glyph-question"
      style={{
        width: `${SPINNERS[size()]}px`,
        height: `${SPINNERS[size()]}px`,
        'line-height': `${SPINNERS[size()]}px`,
        'font-size': `${SPINNERS[size()] - 2}px`,
        background: color(),
        color: theme.bg,
        'box-shadow': shadow,
      }}
    >
      {char}
    </span>
  );
  return (
    <span
      class="status-glyph"
      role="img"
      aria-label={tooltip()}
      title={
        props.nativeTitle === false
          ? undefined
          : [tooltip(), props.taskId ? getTaskActivityTooltip(props.taskId) : undefined]
              .filter(Boolean)
              .join('\n')
      }
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
        badge('?', getDotShadow(props.attention))
      ) : glyph() === 'error' ? (
        badge('!', getDotShadow(props.attention))
      ) : glyph() === 'review' ? (
        <span
          class="status-glyph-review"
          style={{
            width: `${SPINNERS[size()] - 1}px`,
            height: `${SPINNERS[size()] - 1}px`,
            'box-shadow': getDotShadow(props.attention),
          }}
        />
      ) : glyph() === 'ready' ? (
        <StatusCheckIcon class="status-glyph-ready" size={SPINNERS[size()]} />
      ) : glyph() === 'waiting' ? (
        <span
          class="status-glyph-waiting"
          style={{ width: `${SIZES[size()] + 1}px`, height: `${SIZES[size()] + 1}px` }}
        />
      ) : glyph() === 'ci_failed' ? (
        badge('×', halo(theme.error))
      ) : glyph() === 'ci_running' ? (
        <span
          class="status-glyph-ci"
          style={{
            width: `${SPINNERS[size()]}px`,
            height: `${SPINNERS[size()]}px`,
            '--ci-sweep': `${ciSweep()}%`,
          }}
        />
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
