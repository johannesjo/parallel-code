import { IPC } from '../../electron/ipc/channels';
import {
  VERIFY_CHECK_ID,
  type EvidenceCheckRun,
  type EvidenceClaim,
  type EvidencePackage,
  type EvidenceScan,
  type EvidenceSubmission,
  type ProjectCheck,
} from '../../electron/shared/evidence';
import { DEFAULT_EVIDENCE_MODEL } from '../../electron/shared/evidence-settings';
import { pendingVerificationRun } from '../../electron/shared/verification-run';
import {
  compileEvidencePrompt,
  compileEvidenceQuestion,
  type EvidenceQuestion,
  evidenceForAgent,
  planChecks,
  reusableVerifyRun,
} from '../lib/evidence-plan';
import { shouldRunModel } from '../lib/evidence-review';
import { Channel, invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import type { VerificationRun } from '../ipc/types';
import { store } from './core';
import { cancelEvidenceReview, runEvidenceReview } from './evidence-review';
import {
  getEvidenceUiState,
  getTaskChecks,
  isEvidenceBusy,
  putCheck,
  replaceEvidence,
  setCheckOutput,
  setEvidenceUi as setUi,
  updateEvidence,
} from './evidence-state';
import { saveState } from './persistence';
import { getProject } from './projects';
import { sendPrompt } from './tasks';
import { adoptVerificationRun, showVerificationInEvidence } from './verification';
import type { Task } from './types';

const LIVE_OUTPUT_MAX_CHARS = 64 * 1024;
// A rebuild supersedes the previous build; its late results must not land.
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
): Promise<EvidenceCheckRun> {
  const label = { checkId: check.id, name: check.name, kind: check.kind };
  const pending = pendingVerificationRun(check.command);
  const channel = new Channel<string>();
  setCheckOutput(task.id, check.id, '');
  channel.onmessage = (chunk) => {
    const prev = getEvidenceUiState(task.id).outputs?.[check.id] ?? '';
    setCheckOutput(task.id, check.id, (prev + chunk).slice(-LIVE_OUTPUT_MAX_CHARS));
  };
  try {
    const run = await invoke<VerificationRun>(IPC.RunTaskVerification, {
      taskId: task.id,
      worktreePath: task.worktreePath,
      command: check.command,
      branchName: task.branchName,
      evidence: true,
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
    setCheckOutput(task.id, check.id, undefined);
  }
}

async function runCheck(
  task: Task,
  packageId: string,
  check: ProjectCheck,
  expectedHeadSha?: string,
): Promise<EvidenceCheckRun> {
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
    showVerificationInEvidence(task.id);
    if (!store.tasks[task.id]?.evidence?.assembling) void saveState();
  }
  return run;
}

/** The verification-run part of a check run, without the evidence labels. */
function plainRun(run: EvidenceCheckRun): VerificationRun {
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

function freshPackage(
  previous: EvidencePackage | undefined,
  scan: EvidenceScan,
  options: { trigger: EvidencePackage['trigger']; claim?: EvidenceClaim },
): EvidencePackage {
  const sameCommit = previous?.scan.headSha === scan.headSha;
  const review = sameCommit && previous?.review?.status === 'done' ? previous.review : undefined;
  const flagIds = new Set(scan.flags.map((flag) => flag.id));
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    trigger: options.trigger,
    assembling: true,
    scan,
    checks: [],
    skipped: [],
    // A manual rebuild of the same commit keeps what the agent said about it.
    claim: options.claim ?? (sameCommit ? previous?.claim : undefined),
    review,
    acceptedFlags: Object.fromEntries(
      Object.entries(previous?.acceptedFlags ?? {}).filter(([id]) => flagIds.has(id)),
    ),
    dismissedFindings: review ? (previous?.dismissedFindings ?? []) : [],
  };
}

async function scanTask(task: Task): Promise<EvidenceScan | undefined> {
  setUi(task.id, { scanning: true, error: undefined });
  try {
    return await invoke<EvidenceScan>(IPC.GetEvidenceScan, {
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

function isReviewRunning(pkg: EvidencePackage): boolean {
  return pkg.review?.status === 'running';
}

/** Only new commits are worth a background build; the package is per commit. */
function worthAutoBuild(previous: EvidencePackage | undefined, scan: EvidenceScan): boolean {
  return scan.files.length > 0 && previous?.scan.headSha !== scan.headSha;
}

/**
 * Builds a new package: scans the change, then runs the checks the execution
 * gate allows, one at a time so they never compete for the same ports or
 * caches. Calls the model afterwards when the project asks for it.
 */
export async function buildEvidence(
  taskId: string,
  options: { trigger: EvidencePackage['trigger']; claim?: EvidenceClaim },
): Promise<void> {
  const task = store.tasks[taskId];
  if (!task) return;
  const auto = options.trigger === 'auto';
  // A background build yields to anything the reviewer or agent started.
  if (auto && task.evidence && (isEvidenceBusy(task.evidence) || isReviewRunning(task.evidence)))
    return;
  const isCurrent = nextGeneration(taskId);
  cancelEvidenceReview(taskId);
  if (task.evidence?.assembling || task.evidence?.checks.some((r) => r.status === 'running'))
    await cancelEvidenceChecks(taskId);
  const scan = await scanTask(task);
  if (!scan || !isCurrent()) return;
  if (auto && !worthAutoBuild(store.tasks[taskId]?.evidence, scan)) return;
  const pkg = freshPackage(store.tasks[taskId]?.evidence, scan, options);
  const checks = getTaskChecks(taskId).map((check) => ({ ...check }));
  const plan = planChecks({
    checks,
    dockerMode: Boolean(task.dockerMode),
    flags: scan.flags,
    dirty: scan.dirty,
    truncated: scan.truncated,
    acceptedFlags: pkg.acceptedFlags,
  });
  replaceEvidence(taskId, {
    ...pkg,
    configuredChecks: checks,
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
  updateEvidence(taskId, pkg.id, (p) => {
    p.assembling = false;
  });
  showVerificationInEvidence(taskId);
  void saveState();
  const settings = getProject(task.projectId)?.evidenceModel ?? DEFAULT_EVIDENCE_MODEL;
  if (shouldRunModel(settings, pkg)) void runEvidenceReview(taskId);
}

/**
 * Runs one check on the reviewer's click, including ones the gate held back.
 * Different checks may run side by side; the reviewer chose to, unlike a build,
 * which runs them one at a time.
 */
export async function runEvidenceCheck(taskId: string, checkId: string): Promise<void> {
  const task = store.tasks[taskId];
  const pkg = task?.evidence;
  const check = getTaskChecks(taskId).find((c) => c.id === checkId);
  if (!task || !pkg || !check || pkg.assembling) return;
  if (pkg.checks.some((run) => run.checkId === checkId && run.status === 'running')) return;
  await runCheck(task, pkg.id, check);
  showVerificationInEvidence(taskId);
  void saveState();
}

/** Cancels one evidence check, or all of them without a `checkId`. */
export function cancelEvidenceChecks(taskId: string, checkId?: string): Promise<boolean> {
  return invoke<boolean>(IPC.CancelTaskVerification, {
    taskId,
    evidence: true,
    ...(checkId ? { checkId } : {}),
  });
}

/** Stops a build: the running check is cancelled and no further check starts. */
export async function stopEvidence(taskId: string): Promise<void> {
  nextGeneration(taskId);
  await cancelEvidenceChecks(taskId);
  const pkg = store.tasks[taskId]?.evidence;
  if (pkg)
    updateEvidence(taskId, pkg.id, (p) => {
      p.assembling = false;
    });
  showVerificationInEvidence(taskId);
  void saveState();
}

/** Sends repair requests or a selected question; delivery never resolves an issue. */
export async function sendEvidenceToAgent(
  taskId: string,
  agentId: string,
  question?: EvidenceQuestion,
  packageId?: string,
): Promise<boolean> {
  const pkg = store.tasks[taskId]?.evidence;
  if (!pkg || (packageId && pkg.id !== packageId)) return false;
  const prompt = question ? compileEvidenceQuestion(pkg, question) : compileEvidencePrompt(pkg);
  if (!prompt) return false;
  await sendPrompt(taskId, agentId, prompt);
  if (store.tasks[taskId]?.evidence?.id === pkg.id) {
    const key = question ? JSON.stringify(question) : 'fix';
    updateEvidence(taskId, pkg.id, (current) => {
      current.sentToAgent = [...new Set([...(current.sentToAgent ?? []), key])];
    });
    void saveState();
  }
  return true;
}

/**
 * The `submit_evidence` entry point. Building takes as long as the checks, so
 * it starts in the background and the agent gets an answer right away.
 */
export function submitEvidence(taskId: string, submission: EvidenceSubmission) {
  if (!store.tasks[taskId]) throw new Error('Task not found.');
  const claim: EvidenceClaim = { ...submission, submittedAt: new Date().toISOString() };
  buildEvidence(taskId, { trigger: 'agent', claim }).catch((err) => {
    console.error('Evidence build after submit failed:', err);
  });
  return {
    status: 'building',
    message:
      'The app is scanning the change and running the configured checks. The reviewer sees the result; you do not need to wait for it.',
  };
}

/** The `get_evidence` answer for the task's agent. */
export function getEvidenceForAgent(taskId: string) {
  if (!store.tasks[taskId]) throw new Error('Task not found.');
  return evidenceForAgent(
    store.tasks[taskId]?.evidence,
    getTaskChecks(taskId),
    store.taskGitStatus[taskId]?.head_sha,
    store.taskGitStatus[taskId]?.has_uncommitted_changes,
  );
}
