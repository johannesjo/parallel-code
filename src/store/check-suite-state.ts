import { createStore, produce } from 'solid-js/store';
import type { SuiteCheckRun, CheckSuite, ProjectCheck } from '../../electron/shared/checks';
import { effectiveChecks } from '../../electron/shared/check-settings';
import { setStore, store } from './core';
import { getProject } from './projects';

/** Transient per-task state that is never persisted. */
interface CheckSuiteUiState {
  scanning?: boolean;
  error?: string;
}
const [ui, setCheckSuiteUi] = createStore<Record<string, CheckSuiteUiState>>({});
export { setCheckSuiteUi };

export function getCheckSuiteUiState(taskId: string): CheckSuiteUiState {
  return ui[taskId] ?? {};
}

export function getTaskChecks(taskId: string): ProjectCheck[] {
  const task = store.tasks[taskId];
  return task ? getProjectChecks(task.projectId) : [];
}

/** The checks a project runs, the verify command first. */
export function getProjectChecks(projectId: string): ProjectCheck[] {
  return effectiveChecks(getProject(projectId) ?? {});
}

export function replaceCheckSuite(taskId: string, pkg: CheckSuite): void {
  if (!store.tasks[taskId]) return;
  // Assigning replaces the record; a plain setStore would merge old keys back in.
  setStore(
    'tasks',
    taskId,
    produce((task) => {
      task.evidence = pkg;
    }),
  );
}

/** Edits the package only while it is still the one `packageId` names. */
export function updateCheckSuite(
  taskId: string,
  packageId: string,
  edit: (pkg: CheckSuite) => void,
): void {
  if (store.tasks[taskId]?.evidence?.id !== packageId) return;
  setStore(
    'tasks',
    taskId,
    produce((task) => {
      if (task.evidence) edit(task.evidence);
    }),
  );
}

/** Sets one check's result, replacing an earlier run or skip of the same check. */
export function putCheck(taskId: string, packageId: string, run: SuiteCheckRun): void {
  updateCheckSuite(taskId, packageId, (pkg) => {
    const index = pkg.checks.findIndex((existing) => existing.checkId === run.checkId);
    if (index >= 0) pkg.checks[index] = run;
    else pkg.checks.push(run);
    pkg.skipped = pkg.skipped.filter((skip) => skip.checkId !== run.checkId);
  });
}

export function isCheckSuiteBusy(pkg: CheckSuite): boolean {
  return pkg.assembling || pkg.checks.some((run) => run.status === 'running');
}
