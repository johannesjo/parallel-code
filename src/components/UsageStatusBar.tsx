import { For, Show, createMemo, createSignal } from 'solid-js';
import { Portal } from 'solid-js/web';
import { store, refreshUsage, USAGE_PROVIDERS } from '../store/store';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import type { UsageProvider, UsageWindow } from '../ipc/types';
import type { UsageState } from '../store/types';
import {
  USAGE_WARN_PERCENT,
  formatFetchedAt,
  formatReset,
  hasUsageSnapshot,
  remainingPercent,
  usageVisible,
} from './usage-format';

const PROVIDER_LABELS: Record<UsageProvider, string> = { claude: 'Claude', codex: 'Codex' };
const POPOVER_WIDTH = 300;

function UsageMeter(props: { label: string; window: UsageWindow; width?: number }) {
  const warn = () => props.window.usedPercent >= USAGE_WARN_PERCENT;
  const color = () => (warn() ? theme.warning : theme.accent);
  const reset = () => formatReset(props.window.resetsAt);
  // The bar drains: filled means budget still available, matching the "% left" readout.
  const left = () => remainingPercent(props.window);

  return (
    <span style={{ display: 'inline-flex', 'align-items': 'center', gap: '6px' }}>
      <span style={{ color: theme.fgSubtle }}>{props.label}</span>
      <span
        role="progressbar"
        aria-label={`${props.label} window remaining`}
        aria-valuenow={left()}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          width: `${props.width ?? 56}px`,
          height: '5px',
          'border-radius': 'var(--radius-xs)',
          background: theme.bgInput,
          border: `1px solid ${theme.border}`,
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            display: 'block',
            height: '100%',
            width: `${left()}%`,
            background: color(),
          }}
        />
      </span>
      <span style={{ color: warn() ? theme.warning : theme.fg, 'font-weight': '500' }}>
        {left()}% left
      </span>
      <Show when={reset()}>
        <span style={{ color: theme.fgSubtle }}>{reset()}</span>
      </Show>
    </span>
  );
}

/** Glance-only detail card above a provider's bar entry: both windows, last refresh, any error. */
function UsagePopover(props: {
  provider: UsageProvider;
  usage: UsageState;
  anchor: { left: number; bottom: number };
}) {
  const footer = () => {
    if (props.usage.status === 'error')
      return `Refresh failed: ${props.usage.error} · click to retry`;
    const at = props.usage.fetchedAt;
    return `${at ? `Updated ${formatFetchedAt(at)} · ` : ''}click to refresh`;
  };

  return (
    <Portal>
      <div
        data-testid="usage-popover"
        style={{
          position: 'fixed',
          left: `${props.anchor.left}px`,
          bottom: `${props.anchor.bottom}px`,
          width: `${POPOVER_WIDTH}px`,
          'pointer-events': 'none',
          'z-index': '1000',
          background: theme.bgElevated,
          border: `1px solid ${theme.border}`,
          'border-radius': 'var(--radius-sm)',
          'box-shadow': '0 4px 16px rgba(0, 0, 0, 0.3)',
          padding: '8px 10px',
          'font-family': "'JetBrains Mono', monospace",
          'font-size': sf(11),
          color: theme.fgMuted,
          display: 'flex',
          'flex-direction': 'column',
          gap: '6px',
        }}
      >
        <div
          style={{
            color: theme.fgSubtle,
            'font-weight': '600',
            'text-transform': 'uppercase',
            'letter-spacing': '0.05em',
            'font-size': sf(11),
          }}
        >
          {PROVIDER_LABELS[props.provider]} usage
        </div>
        <Show when={props.usage.fiveHour}>
          {(w) => <UsageMeter label="5h" window={w()} width={120} />}
        </Show>
        <Show when={props.usage.sevenDay}>
          {(w) => <UsageMeter label="7d" window={w()} width={120} />}
        </Show>
        <div
          style={{
            color: props.usage.status === 'error' ? theme.warning : theme.fgSubtle,
            'font-size': sf(11),
          }}
        >
          {footer()}
        </div>
      </div>
    </Portal>
  );
}

/** Where the popover opens: above the hovered entry, kept inside the viewport. */
function popoverAnchor(rect: DOMRect): { left: number; bottom: number } {
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8));
  return { left, bottom: window.innerHeight - rect.top + 6 };
}

/**
 * One provider's bar entry: just the five-hour window, which is the one that
 * bites mid-session. Hovering shows the rest; clicking refreshes this provider.
 */
function ProviderUsage(props: { provider: UsageProvider }) {
  const usage = () => store.usage[props.provider];
  const stale = () => usage().status === 'error' && hasUsageSnapshot(usage());
  const [anchor, setAnchor] = createSignal<{ left: number; bottom: number } | null>(null);
  // Fall back to the weekly window so a provider without a five-hour one still shows something.
  const headline = createMemo(() => {
    const u = usage();
    if (u.fiveHour) return { label: '5h', window: u.fiveHour };
    if (u.sevenDay) return { label: '7d', window: u.sevenDay };
    return null;
  });

  return (
    <Show when={usageVisible(usage())}>
      <span
        role="status"
        onClick={() => void refreshUsage(props.provider, { force: true })}
        onMouseEnter={(e) => setAnchor(popoverAnchor(e.currentTarget.getBoundingClientRect()))}
        onMouseLeave={() => setAnchor(null)}
        style={{
          display: 'inline-flex',
          'align-items': 'center',
          gap: '10px',
          cursor: 'pointer',
          opacity: stale() ? '0.6' : '1',
        }}
      >
        <span
          style={{
            color: theme.fgSubtle,
            'text-transform': 'uppercase',
            'letter-spacing': '0.05em',
          }}
        >
          {PROVIDER_LABELS[props.provider]}
        </span>
        <Show when={headline()}>{(h) => <UsageMeter label={h().label} window={h().window} />}</Show>
        <Show when={!hasUsageSnapshot(usage())}>
          <span>usage unavailable · {usage().error}</span>
        </Show>
      </span>
      <Show when={anchor()}>
        {(a) => <UsagePopover provider={props.provider} usage={usage()} anchor={a()} />}
      </Show>
    </Show>
  );
}

/**
 * Bottom bar with the rate-limit windows of every agent subscription the app
 * can read (Claude Code, Codex). Hidden until the first successful read, and
 * permanently when no agent has a subscription login (API-key users).
 */
export function UsageStatusBar() {
  const visible = createMemo(() => USAGE_PROVIDERS.some((p) => usageVisible(store.usage[p])));

  return (
    <Show when={visible()}>
      <div
        style={{
          height: '24px',
          'min-height': '24px',
          display: 'flex',
          'align-items': 'center',
          gap: '28px',
          padding: '0 10px',
          'border-top': `1px solid ${theme.border}`,
          'font-family': "'JetBrains Mono', monospace",
          'font-size': sf(11),
          color: theme.fgMuted,
          'white-space': 'nowrap',
          overflow: 'hidden',
          'user-select': 'none',
          'flex-shrink': '0',
        }}
      >
        <For each={USAGE_PROVIDERS}>{(provider) => <ProviderUsage provider={provider} />}</For>
      </div>
    </Show>
  );
}
