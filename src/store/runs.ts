import { createStore } from 'solid-js/store';
import { NOTIFICATION_ERROR_MS, showNotification } from './notification';
import { setupExitLabel } from './worktree-setup';

/**
 * Run commands (a project's named dev servers) as seen from one task: each
 * start opens a terminal of its own that runs the command and serves as its
 * log. State is ephemeral, like setup terminals: servers die with the app, so
 * a restored session shows every run as stopped and never restarts one.
 */

export type RunState = 'running' | 'finished' | 'stopped' | 'failed';

interface RunShell {
  taskId: string;
  runId: string;
  name: string;
  state: RunState;
  /** Set by Stop, so the exit that follows reads as stopped, whatever its code. */
  stopRequested?: boolean;
}

const pendingRunScripts = new Map<string, string>();
const [runShells, setRunShells] = createStore<Record<string, RunShell | undefined>>({});

export function setPendingRunScript(
  shellId: string,
  run: { taskId: string; runId: string; name: string; command: string },
): void {
  pendingRunScripts.set(shellId, run.command);
  setRunShells(shellId, { taskId: run.taskId, runId: run.runId, name: run.name, state: 'running' });
}

/** The command for a run terminal's first spawn; undefined afterwards. */
export function consumePendingRunScript(shellId: string): string | undefined {
  const script = pendingRunScripts.get(shellId);
  if (script !== undefined) pendingRunScripts.delete(shellId);
  return script;
}

/** Reactive: the run a terminal belongs to, if any. */
export function runShellInfo(shellId: string): Readonly<RunShell> | undefined {
  return runShells[shellId];
}

/** Reactive: the terminal currently holding a task's run, if it is open. */
export function runShellId(taskId: string, runId: string): string | undefined {
  for (const [shellId, run] of Object.entries(runShells)) {
    if (run?.taskId === taskId && run.runId === runId) return shellId;
  }
  return undefined;
}

/** Reactive: how a task's run is doing; undefined when it has no terminal. */
export function runState(taskId: string, runId: string): RunState | undefined {
  const shellId = runShellId(taskId, runId);
  return shellId ? runShells[shellId]?.state : undefined;
}

export function markRunStopRequested(shellId: string): void {
  if (runShells[shellId]?.state === 'running') setRunShells(shellId, 'stopRequested', true);
}

/** Ctrl+C in a shell ends with 130, a plain kill with 143: both mean stopped, not failed. */
const STOP_EXIT_CODES = new Set([130, 143]);

function exitState(
  run: RunShell,
  exitCode: number | null,
  signal: string | null,
): Exclude<RunState, 'running'> {
  if (run.stopRequested) return 'stopped';
  // A killed process exits 0 too, so the signal decides before the code does.
  if (signal !== null && signal !== 'spawn_failed') return 'stopped';
  if (exitCode === 0) return 'finished';
  return STOP_EXIT_CODES.has(exitCode ?? -1) ? 'stopped' : 'failed';
}

/** Records how a run's terminal ended; a crash is announced, a stop is not. */
export function noteRunShellExit(
  shellId: string,
  taskName: string,
  exitCode: number | null,
  signal: string | null = null,
): void {
  const run = runShells[shellId];
  if (run?.state !== 'running') return;
  const state = exitState(run, exitCode, signal);
  setRunShells(shellId, 'state', state);
  if (state === 'failed') {
    showNotification(
      `“${run.name}” stopped unexpectedly in “${taskName}” (${setupExitLabel(exitCode, signal)}). Its terminal has the output.`,
      { durationMs: NOTIFICATION_ERROR_MS },
    );
  }
}

export function forgetRunShells(shellIds: readonly string[]): void {
  for (const id of shellIds) {
    pendingRunScripts.delete(id);
    if (runShells[id] !== undefined) setRunShells(id, undefined);
  }
}
