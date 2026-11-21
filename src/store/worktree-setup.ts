import { createStore } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { getProject, getProjectPath } from './projects';
import { NOTIFICATION_ERROR_MS, showNotification } from './notification';
import type { Task } from './types';

/**
 * Per-project worktree scripts, as seen from the renderer. Teardown, suspend
 * and resume run headless in the main process; this module sends them and
 * reports their failures.
 *
 * Setup runs in a task shell terminal of its own, started in the same tick
 * the task appears: the main process turns `shellScript` into a shell
 * invocation and the terminal shows the output live. The script's exit is
 * shown on that terminal and, if it failed, as a notification, because the
 * shell section may be scrolled away or collapsed.
 */

export type SetupState = 'running' | 'passed' | 'failed';

// Ephemeral, like pending bookmark commands: a restored session gets plain
// shells, so a restart never runs the setup script a second time.
const pendingScripts = new Map<string, string>();
const [setupShells, setSetupShells] = createStore<Record<string, SetupState | undefined>>({});

export function setPendingSetupScript(shellId: string, script: string): void {
  pendingScripts.set(shellId, script);
  setSetupShells(shellId, 'running');
}

/** The script for a setup terminal's first spawn; undefined afterwards. */
export function consumePendingSetupScript(shellId: string): string | undefined {
  const script = pendingScripts.get(shellId);
  if (script !== undefined) pendingScripts.delete(shellId);
  return script;
}

/** Reactive: whether this shell is (or was) the task's setup terminal, and how it went. */
export function setupShellState(shellId: string): SetupState | undefined {
  return setupShells[shellId];
}

/** The signal that ended a PTY, or null: node-pty on macOS and Linux reports a normal exit as "0". */
export function ptyExitSignal(signal: string | null): string | null {
  return signal === '0' ? null : signal;
}

/** Records how the setup terminal ended and reports a failure loudly. */
export function noteSetupShellExit(
  shellId: string,
  taskName: string,
  exitCode: number | null,
  rawSignal: string | null = null,
): void {
  if (setupShells[shellId] !== 'running') return;
  const signal = ptyExitSignal(rawSignal);
  // node-pty reports exit code 0 with a signal for a killed process.
  const passed = exitCode === 0 && !signal;
  setSetupShells(shellId, passed ? 'passed' : 'failed');
  if (!passed) {
    showNotification(
      `Setup script failed in “${taskName}” (${setupExitLabel(exitCode, signal)}). Its terminal has the output.`,
      { durationMs: NOTIFICATION_ERROR_MS },
    );
  }
}

/** "exit 2", "SIGINT" or "did not start", for badges and notices. */
export function setupExitLabel(exitCode: number | null, signal: string | null): string {
  if (signal === 'spawn_failed') return 'did not start';
  const killedBy = ptyExitSignal(signal);
  if (killedBy) return killedBy;
  return `exit ${exitCode ?? '?'}`;
}

export function forgetSetupShells(shellIds: readonly string[]): void {
  for (const id of shellIds) {
    pendingScripts.delete(id);
    if (setupShells[id] !== undefined) setSetupShells(id, undefined);
  }
}

/** Variables the setup script can use; the same names the teardown script gets. */
export function worktreeScriptEnv(args: {
  projectRoot: string;
  worktreePath: string;
  branchName: string;
}): Record<string, string> {
  // No task id: `PARALLEL_CODE_TASK_ID` is the agent-hook identity, which the
  // main process strips from renderer env.
  return {
    PARALLEL_CODE_ROOT_PATH: args.projectRoot,
    PARALLEL_CODE_WORKTREE: args.worktreePath,
    PARALLEL_CODE_BRANCH: args.branchName,
  };
}

/** The teardown fields of a merge or close request, or `{}` when the project has
 *  no teardown script. The main process looks up the project's env vars by id. */
export function teardownScriptFor(projectId: string): {
  teardownScript?: string;
  projectId?: string;
} {
  const script = getProject(projectId)?.worktreeTeardownScript;
  return script ? { teardownScript: script, projectId } : {};
}

/** Teardown failures never block removal, so they must at least be seen. */
export function reportTeardownWarning(taskName: string, warning: string | undefined): void {
  if (!warning) return;
  showNotification(`Closed “${taskName}”. ${warning}`, { durationMs: NOTIFICATION_ERROR_MS });
}

type LifecycleTask = Pick<
  Task,
  'name' | 'projectId' | 'gitIsolation' | 'worktreePath' | 'branchName'
>;

/** The project's suspend script, or undefined when minimizing this task runs
 *  none: the project has no script, or the task has no worktree of its own. */
export function suspendScriptFor(task: LifecycleTask): string | undefined {
  if (task.gitIsolation !== 'worktree' || !task.worktreePath) return undefined;
  return getProject(task.projectId)?.worktreeSuspendScript;
}

/** The project's resume script, for a task whose suspend script ran. */
export function resumeScriptFor(task: LifecycleTask): string | undefined {
  if (task.gitIsolation !== 'worktree' || !task.worktreePath) return undefined;
  return getProject(task.projectId)?.worktreeResumeScript;
}

/**
 * Runs a suspend or resume script in the task's worktree without waiting for
 * it: minimizing and restoring change the layout at once. The main process
 * runs the scripts of one worktree in order, so a quick restore resumes only
 * after the suspend finished. A failure is announced, never thrown.
 */
export function runWorktreeLifecycleScript(
  kind: 'suspend' | 'resume',
  task: LifecycleTask,
  script: string,
): void {
  const projectRoot = getProjectPath(task.projectId);
  if (!projectRoot || !task.worktreePath) return;
  const label = kind === 'suspend' ? 'Suspend' : 'Resume';
  const done = kind === 'suspend' ? 'Minimized' : 'Restored';
  const report = (warning: string) =>
    showNotification(`${done} “${task.name}”. ${warning}`, { durationMs: NOTIFICATION_ERROR_MS });
  invoke<{ warning?: string } | undefined>(IPC.RunWorktreeLifecycleScript, {
    kind,
    projectId: task.projectId,
    projectRoot,
    worktreePath: task.worktreePath,
    branchName: task.branchName || undefined,
    script,
  })
    .then((result) => {
      if (result?.warning) report(result.warning);
    })
    .catch((err: unknown) =>
      report(`${label} script could not run: ${err instanceof Error ? err.message : String(err)}`),
    );
}
