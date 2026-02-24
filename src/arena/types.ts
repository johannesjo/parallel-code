/** A single competitor in an arena match */
export interface ArenaCompetitor {
  id: string;
  name: string;
  /** Shell command template. {prompt} is replaced with the arena prompt. */
  command: string;
}

/** Runtime state of a competitor during a battle */
export interface BattleCompetitor {
  id: string;
  name: string;
  command: string;
  agentId: string;
  status: 'running' | 'exited';
  startTime: number;
  endTime: number | null;
  exitCode: number | null;
  /** Worktree path for this competitor (if project selected) */
  worktreePath: string | null;
  /** Branch name used for the worktree */
  branchName: string | null;
  /** Whether this competitor's branch was merged into main */
  merged?: boolean;
  /** Captured terminal output (plain text) for review after battle */
  terminalOutput?: string;
}

/** A saved match result */
export interface ArenaMatch {
  id: string;
  date: string;
  prompt: string;
  /** Project root used for the battle */
  cwd: string | null;
  competitors: Array<{
    name: string;
    command: string;
    timeMs: number | null;
    exitCode: number | null;
    /** 1-5 star rating, null if not rated */
    rating: number | null;
    worktreePath: string | null;
    branchName: string | null;
    merged: boolean;
    terminalOutput: string | null;
  }>;
}

/** A saved competitor preset */
export interface ArenaPreset {
  id: string;
  name: string;
  competitors: Array<{ name: string; command: string }>;
}

/** Arena overlay phase */
export type ArenaPhase = 'config' | 'countdown' | 'battle' | 'results' | 'history';

/** Arena-local store shape */
export interface ArenaStore {
  phase: ArenaPhase;
  /** Phase before entering history (so Back returns to the right place) */
  previousPhase: ArenaPhase | null;
  competitors: ArenaCompetitor[];
  prompt: string;
  /** Working directory for all competitors (project path) */
  cwd: string;
  presets: ArenaPreset[];
  history: ArenaMatch[];
  battle: BattleCompetitor[];
  selectedHistoryMatch: ArenaMatch | null;
  /** Whether the current battle results have been saved to history */
  battleSaved: boolean;
}
