import { For, Show, createEffect, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import { fetchUsage } from './api';
import { status } from './ws';
import {
  USAGE_WARN_PERCENT,
  formatReset,
  hasUsageSnapshot,
  remainingPercent,
  usageVisible,
} from '../components/usage-format';
import type { UsageProvider, UsageState, UsageWindow } from '../../electron/ipc/shared-types';

// The desktop polls the usage endpoints itself; this only re-reads its snapshot.
const POLL_INTERVAL_MS = 60_000;

const PROVIDER_LABELS: Record<UsageProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

function Meter(props: { label: string; window: UsageWindow }) {
  const left = () => remainingPercent(props.window);
  const reset = () => (left() === 100 ? '' : formatReset(props.window.resetsAt));
  return (
    <div class="usage-meter" classList={{ warn: props.window.usedPercent >= USAGE_WARN_PERCENT }}>
      <span class="usage-label">{props.label}</span>
      <span
        class="usage-bar"
        role="progressbar"
        aria-label={`${props.label} window remaining`}
        aria-valuenow={left()}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${left()}%` }} />
      </span>
      <span class="usage-left">{left()}% left</span>
      <Show when={reset()}>
        <span class="usage-reset">{reset()}</span>
      </Show>
    </div>
  );
}

/**
 * The desktop status bar's agent-subscription meters (Claude Code, Codex, Antigravity).
 * Hidden until the desktop has a snapshot, like the bar itself; tap to re-read.
 */
export function UsageStrip() {
  const [usage, setUsage] = createSignal<Record<UsageProvider, UsageState> | null>(null);
  const providers = () => {
    const u = usage();
    return u
      ? (Object.keys(PROVIDER_LABELS) as UsageProvider[]).filter((p) => u[p] && usageVisible(u[p]))
      : [];
  };
  const load = () => {
    if (status() !== 'connected') return;
    fetchUsage().then(setUsage, () => {
      // Keep the last snapshot; the connection banner already reports outages.
    });
  };

  // Also reads on every (re)connect, which covers the first load.
  createEffect(() => {
    if (status() === 'connected') untrack(load);
  });
  onMount(() => {
    const timer = setInterval(load, POLL_INTERVAL_MS);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <Show when={providers().length > 0}>
      <button class="mobile-usage" aria-label="Agent usage, tap to refresh" onClick={load}>
        <For each={providers()}>
          {(provider) => (
            <Show when={usage()?.[provider]}>
              {(state) => (
                <div class="usage-provider" classList={{ stale: state().status === 'error' }}>
                  <span class="usage-name">{PROVIDER_LABELS[provider]}</span>
                  <Show when={state().fiveHour}>{(w) => <Meter label="5h" window={w()} />}</Show>
                  <Show when={state().sevenDay}>{(w) => <Meter label="7d" window={w()} />}</Show>
                  <Show when={!hasUsageSnapshot(state())}>
                    <span class="usage-reset">usage unavailable · {state().error}</span>
                  </Show>
                </div>
              )}
            </Show>
          )}
        </For>
      </button>
    </Show>
  );
}
