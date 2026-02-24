import { createStore } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import type {
  ArenaStore,
  ArenaPhase,
  ArenaCompetitor,
  ArenaPreset,
  ArenaMatch,
  BattleCompetitor,
} from './types';

export const MAX_COMPETITORS = 4;
export const MIN_COMPETITORS = 2;

function makeEmptyCompetitor(): ArenaCompetitor {
  return { id: crypto.randomUUID(), name: '', command: '' };
}

const [state, setState] = createStore<ArenaStore>({
  phase: 'config',
  previousPhase: null,
  competitors: [makeEmptyCompetitor(), makeEmptyCompetitor()],
  prompt: '',
  cwd: '',
  presets: [],
  history: [],
  battle: [],
  selectedHistoryMatch: null,
  battleSaved: false,
});

/** Read-only access to the arena store */
// eslint-disable-next-line solid/reactivity -- intentional module-level alias for read-only store access
export const arenaStore = state;

// --- Phase ---

export function setPhase(phase: ArenaPhase): void {
  if (phase === 'history') {
    setState('previousPhase', state.phase);
  }
  setState('phase', phase);
}

// --- Competitors ---

export function updateCompetitor(
  id: string,
  update: Partial<Pick<ArenaCompetitor, 'name' | 'command'>>,
): void {
  setState(
    'competitors',
    (c) => c.id === id,
    (prev) => ({ ...prev, ...update }),
  );
}

export function addCompetitor(): void {
  if (state.competitors.length >= MAX_COMPETITORS) return;
  setState('competitors', (prev) => [...prev, makeEmptyCompetitor()]);
}

export function removeCompetitor(id: string): void {
  if (state.competitors.length <= MIN_COMPETITORS) return;
  setState('competitors', (prev) => prev.filter((c) => c.id !== id));
}

// --- Prompt ---

export function setPrompt(prompt: string): void {
  setState('prompt', prompt);
}

export function setCwd(cwd: string): void {
  setState('cwd', cwd);
}

// --- Battle ---

export function startBattle(competitors: BattleCompetitor[]): void {
  setState('battle', competitors);
  setState('phase', 'countdown');
}

export function markBattleCompetitorExited(agentId: string, exitCode: number | null): void {
  setState(
    'battle',
    (c) => c.agentId === agentId,
    (prev) => ({
      ...prev,
      status: 'exited' as const,
      endTime: Date.now(),
      exitCode,
    }),
  );
}

export function allBattleFinished(): boolean {
  return state.battle.length > 0 && state.battle.every((c) => c.status === 'exited');
}

// --- Terminal output ---

export function setTerminalOutput(competitorId: string, output: string): void {
  setState('battle', (c) => c.id === competitorId, 'terminalOutput', output);
}

// --- Merge ---

export function markBranchMerged(competitorId: string): void {
  setState('battle', (c) => c.id === competitorId, 'merged', true);
}

// --- Battle saved ---

export function setBattleSaved(saved: boolean): void {
  setState('battleSaved', saved);
}

// --- Worktree cleanup ---

export async function cleanupBattleWorktrees(): Promise<void> {
  if (!state.cwd) return;
  if (state.battleSaved) return; // Preserved for history viewing
  for (const c of state.battle) {
    // Skip already-merged competitors — mergeTask with cleanup:true already removed the worktree/branch
    if (c.branchName && !c.merged) {
      try {
        await invoke(IPC.RemoveArenaWorktree, {
          projectRoot: state.cwd,
          branchName: c.branchName,
        });
      } catch (e) {
        console.warn('Failed to remove arena worktree:', c.branchName, e);
      }
    }
  }
}

// --- History ---

export function addMatchToHistory(match: ArenaMatch): void {
  setState('history', (prev) => [match, ...prev]);
}

export function setSelectedHistoryMatch(match: ArenaMatch | null): void {
  setState('selectedHistoryMatch', match);
}

export function updateHistoryRating(matchId: string, competitorIndex: number, rating: number): void {
  setState(
    'history',
    (m) => m.id === matchId,
    'competitors',
    competitorIndex,
    'rating',
    rating,
  );
}

// --- Presets ---

export function loadPresets(presets: ArenaPreset[]): void {
  setState('presets', presets);
}

export function loadHistory(history: ArenaMatch[]): void {
  setState('history', history);
}

export function loadBattleFromHistory(match: ArenaMatch): void {
  // Use startTime=0 and endTime=duration so (endTime - startTime) yields the
  // correct duration for display and sorting in ResultsScreen.
  const battle: BattleCompetitor[] = match.competitors.map((c, i) => ({
    id: `history-${match.id}-${i}`,
    name: c.name,
    command: c.command,
    agentId: '',
    status: 'exited' as const,
    startTime: 0,
    endTime: c.timeMs,
    exitCode: c.exitCode,
    worktreePath: c.worktreePath,
    branchName: c.branchName,
    merged: c.merged,
    terminalOutput: c.terminalOutput ?? undefined,
  }));
  setState('battle', battle);
  setState('cwd', match.cwd ?? '');
  setState('prompt', match.prompt);
  setState('selectedHistoryMatch', match);
  setState('battleSaved', true);
  setState('phase', 'results');
}

export function returnToHistory(): void {
  setState('selectedHistoryMatch', null);
  setState('battle', []);
  setState('phase', 'history');
}

export async function deleteHistoryMatch(matchId: string): Promise<void> {
  const match = state.history.find((m) => m.id === matchId);
  if (!match) return;

  const cwd = match.cwd;
  if (cwd) {
    for (const c of match.competitors) {
      if (c.branchName && !c.merged) {
        try {
          await invoke(IPC.RemoveArenaWorktree, {
            projectRoot: cwd,
            branchName: c.branchName,
          });
        } catch (e) {
          console.warn('Failed to remove history worktree:', c.branchName, e);
        }
      }
    }
  }

  setState('history', (prev) => prev.filter((m) => m.id !== matchId));
}

export function applyPreset(preset: ArenaPreset): void {
  const competitors: ArenaCompetitor[] = preset.competitors.map((c) => ({
    id: crypto.randomUUID(),
    name: c.name,
    command: c.command,
  }));
  setState('competitors', competitors);
}

export function saveCurrentAsPreset(name: string): void {
  const preset: ArenaPreset = {
    id: crypto.randomUUID(),
    name,
    competitors: state.competitors
      .filter((c) => c.name.trim() && c.command.trim())
      .map((c) => ({ name: c.name, command: c.command })),
  };
  setState('presets', (prev) => [...prev, preset]);
}

export function deletePreset(id: string): void {
  setState('presets', (prev) => prev.filter((p) => p.id !== id));
}

// --- Reset ---

export async function resetForNewMatch(): Promise<void> {
  await cleanupBattleWorktrees();
  setState('battleSaved', false);
  setState('phase', 'config');
  setState('battle', []);
  setState('competitors', [makeEmptyCompetitor(), makeEmptyCompetitor()]);
  setState('prompt', '');
  setState('cwd', '');
  setState('selectedHistoryMatch', null);
}

export async function resetForRematch(): Promise<void> {
  await cleanupBattleWorktrees();
  setState('battleSaved', false);
  setState('phase', 'config');
  setState('battle', []);
  setState('selectedHistoryMatch', null);
}

// --- Validation ---

export function canFight(): boolean {
  const filled = state.competitors.filter((c) => c.name.trim() !== '' && c.command.trim() !== '');
  return filled.length >= MIN_COMPETITORS && state.prompt.trim() !== '' && state.cwd !== '';
}
