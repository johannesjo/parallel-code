import { For, Show, createSignal, onMount } from 'solid-js';
import { arenaStore, setPhase, loadBattleFromHistory, deleteHistoryMatch } from './store';
import { saveArenaHistory } from './persistence';
import { formatDuration } from './utils';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatTimeMs(ms: number | null): string {
  if (ms === null) return 'DNF';
  return formatDuration(ms);
}

function renderStars(rating: number | null): string {
  if (rating === null) return '';
  const clamped = Math.max(0, Math.min(5, Math.floor(rating)));
  return '\u2605'.repeat(clamped) + '\u2606'.repeat(5 - clamped);
}

export function HistoryScreen() {
  const [worktreeStatus, setWorktreeStatus] = createSignal<Record<string, boolean>>({});
  const [deleting, setDeleting] = createSignal<string | null>(null);

  onMount(() => {
    void checkWorktrees();
  });

  async function checkWorktrees() {
    const entries = await Promise.all(
      arenaStore.history.map(async (match) => {
        for (const c of match.competitors) {
          if (c.worktreePath && !c.merged) {
            try {
              const exists = await invoke<boolean>(IPC.CheckPathExists, { path: c.worktreePath });
              if (exists) return [match.id, true] as const;
            } catch {
              // Treat IPC failure as not existing
            }
          }
        }
        return [match.id, false] as const;
      }),
    );
    setWorktreeStatus(Object.fromEntries(entries));
  }

  function handleRowClick(match: typeof arenaStore.history[0]) {
    loadBattleFromHistory(match);
  }

  async function handleDelete(e: Event, matchId: string) {
    e.stopPropagation();
    if (!confirm('Delete this match? Any remaining worktrees will be removed.')) return;
    setDeleting(matchId);
    try {
      await deleteHistoryMatch(matchId);
      void saveArenaHistory();
      setWorktreeStatus((prev) => {
        const next = { ...prev };
        delete next[matchId];
        return next;
      });
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div class="arena-history">
      <div class="arena-config-actions">
        <button class="arena-close-btn" onClick={() => setPhase(arenaStore.previousPhase ?? 'config')}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 3L5 8l5 5" />
          </svg>
          Back
        </button>
      </div>

      <Show
        when={arenaStore.history.length > 0}
        fallback={<div class="arena-history-empty">No matches yet. Go fight!</div>}
      >
        <For each={arenaStore.history}>
          {(match) => (
            <div
              class="arena-history-row"
              data-has-worktrees={worktreeStatus()[match.id] ? '' : undefined}
              onClick={() => handleRowClick(match)}
              style={{ cursor: 'pointer' }}
            >
              <div class="arena-history-row-top">
                <span>{formatDate(match.date)}</span>
                <div class="arena-history-row-actions">
                  <Show when={worktreeStatus()[match.id]}>
                    <span class="arena-history-badge">View Results</span>
                  </Show>
                  <button
                    class="arena-history-delete-btn"
                    disabled={deleting() === match.id}
                    onClick={(e) => void handleDelete(e, match.id)}
                    title="Delete match and clean up worktrees"
                  >
                    <Show
                      when={deleting() !== match.id}
                      fallback={<span>...</span>}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4v9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4" />
                      </svg>
                    </Show>
                  </button>
                </div>
              </div>
              <div class="arena-history-row-prompt">{match.prompt}</div>
              <div class="arena-history-row-competitors">
                {match.competitors
                  .map((c) => {
                    const stars = renderStars(c.rating);
                    const time = formatTimeMs(c.timeMs);
                    return `${c.name} ${time}${stars ? ` ${stars}` : ''}`;
                  })
                  .join('  \u00B7  ')}
              </div>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
