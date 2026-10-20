import { createStore, produce } from 'solid-js/store';
import type {
  EvidenceCheckRun,
  EvidencePackage,
  ProjectCheck,
} from '../../electron/shared/evidence';
import {
  computeEvidenceConfidence,
  type EvidenceConfidence,
} from '../../electron/shared/evidence-confidence';
import { effectiveChecks } from '../../electron/shared/evidence-settings';
import { setStore, store } from './core';
import { saveState } from './persistence';
import { getProject } from './projects';
import type { Task } from './types';

/** Transient per-task state that is never persisted. */
interface EvidenceUiState {
  scanning?: boolean;
  error?: string;
  /** Live output per running evidence check, by check id. */
  outputs?: Record<string, string>;
}
const [ui, setEvidenceUi] = createStore<Record<string, EvidenceUiState>>({});
export { setEvidenceUi };

export function getEvidenceUiState(taskId: string): EvidenceUiState {
  return ui[taskId] ?? {};
}

/** Sets or, with `undefined`, drops one check's live output. */
export function setCheckOutput(taskId: string, checkId: string, output: string | undefined): void {
  setEvidenceUi(taskId, (state) => {
    const outputs = { ...state?.outputs };
    if (output === undefined) delete outputs[checkId];
    else outputs[checkId] = output;
    return { ...state, outputs };
  });
}

export function getTaskChecks(taskId: string): ProjectCheck[] {
  const task = store.tasks[taskId];
  return effectiveChecks((task && getProject(task.projectId)) ?? {});
}

/** The worktree state evidence is judged against; callers pick the freshest source they have. */
interface EvidenceGitState {
  head_sha?: string | null;
  has_uncommitted_changes?: boolean;
}

/** One place that decides which inputs confidence uses, so badge, panel and readiness agree. */
export function getEvidenceConfidence(
  task: Task,
  git: EvidenceGitState | undefined,
): EvidenceConfidence | undefined {
  if (!task.evidence) return undefined;
  return computeEvidenceConfidence(task.evidence, git?.head_sha, {
    dirty: git?.has_uncommitted_changes,
    checks: getTaskChecks(task.id),
  });
}

export function replaceEvidence(taskId: string, pkg: EvidencePackage): void {
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
export function updateEvidence(
  taskId: string,
  packageId: string,
  edit: (pkg: EvidencePackage) => void,
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
export function putCheck(taskId: string, packageId: string, run: EvidenceCheckRun): void {
  updateEvidence(taskId, packageId, (pkg) => {
    const index = pkg.checks.findIndex((existing) => existing.checkId === run.checkId);
    if (index >= 0) pkg.checks[index] = run;
    else pkg.checks.push(run);
    pkg.skipped = pkg.skipped.filter((skip) => skip.checkId !== run.checkId);
  });
}

export function isEvidenceBusy(pkg: EvidencePackage): boolean {
  return pkg.assembling || pkg.checks.some((run) => run.status === 'running');
}

export function acceptEvidenceFlag(taskId: string, flagId: string, reason: string): void {
  const pkg = store.tasks[taskId]?.evidence;
  if (!pkg || !reason.trim()) return;
  updateEvidence(taskId, pkg.id, (p) => {
    p.acceptedFlags[flagId] = reason.trim();
  });
  void saveState();
}

export function dismissEvidenceFinding(taskId: string, findingId: string): void {
  const pkg = store.tasks[taskId]?.evidence;
  if (!pkg || pkg.dismissedFindings.includes(findingId)) return;
  updateEvidence(taskId, pkg.id, (p) => {
    p.dismissedFindings.push(findingId);
  });
  void saveState();
}

export function restoreEvidenceFinding(taskId: string, findingId: string): void {
  const pkg = store.tasks[taskId]?.evidence;
  if (!pkg) return;
  updateEvidence(taskId, pkg.id, (p) => {
    p.dismissedFindings = p.dismissedFindings.filter((id) => id !== findingId);
  });
  void saveState();
}

export function reopenEvidenceFlag(taskId: string, flagId: string): void {
  const pkg = store.tasks[taskId]?.evidence;
  if (!pkg) return;
  updateEvidence(taskId, pkg.id, (p) => {
    delete p.acceptedFlags[flagId];
  });
  void saveState();
}
