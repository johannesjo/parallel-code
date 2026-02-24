import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { ChangedFilesList } from '../components/ChangedFilesList';
import { DiffViewerDialog } from '../components/DiffViewerDialog';
import { CommitDialog } from './CommitDialog';
import { createMergeWorkflow } from './merge';
import {
  arenaStore,
  addMatchToHistory,
  updateHistoryRating,
  resetForNewMatch,
  resetForRematch,
  setPhase,
  setBattleSaved,
  returnToHistory,
} from './store';
import { saveArenaHistory } from './persistence';
import { formatDuration } from './utils';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, toggleNewTaskDialog, toggleArena, setNewTaskPrefillPrompt } from '../store/store';
import type { ArenaMatch } from './types';
import type { ChangedFile } from '../ipc/types';

function formatTime(startTime: number, endTime: number | null): string {
  if (endTime === null) return 'DNF';
  return formatDuration(endTime - startTime);
}

function rankLabel(index: number): string {
  return ['1st', '2nd', '3rd', '4th'][index] ?? `${index + 1}th`;
}

export function ResultsScreen() {
  const isHistoryView = () => arenaStore.selectedHistoryMatch !== null;
  const projectLabel = createMemo(() => {
    const cwd = arenaStore.cwd;
    if (!cwd) return null;
    const project = store.projects.find((p) => p.path === cwd);
    return project?.name ?? cwd.split('/').pop() ?? null;
  });

  // When viewing from history, pre-populate ratings from saved match
  function initialRatings(): Record<string, number> {
    const match = arenaStore.selectedHistoryMatch;
    if (!match) return {};
    const result: Record<string, number> = {};
    match.competitors.forEach((c, i) => {
      if (c.rating !== null && arenaStore.battle[i]) {
        result[arenaStore.battle[i].id] = c.rating;
      }
    });
    return result;
  }

  const [ratings, setRatings] = createSignal<Record<string, number>>(initialRatings());
  const [diffFile, setDiffFile] = createSignal<ChangedFile | null>(null);
  const [diffWorktree, setDiffWorktree] = createSignal('');
  const [diffBranch, setDiffBranch] = createSignal<string | null>(null);
  const [expandedOutputs, setExpandedOutputs] = createSignal<Record<string, boolean>>({});

  const merge = createMergeWorkflow();
  onMount(() => {
    merge.loadWorktreeStatuses();
    // Auto-save results for new battles (not when viewing from history)
    if (!isHistoryView() && !arenaStore.battleSaved) saveResults();
  });

  async function openCompareTask() {
    const competitors = sorted();
    const prompt = arenaStore.prompt;

    // Gather changed files from each competitor's worktree
    const sections: string[] = [];
    for (let i = 0; i < competitors.length; i++) {
      const c = competitors[i];
      const timeStr = c.endTime !== null
        ? formatDuration(c.endTime - c.startTime)
        : 'DNF';
      const exitStr = c.exitCode !== null && c.exitCode !== 0
        ? ` | exit code ${c.exitCode}`
        : '';

      let filesStr = '  (no project worktree)';
      if (c.worktreePath) {
        try {
          const files = await invoke<ChangedFile[]>(IPC.GetChangedFiles, {
            worktreePath: c.worktreePath,
          });
          if (files.length > 0) {
            filesStr = files
              .map((f) => `  - ${f.path} (+${f.lines_added}, -${f.lines_removed})`)
              .join('\n');
          } else {
            filesStr = '  (no changes)';
          }
        } catch {
          filesStr = '  (could not read changes)';
        }
      }

      sections.push(
        `## Approach ${i + 1}: ${c.name} (${timeStr}${exitStr})\n` +
        (c.worktreePath ? `Worktree: ${c.worktreePath}\n` : '') +
        `Changed files:\n${filesStr}`
      );
    }

    const fullPrompt =
      `Compare the following different AI-generated approaches to this task. ` +
      `These are ${competitors.length} independent implementations of the same prompt, ` +
      `each in its own worktree.\n\n` +
      `# Original task\n${prompt}\n\n` +
      sections.join('\n\n---\n\n') +
      `\n\n---\n\n` +
      `Read the changed files from each worktree and compare the approaches. ` +
      `Focus on correctness, code quality, and trade-offs between them.`;

    const projectId = store.projects.find((p) => p.path === arenaStore.cwd)?.id ?? null;
    setNewTaskPrefillPrompt(fullPrompt, projectId);
    toggleArena(false);
    toggleNewTaskDialog(true);
  }

  const sorted = () =>
    [...arenaStore.battle].sort((a, b) => {
      const aFailed = a.exitCode !== null && a.exitCode !== 0;
      const bFailed = b.exitCode !== null && b.exitCode !== 0;
      if (aFailed !== bFailed) return aFailed ? 1 : -1;
      const aTime = a.endTime !== null ? a.endTime - a.startTime : Infinity;
      const bTime = b.endTime !== null ? b.endTime - b.startTime : Infinity;
      return aTime - bTime;
    });

  function setRating(competitorId: string, stars: number) {
    setRatings((prev) => ({ ...prev, [competitorId]: stars }));

    // Persist rating to history — use selectedHistoryMatch for history views,
    // or the most recent history entry for fresh battles
    const match = arenaStore.selectedHistoryMatch
      ?? (arenaStore.battleSaved ? arenaStore.history[0] : null);
    if (match) {
      const idx = arenaStore.battle.findIndex((b) => b.id === competitorId);
      if (idx !== -1) {
        updateHistoryRating(match.id, idx, stars);
        void saveArenaHistory();
      }
    }
  }

  function saveResults() {
    if (arenaStore.battle.length === 0) return;
    const match: ArenaMatch = {
      id: crypto.randomUUID(),
      date: new Date().toISOString(),
      prompt: arenaStore.prompt,
      cwd: arenaStore.cwd || null,
      competitors: [...arenaStore.battle].map((b) => ({
        name: b.name,
        command: b.command,
        timeMs: b.endTime !== null ? b.endTime - b.startTime : null,
        exitCode: b.exitCode,
        rating: ratings()[b.id] ?? null,
        worktreePath: b.worktreePath ?? null,
        branchName: b.branchName ?? null,
        merged: b.merged ?? false,
        terminalOutput: b.terminalOutput ?? null,
      })),
    };
    addMatchToHistory(match);
    void saveArenaHistory();
    setBattleSaved(true);
  }

  function handleFileClick(worktreePath: string, branchName: string | null, file: ChangedFile) {
    setDiffWorktree(worktreePath);
    setDiffBranch(branchName);
    setDiffFile(file);
  }

  return (
    <div class="arena-results">
      <div class="arena-results-prompt" title={arenaStore.prompt}>
        {arenaStore.prompt}
      </div>
      <div class="arena-results-grid">
        <For each={sorted()}>
          {(competitor, index) => {
            const originalIdx = arenaStore.battle.findIndex((b) => b.id === competitor.id);
            return (
              <div
                class="arena-result-column"
                data-arena={originalIdx}
                data-rank={index() === 0 ? '1' : undefined}
              >
                <div class="arena-result-column-rank" data-rank={String(index() + 1)}>
                  {rankLabel(index())}
                </div>
                <div class="arena-result-column-name">{competitor.name}</div>
                <div class="arena-result-column-time">
                  {formatTime(competitor.startTime, competitor.endTime)}
                </div>
                <Show when={competitor.exitCode !== null && competitor.exitCode !== 0}>
                  <div class="arena-result-column-exit">exit {competitor.exitCode}</div>
                </Show>

                {/* Terminal output */}
                <Show when={competitor.terminalOutput}>
                  <div class="arena-result-column-output">
                    <button
                      class="arena-output-toggle"
                      onClick={() =>
                        setExpandedOutputs((prev) => ({
                          ...prev,
                          [competitor.id]: !prev[competitor.id],
                        }))
                      }
                    >
                      <span
                        class="arena-output-toggle-icon"
                        data-expanded={expandedOutputs()[competitor.id] ? 'true' : undefined}
                      >
                        &#9654;
                      </span>
                      Terminal output
                    </button>
                    <Show when={expandedOutputs()[competitor.id]}>
                      <pre class="arena-output-pre">{competitor.terminalOutput}</pre>
                    </Show>
                  </div>
                </Show>

                {/* Changed files */}
                <Show when={competitor.worktreePath || competitor.branchName}>
                  <div class="arena-result-column-files">
                    <span class="arena-section-label">Changed files</span>
                    <div class="arena-result-column-files-list">
                      <ChangedFilesList
                        worktreePath={competitor.worktreePath ?? ''}
                        isActive={true}
                        projectRoot={arenaStore.cwd || undefined}
                        branchName={competitor.branchName}
                        onFileClick={(file) => handleFileClick(competitor.worktreePath ?? '', competitor.branchName, file)}
                      />
                    </div>
                  </div>
                </Show>

                {/* Star rating */}
                <div class="arena-result-column-rating">
                  <span class="arena-result-rating-label">Rate how it performed</span>
                  <div class="arena-result-column-stars">
                    <For each={[1, 2, 3, 4, 5]}>
                      {(star) => (
                        <button
                          class="arena-star-btn"
                          data-filled={(ratings()[competitor.id] ?? 0) >= star ? 'true' : undefined}
                          onClick={() => setRating(competitor.id, star)}
                          title={`${star} star${star > 1 ? 's' : ''}`}
                        >
                          <svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M8 1.3l1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 5.5l4-.6L8 1.3z" />
                          </svg>
                        </button>
                      )}
                    </For>
                  </div>
                </div>

                {/* Merge into main */}
                <Show when={competitor.branchName && merge.hasChanges(competitor.id)}>
                  <div class="arena-result-column-merge">
                    <Show
                      when={merge.mergedId() !== competitor.id}
                      fallback={<span class="arena-merge-badge">Merged</span>}
                    >
                      <button
                        class="arena-merge-btn"
                        disabled={merge.merging() || merge.mergedId() !== null}
                        onClick={() => merge.handleMergeClick(competitor)}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.5"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <circle cx="4" cy="4" r="2" />
                          <circle cx="12" cy="4" r="2" />
                          <circle cx="8" cy="13" r="2" />
                          <path d="M4 6v1c0 2 4 4 4 4M12 6v1c0 2-4 4-4 4" />
                        </svg>
                        {merge.merging() ? 'Merging...' : 'Merge into main'}
                      </button>
                    </Show>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      <Show when={merge.mergeError()}>
        <div class="arena-merge-error">{merge.mergeError()}</div>
      </Show>

      <Show when={projectLabel()}>
        <div class="arena-results-project">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 4l6-2 6 2v8l-6 2-6-2z" />
            <path d="M8 2v12" />
          </svg>
          {projectLabel()}
        </div>
      </Show>

      <div class="arena-config-actions">
        <button class="arena-close-btn" onClick={() => void openCompareTask()}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 3h4v10H3zM9 3h4v10H9zM5 6H3M5 8H3M5 10H3M11 6H9M11 8H9M11 10H9" />
          </svg>
          Compare All
        </button>
        <Show when={!isHistoryView()}>
          <button class="arena-close-btn" onClick={() => void resetForRematch()}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 8a6 6 0 0 1 10.2-4.3" />
              <path d="M14 8a6 6 0 0 1-10.2 4.3" />
              <path d="M12 1v3h-3" />
              <path d="M4 15v-3h3" />
            </svg>
            Rematch
          </button>
          <button class="arena-close-btn" onClick={() => void resetForNewMatch()}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
            New Match
          </button>
          <button class="arena-close-btn" onClick={() => setPhase('history')}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 4.5V8l2.5 2.5" />
            </svg>
            History
          </button>
        </Show>
        <Show when={isHistoryView()}>
          <button class="arena-close-btn" onClick={returnToHistory}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 3L5 8l5 5" />
            </svg>
            Back to History
          </button>
        </Show>
      </div>

      <DiffViewerDialog
        file={diffFile()}
        worktreePath={diffWorktree()}
        projectRoot={arenaStore.cwd || undefined}
        branchName={diffBranch()}
        onClose={() => setDiffFile(null)}
      />

      <Show when={merge.commitTarget()}>
        {(target) => (
          <CommitDialog
            target={target()}
            hasCommitted={!!merge.worktreeStatus()[target().id]?.hasCommitted}
            onCommitAndMerge={(msg) => void merge.commitAndMerge(msg)}
            onDiscardAndMerge={() => void merge.discardAndMerge()}
            onCancel={merge.dismissCommitDialog}
          />
        )}
      </Show>
    </div>
  );
}
