import { setStore } from './core';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type { UsageProvider, UsageResult } from '../ipc/types';

// The Codex usage endpoint rate-limits eager pollers, so refresh slowly and let
// agent session exits and manual clicks fill in between ticks. Claude's numbers
// come from its own sessions' status line, and the main process says when they move.
const POLL_INTERVAL_MS = 5 * 60_000;
const MIN_REFRESH_GAP_MS = 30_000;

/** Render order of the providers in the status bar. */
export const USAGE_PROVIDERS: readonly UsageProvider[] = ['claude', 'codex'];

const CHANNELS: Record<UsageProvider, IPC> = {
  claude: IPC.GetClaudeUsage,
  codex: IPC.GetCodexUsage,
};

// Only the bundled Claude Code and Codex agents report subscription usage the app can read.
const AGENT_PROVIDERS: Record<string, UsageProvider> = { 'claude-code': 'claude', codex: 'codex' };

let pollTimer: ReturnType<typeof setInterval> | null = null;
let stopClaudeListener: (() => void) | null = null;
const lastRequestAt: Record<UsageProvider, number> = { claude: 0, codex: 0 };
const inFlight: Partial<Record<UsageProvider, Promise<void>>> = {};

/** The usage meter an agent's sessions move, if the app tracks one for it. */
export function usageProviderForAgent(agentDefId: string): UsageProvider | null {
  return AGENT_PROVIDERS[agentDefId] ?? null;
}

function applyResult(provider: UsageProvider, result: UsageResult): void {
  if (result.status === 'ok') {
    setStore('usage', provider, {
      fiveHour: result.fiveHour,
      sevenDay: result.sevenDay,
      creditUsage: result.creditUsage ?? null,
      fetchedAt: result.fetchedAt,
      status: 'ok',
      error: null,
    });
  } else if (result.status === 'unavailable') {
    // Full reset: setStore merges, and a surviving snapshot would keep the bar visible after logout.
    setStore('usage', provider, {
      fiveHour: null,
      sevenDay: null,
      creditUsage: null,
      fetchedAt: null,
      status: 'unavailable',
      error: result.reason,
    });
  } else {
    setStore('usage', provider, { status: 'error', error: result.message });
  }
}

/** Re-reads one provider's usage. Coalesces concurrent calls and, unless forced,
 *  skips refreshes that land within MIN_REFRESH_GAP_MS of the previous request — the
 *  guard is for bursts of agent exits, so the poll tick and user clicks force. */
export function refreshUsage(
  provider: UsageProvider,
  opts: { force?: boolean } = {},
): Promise<void> {
  const pending = inFlight[provider];
  if (pending) return pending;
  if (!opts.force && Date.now() - lastRequestAt[provider] < MIN_REFRESH_GAP_MS) {
    return Promise.resolve();
  }
  lastRequestAt[provider] = Date.now();
  const request = invoke<UsageResult>(CHANNELS[provider])
    .then((result) => applyResult(provider, result))
    .catch((err: unknown) => {
      setStore('usage', provider, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      delete inFlight[provider];
    });
  inFlight[provider] = request;
  return request;
}

function refreshAll(): void {
  for (const provider of USAGE_PROVIDERS) void refreshUsage(provider, { force: true });
}

export function startUsagePolling(): void {
  if (pollTimer) return;
  stopClaudeListener = window.electron.ipcRenderer.on(IPC.ClaudeUsageChanged, () => {
    void refreshUsage('claude', { force: true });
  });
  refreshAll();
  pollTimer = setInterval(refreshAll, POLL_INTERVAL_MS);
}

export function stopUsagePolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  stopClaudeListener?.();
  stopClaudeListener = null;
}
