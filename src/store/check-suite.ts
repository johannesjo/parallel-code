import { IPC } from '../../electron/ipc/channels';
import {
  VERIFY_CHECK_ID,
  type SuiteCheckRun,
  type CheckSuite,
  type ChangeScan,
  type ProjectCheck,
} from '../../electron/shared/checks';
import { pendingVerificationRun } from '../../electron/shared/verification-run';
import { compileCheckFailurePrompt, planChecks, reusableVerifyRun } from '../lib/check-plan';
import { Channel, invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import type { VerificationRun } from '../ipc/types';
import { store } from './core';
import {
  getTaskChecks,
  putCheck,
  replaceCheckSuite,
  setCheckSuiteUi as setUi,
  updateCheckSuite,
} from './check-suite-state';
import { saveState } from './persistence';
import { stageTaskPrompt } from './staged-prompt';
import {
  adoptVerificationRun,
  cancelBackgroundVerify,
  showVerificationInCheckSuite,
} from './verification';
import type { Task } from './types';

// A new run supersedes the previous one; its late results must not land.
const generations = new Map<string, number>();

function nextGeneration(taskId: string): () => boolean {
  const generation = (generations.get(taskId) ?? 0) + 1;
  generations.set(taskId, generation);
  return () => generations.get(taskId) === generation;
}

async function executeCheck(
  task: Task,
  check: ProjectCheck,
  expectedHeadSha?: string,
): Promise<SuiteCheckRun> {
  const label = { checkId: check.id, name: check.name, kind: check.kind };
  const pending = pendingVerificationRun(check.command);
  // The runner streams to a channel; nothing shows suite output live, only its tail.
  const channel = new Channel<string>();
  try {
    const run = await invoke<VerificationRun>(IPC.RunTaskVerification, {
      taskId: task.id,
      worktreePath: task.worktreePath,
      command: check.command,
      branchName: task.branchName,
      checkSuite: true,
      checkId: check.id,
      expectedHeadSha,
      onOutput: channel,
    });
    return { ...run, ...label };
  } catch (err) {
    return {
      ...pending,
      ...label,
      status: 'error',
      finishedAt: new Date().toISOString(),
      message: errMessage(err),
    };
  } finally {
    channel.dispose();
  }
}

async function runCheck(
  task: Task,
  packageId: string,
  check: ProjectCheck,
  expectedHeadSha?: string,
): Promise<SuiteCheckRun> {
  putCheck(task.id, packageId, {
    ...pendingVerificationRun(check.command),
    checkId: check.id,
    name: check.name,
    kind: check.kind,
  });
  const run = await executeCheck(task, check, expectedHeadSha);
  putCheck(task.id, packageId, run);
  if (store.tasks[task.id]?.evidence?.id === packageId) {
    if (check.id === VERIFY_CHECK_ID) adoptVerificationRun(task.id, plainRun(run));
    // Stop can finish before the runner settles; reconcile from either side.
    showVerificationInCheckSuite(task.id);
    if (!store.tasks[task.id]?.evidence?.assembling) void saveState();
  }
  return run;
}

/** The verification-run part of a check run, without the suite labels. */
function plainRun(run: SuiteCheckRun): VerificationRun {
  return {
    command: run.command,
    status: run.status,
    exitCode: run.exitCode,
    headSha: run.headSha,
    dirty: run.dirty,
    headShaAfter: run.headShaAfter,
    dirtyAfter: run.dirtyAfter,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    outputTail: run.outputTail,
    message: run.message,
  };
}

function freshPackage(scan: ChangeScan): CheckSuite {
  return {
    id: crypto.randomUUID(),
    assembling: true,
    scan,
    checks: [],
    skipped: [],
  };
}

async function scanTask(task: Task): Promise<ChangeScan | undefined> {
  setUi(task.id, { scanning: true, error: undefined });
  try {
    return await invoke<ChangeScan>(IPC.GetChangeScan, {
      worktreePath: task.worktreePath,
      baseBranch: task.baseBranch,
    });
  } catch (err) {
    setUi(task.id, 'error', `Could not scan the change: ${errMessage(err)}`);
    return undefined;
  } finally {
    setUi(task.id, 'scanning', false);
  }
}

/**
 * Starts a new check suite: scans the change, then runs the checks the execution
 * gate allows, one at a time so they never compete for the same ports or
 * caches.
 */
export async function runCheckSuite(
  taskId: string,
  options: {
    /** Runs only these checks, as picked for a review. */
    only?: readonly string[];
  } = {},
): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;
  const isCurrent = nextGeneration(taskId);
  // The build runs verify itself; two copies in one worktree collide.
  await cancelBackgroundVerify(taskId);
  if (!isCurrent()) return;
  if (task.evidence?.assembling || task.evidence?.checks.some((r) => r.status === 'running'))
    await cancelSuiteChecks(taskId);
  const scan = await scanTask(task);
  if (!scan || !isCurrent()) return;
  const pkg = freshPackage(scan);
  const checks = getTaskChecks(taskId).map((check) => ({ ...check }));
  const { only } = options;
  // A check picked for a review runs even when it is on-demand; every other gate still holds.
  const planned = only
    ? checks
        .filter((check) => only.includes(check.id))
        .map((check) => ({ ...check, run: 'auto' as const }))
    : checks;
  const plan = planChecks({
    checks: planned,
    dockerMode: Boolean(task.dockerMode),
    flags: scan.flags,
    dirty: scan.dirty,
    truncated: scan.truncated,
  });
  replaceCheckSuite(taskId, {
    ...pkg,
    skipped: plan.skipped,
  });
  for (const check of plan.run) {
    if (!isCurrent()) return;
    const reused = reusableVerifyRun(store.tasks[taskId]?.verificationRun, check, scan.headSha);
    if (reused) putCheck(taskId, pkg.id, reused);
    else {
      const run = await runCheck(task, pkg.id, check, scan.headSha);
      if (run.status === 'cancelled') break;
    }
  }
  if (!isCurrent()) return;
  updateCheckSuite(taskId, pkg.id, (p) => {
    p.assembling = false;
  });
  showVerificationInCheckSuite(taskId);
  void saveState();
}

/** Cancels one suite check, or all of them without a `checkId`. */
export function cancelSuiteChecks(taskId: string, checkId?: string): Promise<boolean> {
  return invoke<boolean>(IPC.CancelTaskVerification, {
    taskId,
    checkSuite: true,
    ...(checkId ? { checkId } : {}),
  });
}

/** Stops a build: the running check is cancelled and no further check starts. */
export async function stopCheckSuite(taskId: string): Promise<void> {
  nextGeneration(taskId);
  await cancelSuiteChecks(taskId);
  const pkg = store.tasks[taskId]?.evidence;
  if (pkg)
    updateCheckSuite(taskId, pkg.id, (p) => {
      p.assembling = false;
    });
  showVerificationInCheckSuite(taskId);
  void saveState();
}

/** Puts the failed non-verify checks in the task's input for the user to send. */
export function stageCheckFailurePrompt(taskId: string): boolean {
  const runs = store.tasks[taskId]?.evidence?.checks ?? [];
  const prompt = compileCheckFailurePrompt(runs.filter((run) => run.checkId !== VERIFY_CHECK_ID));
  if (!prompt) return false;
  stageTaskPrompt(taskId, prompt);
  return true;
}
