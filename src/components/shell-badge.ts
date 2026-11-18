import type { RunState } from '../store/runs';
import { setupExitLabel, type SetupState } from '../store/worktree-setup';

export interface ShellBadge {
  text: string;
  tone: 'muted' | 'success' | 'error';
}

interface ShellBadgeInput {
  setup?: SetupState;
  run?: { name: string; state: RunState };
  exit?: { exitCode: number | null; signal: string | null };
}

/**
 * The status shown in a shell terminal's corner. Setup and run terminals stay
 * quiet while working and after a normal end; only a failure is tinted.
 */
export function shellBadge({ setup, run, exit }: ShellBadgeInput): ShellBadge | undefined {
  const label = () => setupExitLabel(exit?.exitCode ?? null, exit?.signal ?? null);
  if (run) {
    if (run.state === 'failed') return { text: `${run.name} failed (${label()})`, tone: 'error' };
    if (run.state === 'finished') return { text: `${run.name} finished`, tone: 'muted' };
    if (run.state === 'stopped' || exit) return { text: `${run.name} stopped`, tone: 'muted' };
    return { text: `${run.name} running`, tone: 'muted' };
  }
  if (setup === 'running' && !exit) return { text: 'Setup script running…', tone: 'muted' };
  if (setup === 'passed') return { text: 'Setup script finished', tone: 'muted' };
  if (setup === 'failed') return { text: `Setup script failed (${label()})`, tone: 'error' };
  if (!exit) return undefined;
  return {
    text: `Process exited (${exit.exitCode ?? '?'})`,
    tone: exit.exitCode === 0 ? 'success' : 'error',
  };
}
