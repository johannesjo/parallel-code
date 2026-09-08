import { createStore, produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { Channel, invoke } from '../lib/ipc';
import { asStoreVerificationRun, compileVerificationFailurePrompt } from '../lib/verification-run';
import { pendingVerificationRun } from '../../electron/shared/verification-run';
import type { VerificationRun } from '../ipc/types';
import { setStore, store } from './core';
import { saveState } from './persistence';
import { getProject } from './projects';
import { sendPrompt } from './tasks';
import type { Task } from './types';

/** Live output is transient: it streams while a run is in flight and is
 *  replaced by the bounded tail of the persisted result once it finishes. */
const LIVE_OUTPUT_MAX_CHARS = 64 * 1024;
const [liveOutput, setLiveOutput] = createStore<Record<string, string>>({});
// Starting a run cancels the previous one for the same task. The cancelled
// run still resolves, and its late result must not overwrite the newer run.
const generations = new Map<string, number>();

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

function setRun(taskId: string, run: VerificationRun): void {
  // The task may have been deleted while the run was in flight.
  if (!store.tasks[taskId]) return;
  setStore('tasks', taskId, 'verificationRun', asStoreVerificationRun(run));
}

async function invokeRun(
  task: Task,
  pending: VerificationRun,
  channel: Channel<string>,
): Promise<VerificationRun> {
  try {
    return await invoke<VerificationRun>(IPC.RunTaskVerification, {
      taskId: task.id,
      worktreePath: task.worktreePath,
      command: pending.command,
      branchName: task.branchName,
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
export async function runTaskVerification(taskId: string): Promise<VerificationRun | undefined> {
  const task = store.tasks[taskId];
  const command = getVerifyCommand(taskId);
  if (!task || !command) return undefined;
  const generation = (generations.get(taskId) ?? 0) + 1;
  generations.set(taskId, generation);
  const isCurrent = () => generations.get(taskId) === generation;

  const pending = pendingVerificationRun(command);
  setLiveOutput(taskId, '');
  setRun(taskId, pending);
  const channel = new Channel<string>();
  channel.onmessage = (chunk) => {
    if (isCurrent()) appendLiveOutput(taskId, chunk);
  };

  const run = await invokeRun(task, pending, channel);
  if (!isCurrent()) return run;
  clearLiveOutput(taskId);
  setRun(taskId, run);
  void saveState();
  return run;
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
  const run = store.tasks[taskId]?.verificationRun;
  if (!run || run.status === 'running' || run.status === 'passed') return false;
  await sendPrompt(taskId, agentId, compileVerificationFailurePrompt(run));
  return true;
}
