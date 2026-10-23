import { createStore, produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { Channel, invoke } from '../lib/ipc';
import {
  asStoreVerificationRun,
  changedDuringRun,
  compileVerificationFailurePrompt,
} from '../lib/verification-run';
import { HELD_RUN_MESSAGE, pendingVerificationRun } from '../../electron/shared/verification-run';
import {
  VERIFY_CHECK_ID,
  type EvidenceScan,
  type EvidenceSkipReason,
} from '../../electron/shared/evidence';
import { planChecks, reusableVerifyRun } from '../lib/evidence-plan';
import type { VerificationRun } from '../ipc/types';
import { setStore, store } from './core';
import { getTaskChecks, isEvidenceBusy, putCheck } from './evidence-state';
import { isLandedTaskState } from './landing';
import { saveState } from './persistence';
import { getProject } from './projects';
import { stageTaskPrompt } from './staged-prompt';
import { sendPrompt } from './tasks';
import type { Task } from './types';

/** Live output is transient: it streams while a run is in flight and is
 *  replaced by the bounded tail of the persisted result once it finishes. */
const LIVE_OUTPUT_MAX_CHARS = 64 * 1024;
const [liveOutput, setLiveOutput] = createStore<Record<string, string>>({});
// Starting a run cancels the previous one for the same task. The cancelled
// run still resolves, and its late result must not overwrite the newer run.
const generations = new Map<string, number>();
// The generation of each task's background run, so only those are cancelled
// when the agent starts working again.
const backgroundGenerations = new Map<string, number>();
// Background runs between their start and the command: a cancel lands here.
const scanning = new Map<string, symbol>();

/** Why the background run skipped the task's current commit. */
export interface BackgroundVerifyHold {
  headSha: string;
  reason: EvidenceSkipReason;
}
const [holds, setHolds] = createStore<Record<string, BackgroundVerifyHold | undefined>>({});

export function getBackgroundVerifyHold(taskId: string): BackgroundVerifyHold | undefined {
  return holds[taskId];
}

export function getVerifyCommand(taskId: string): string | undefined {
  const task = store.tasks[taskId];
  return (task && getProject(task.projectId)?.verifyCommand) || undefined;
}

export function getVerificationOutput(taskId: string): string {
  return liveOutput[taskId] ?? store.tasks[taskId]?.verificationRun?.outputTail ?? '';
}

function appendLiveOutput(taskId: string, chunk: string): void {
  setLiveOutput(taskId, (prev) => {
    const next = (prev ?? '') + chunk;
    return next.length > LIVE_OUTPUT_MAX_CHARS ? next.slice(-LIVE_OUTPUT_MAX_CHARS) : next;
  });
}

function clearLiveOutput(taskId: string): void {
  setLiveOutput(
    produce((s) => {
      delete s[taskId];
    }),
  );
}

function setRun(taskId: string, run: VerificationRun | undefined): void {
  // The task may have been deleted while the run was in flight.
  if (!store.tasks[taskId]) return;
  setStore('tasks', taskId, 'verificationRun', run && asStoreVerificationRun(run));
  if (
    run?.status === 'passed' &&
    run.headSha &&
    run.finishedAt &&
    !run.dirty &&
    !changedDuringRun(run)
  )
    setStore('tasks', taskId, 'lastVerifyPass', {
      command: run.command,
      headSha: run.headSha,
      finishedAt: run.finishedAt,
    });
}

export interface VerificationRunOptions {
  /** Started by the app after an agent turn, not by a click: it runs at low
   *  priority, yields when the agent works again, and leaves no trace if held. */
  background?: boolean;
  /** Hold the run unless this HEAD is checked out on a clean tree. */
  expectedHeadSha?: string;
}

async function invokeRun(
  task: Task,
  pending: VerificationRun,
  channel: Channel<string>,
  options: VerificationRunOptions,
): Promise<VerificationRun> {
  try {
    return await invoke<VerificationRun>(IPC.RunTaskVerification, {
      taskId: task.id,
      worktreePath: task.worktreePath,
      command: pending.command,
      branchName: task.branchName,
      ...(options.expectedHeadSha ? { expectedHeadSha: options.expectedHeadSha } : {}),
      ...(options.background ? { lowPriority: true } : {}),
      onOutput: channel,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...pending, status: 'error', finishedAt: new Date().toISOString(), message };
  } finally {
    channel.dispose();
  }
}

/** Runs the project's verify command in the task worktree. Resolves with the
 *  finished run, or undefined when the task has no command to run. */
export async function runTaskVerification(
  taskId: string,
  options: VerificationRunOptions = {},
): Promise<VerificationRun | undefined> {
  const task = store.tasks[taskId];
  const command = getVerifyCommand(taskId);
  if (!task || !command) return undefined;
  const generation = (generations.get(taskId) ?? 0) + 1;
  generations.set(taskId, generation);
  if (options.background) backgroundGenerations.set(taskId, generation);
  else backgroundGenerations.delete(taskId);
  const isCurrent = () => generations.get(taskId) === generation;
  // A copy: the store merges the pending run into the same object.
  const previous = task.verificationRun && { ...task.verificationRun };

  const pending = pendingVerificationRun(command);
  setLiveOutput(taskId, '');
  setRun(taskId, pending);
  const channel = new Channel<string>();
  channel.onmessage = (chunk) => {
    if (isCurrent()) appendLiveOutput(taskId, chunk);
  };

  const run = await invokeRun(task, pending, channel, options);
  if (!isCurrent()) return run;
  backgroundGenerations.delete(taskId);
  clearLiveOutput(taskId);
  // A background run that was held or stopped says nothing about the code.
  setRun(taskId, options.background && run.status === 'cancelled' ? previous : run);
  showVerificationInEvidence(taskId);
  void saveState();
  return run;
}

/** Background runs follow the project setting; unset means on. */
export function backgroundVerifyEnabled(taskId: string): boolean {
  const task = store.tasks[taskId];
  const project = task && getProject(task.projectId);
  return Boolean(
    task &&
    project?.verifyCommand &&
    project.verifyAutoRun !== false &&
    task.gitIsolation === 'worktree' &&
    !task.dockerMode &&
    !isLandedTaskState(task.landingState),
  );
}

/**
 * Runs the verify command once per commit after an agent turn, through the
 * same execution gate as evidence builds. Resolves with the finished run, or
 * undefined when nothing ran: no new commit, already covered, held, or busy.
 * `stillIdle` is asked again right before the command starts, since the agent
 * may pick work back up while the change is scanned.
 */
export async function runBackgroundVerify(
  taskId: string,
  stillIdle: () => boolean = () => true,
): Promise<VerificationRun | undefined> {
  const task = store.tasks[taskId];
  const check = getTaskChecks(taskId).find((c) => c.id === VERIFY_CHECK_ID);
  if (!task || !check || !backgroundVerifyEnabled(taskId)) return undefined;
  const idle = () => {
    const current = store.tasks[taskId];
    return (
      stillIdle() &&
      current?.verificationRun?.status !== 'running' &&
      !(current?.evidence && isEvidenceBusy(current.evidence))
    );
  };
  if (!idle()) return undefined;
  // Claimed before the scan, so cancelling during it stops the run from starting.
  const claim = Symbol('background verify');
  scanning.set(taskId, claim);
  const scan = await invoke<EvidenceScan>(IPC.GetEvidenceScan, {
    worktreePath: task.worktreePath,
    baseBranch: task.baseBranch,
  }).catch(() => undefined);
  const claimed = scanning.get(taskId) === claim;
  if (claimed) scanning.delete(taskId);
  const current = store.tasks[taskId];
  if (!claimed || !scan || !current || !idle()) return undefined;
  if (scan.files.length === 0 || reusableVerifyRun(current.verificationRun, check, scan.headSha)) {
    setHolds(taskId, undefined);
    return undefined;
  }
  const plan = planChecks({
    checks: [check],
    dockerMode: Boolean(current.dockerMode),
    dirty: scan.dirty,
    truncated: scan.truncated,
    flags: scan.flags,
    acceptedFlags: current.evidence?.acceptedFlags ?? {},
  });
  const held = plan.skipped[0];
  setHolds(taskId, held ? { headSha: scan.headSha, reason: held.reason } : undefined);
  if (held) return undefined;
  const run = await runTaskVerification(taskId, {
    background: true,
    expectedHeadSha: scan.headSha,
  });
  // The runner found uncommitted changes when the command was about to start.
  if (run?.status === 'cancelled' && run.message === HELD_RUN_MESSAGE && run.dirty && run.headSha)
    setHolds(taskId, { headSha: run.headSha, reason: 'dirty' });
  return run;
}

/** Stops the task's background run, or keeps a scanning one from starting;
 *  a clicked run keeps going. */
export async function cancelBackgroundVerify(taskId: string): Promise<void> {
  scanning.delete(taskId);
  const generation = backgroundGenerations.get(taskId);
  if (generation === undefined || generation !== generations.get(taskId)) return;
  if (store.tasks[taskId]?.verificationRun?.status !== 'running') return;
  await cancelTaskVerification(taskId);
}

/** Puts a manual run into the evidence package of the same commit, so the
 *  package and the verify status agree. Busy builds reconcile when they finish. */
export function showVerificationInEvidence(taskId: string): void {
  const run = store.tasks[taskId]?.verificationRun;
  const pkg = store.tasks[taskId]?.evidence;
  const check = getTaskChecks(taskId).find((c) => c.id === VERIFY_CHECK_ID);
  if (!pkg || !check || !run || isEvidenceBusy(pkg)) return;
  const previous = pkg.checks.find((result) => result.checkId === VERIFY_CHECK_ID);
  if (previous && previous.startedAt > run.startedAt) return;
  const reused = reusableVerifyRun(run, check, pkg.scan.headSha);
  if (reused) putCheck(taskId, pkg.id, reused);
}

/** Takes over a verify run an evidence build made. A manual run still in
 *  flight, or one started later, is newer and wins. */
export function adoptVerificationRun(taskId: string, run: VerificationRun): void {
  const current = store.tasks[taskId]?.verificationRun;
  if (run.status === 'cancelled') return;
  if (current && (current.status === 'running' || current.startedAt > run.startedAt)) return;
  setRun(taskId, run);
}

export function cancelTaskVerification(taskId: string): Promise<boolean> {
  return invoke<boolean>(IPC.CancelTaskVerification, { taskId });
}

/** Hands the last failing run to the agent as a prompt. Returns false when
 *  there is nothing to send (no run, still running, or it passed). */
export async function sendVerificationFailureToAgent(
  taskId: string,
  agentId: string,
): Promise<boolean> {
  const prompt = verificationFailurePrompt(taskId);
  if (!prompt) return false;
  await sendPrompt(taskId, agentId, prompt);
  return true;
}

/** Puts the same prompt in the task's input instead, for the user to send. */
export function stageVerificationFailurePrompt(taskId: string): boolean {
  const prompt = verificationFailurePrompt(taskId);
  if (!prompt) return false;
  stageTaskPrompt(taskId, prompt);
  return true;
}

function verificationFailurePrompt(taskId: string): string | undefined {
  const task = store.tasks[taskId];
  const run = task?.verificationRun;
  if (!run || run.status === 'running' || run.status === 'passed') return undefined;
  return compileVerificationFailurePrompt(run, task.lastVerifyPass);
}
