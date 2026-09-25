import { createSignal, Show, type JSX } from 'solid-js';
import { dismissSpBanner, showNotification, spBanner, trackTaskInSp } from '../store/store';
import { theme } from '../lib/theme';
import type { SpBanner } from '../store/superProductivity';

const bannerBtnStyle: JSX.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${theme.info}`,
  'border-radius': 'var(--radius-xs)',
  padding: '1px 8px',
  color: theme.info,
  cursor: 'pointer',
  'font-family': 'inherit',
  'font-size': '11px',
  'flex-shrink': '0',
};

function bannerText(banner: SpBanner): JSX.Element {
  switch (banner.reason) {
    case 'other_task':
      return (
        <>
          Super Productivity is tracking <strong>{banner.trackingTitle || 'another task'}</strong>.
        </>
      );
    case 'break':
      return <>Super Productivity is on a break.</>;
    case 'done':
      return <>This task is marked done in Super Productivity; tracking it reopens it there.</>;
    case 'missing':
      return (
        <>
          This task's Super Productivity task was archived or deleted; tracking creates a new one.
        </>
      );
  }
}

/** Shown on the focused task when focusing it did not move Super
 *  Productivity's time tracking, because that would take over something the
 *  user chose there. */
export function TaskSuperProductivityBanner(props: { taskId: string }) {
  const [pending, setPending] = createSignal(false);
  const banner = () => {
    const current = spBanner();
    return current?.taskId === props.taskId ? current : null;
  };

  async function track() {
    if (pending()) return;
    setPending(true);
    try {
      // Creating the task over there can take a while; say when it fails.
      if (!(await trackTaskInSp(props.taskId))) {
        showNotification('Could not start tracking in Super Productivity');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Show when={banner()}>
      {(current) => (
        <div
          class="task-super-productivity-banner"
          role="status"
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '10px',
            'border-bottom': `1px solid ${theme.border}`,
            background: `color-mix(in srgb, ${theme.info} 10%, transparent)`,
            padding: '5px 12px',
            'font-size': '11px',
            color: theme.fg,
          }}
        >
          <span style={{ flex: '1', 'min-width': '0', 'overflow-wrap': 'anywhere' }}>
            {bannerText(current())}
          </span>
          <button
            type="button"
            style={{ ...bannerBtnStyle, opacity: pending() ? 0.6 : 1 }}
            disabled={pending()}
            title="Track time on this task in Super Productivity instead"
            onClick={() => void track()}
          >
            {pending() ? 'Starting…' : 'Track this task'}
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            style={{ ...bannerBtnStyle, border: 'none', padding: '1px 4px', 'font-size': '13px' }}
            onClick={() => dismissSpBanner()}
          >
            ×
          </button>
        </div>
      )}
    </Show>
  );
}
