import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import type { ResourceSnapshot } from '../ipc/types';
import { ActivityIcon } from './icons';
import { ResourcesBreakdown } from './ResourcesBreakdown';
import { cpuShare, formatBytes, formatCpu, snapshotTotals } from './resources-format';

// The button's live total needs a slow background sample; the open panel a quicker one.
const OPEN_POLL_MS = 2000;
const BACKGROUND_POLL_MS = 5000;
/** Share of the whole machine above which the button turns to the warning colour. */
const BUSY_CPU_SHARE = 50;
/** CPU or RAM share at which the button turns red. */
const NEAR_CAPACITY_SHARE = 90;
const PANEL_WIDTH = 440;

/**
 * Samples now and every `intervalMs` until stopped. Skips a tick while a
 * request is in flight or the window is hidden, and drops replies that land
 * after stop so a superseded poller cannot overwrite a newer snapshot.
 */
function pollSnapshots(
  onSnapshot: (snapshot: ResourceSnapshot) => void,
  onError: (message: string) => void,
  intervalMs: number,
): () => void {
  let stopped = false;
  let busy = false;
  const tick = () => {
    if (busy || document.hidden) return;
    busy = true;
    invoke<ResourceSnapshot>(IPC.GetResourceUsage)
      .then(
        (result) => !stopped && onSnapshot(result),
        (err: unknown) => !stopped && onError(String(err)),
      )
      .finally(() => (busy = false));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** The button's live total; turns to the warning colour when the machine is busy. */
function ResourcesButtonLabel(props: { snapshot: ResourceSnapshot | null }) {
  return (
    <>
      <ActivityIcon
        size={11}
        title="Resources"
        style={{ 'vertical-align': '-1px', 'margin-right': '4px' }}
      />
      <Show when={props.snapshot} fallback="Resources">
        {(snapshot) => {
          const totals = () => snapshotTotals(snapshot());
          return (
            <>
              {formatCpu(totals().cpuPercent, snapshot().cpuCount)} ·{' '}
              {formatBytes(totals().memoryBytes)}
            </>
          );
        }}
      </Show>
    </>
  );
}

/**
 * Bottom-right status bar button showing the live CPU/memory total, which
 * opens a breakdown per agent, shell, and app process.
 */
export function ResourcesPanel() {
  const [open, setOpen] = createSignal(false);
  const [bottom, setBottom] = createSignal(0);
  const [snapshot, setSnapshot] = createSignal<ResourceSnapshot | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let button: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;

  const resourceColor = () => {
    const current = snapshot();
    if (current) {
      const totals = snapshotTotals(current);
      const cpu = cpuShare(totals.cpuPercent, current.cpuCount);
      const memory =
        current.totalMemoryBytes > 0 ? (totals.memoryBytes / current.totalMemoryBytes) * 100 : 0;
      if (cpu >= NEAR_CAPACITY_SHARE || memory >= NEAR_CAPACITY_SHARE) return theme.error;
      if (cpu >= BUSY_CPU_SHARE) return theme.warning;
    }
    return open() ? theme.fg : theme.fgMuted;
  };

  createEffect(() => {
    const stopPolling = pollSnapshots(
      (result) => {
        setSnapshot(result);
        setError(null);
      },
      (message) => setError(`Could not read processes: ${message}`),
      open() ? OPEN_POLL_MS : BACKGROUND_POLL_MS,
    );
    onCleanup(stopPolling);
  });

  createEffect(() => {
    if (!open()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !button?.contains(target) && !panel?.contains(target))
        setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    onCleanup(() => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    });
  });

  const toggle = () => {
    if (button) setBottom(window.innerHeight - button.getBoundingClientRect().top + 6);
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={open()}
        title="CPU and memory per agent"
        onClick={toggle}
        style={{
          'margin-left': 'auto',
          'flex-shrink': '0',
          background: open() ? theme.bgHover : 'none',
          border: 'none',
          'border-radius': 'var(--radius-xs)',
          color: resourceColor(),
          font: 'inherit',
          padding: '1px 6px',
          cursor: 'pointer',
        }}
      >
        <ResourcesButtonLabel snapshot={snapshot()} />
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={panel}
            role="region"
            aria-label="Resources"
            data-testid="resources-panel"
            style={{
              position: 'fixed',
              right: '8px',
              bottom: `${bottom()}px`,
              width: `${PANEL_WIDTH}px`,
              'max-width': 'calc(100vw - 16px)',
              'z-index': '1000',
              background: theme.bgElevated,
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-sm)',
              'box-shadow': '0 4px 16px rgba(0, 0, 0, 0.3)',
              padding: '6px 4px',
              'font-family': "'JetBrains Mono', monospace",
              'font-size': sf(11),
              color: theme.fgMuted,
              'white-space': 'nowrap',
            }}
          >
            <ResourcesBreakdown snapshot={snapshot()} error={error()} />
          </div>
        </Portal>
      </Show>
    </>
  );
}
