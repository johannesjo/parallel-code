import { createStore } from 'solid-js/store';
import { getProject } from './projects';
import { NOTIFICATION_ERROR_MS, showNotification } from './notification';

/**
 * Per-project worktree setup and teardown, as seen from the renderer.
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

/** Records how the setup terminal ended and reports a failure loudly. */
export function noteSetupShellExit(
  shellId: string,
  taskName: string,
  exitCode: number | null,
): void {
  if (setupShells[shellId] !== 'running') return;
  const passed = exitCode === 0;
  setSetupShells(shellId, passed ? 'passed' : 'failed');
  if (!passed) {
    showNotification(
      `Setup script failed in “${taskName}” (exit ${exitCode ?? '?'}). Its terminal has the output.`,
      { durationMs: NOTIFICATION_ERROR_MS },
    );
  }
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
  taskId: string;
}): Record<string, string> {
  return {
    PARALLEL_CODE_ROOT_PATH: args.projectRoot,
    PARALLEL_CODE_WORKTREE: args.worktreePath,
    PARALLEL_CODE_BRANCH: args.branchName,
    PARALLEL_CODE_TASK_ID: args.taskId,
  };
}

/** `{ teardownScript }` for a merge or close request, or `{}` when the project has none. */
export function teardownScriptFor(projectId: string): { teardownScript?: string } {
  const script = getProject(projectId)?.worktreeTeardownScript;
  return script ? { teardownScript: script } : {};
}

/** Teardown failures never block removal, so they must at least be seen. */
export function reportTeardownWarning(taskName: string, warning: string | undefined): void {
  if (!warning) return;
  showNotification(`Closed “${taskName}”. ${warning}`, { durationMs: NOTIFICATION_ERROR_MS });
}
