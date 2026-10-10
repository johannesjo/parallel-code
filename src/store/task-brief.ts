import { createEffect, createRoot, untrack } from 'solid-js';
import { TASK_NAME_MODELS } from '../../electron/shared/task-name-model';
import { parseConfidencePayload } from '../../electron/shared/task-confidence';
import { startEvidenceModelRequest } from '../lib/evidence-model-request';
import { getTaskDiffBaseBranch, loadTaskDiff } from '../lib/load-task-diff';
import { errMessage, info as logInfo, warn as logWarn } from '../lib/log';
import {
  appendBriefTurn,
  buildTaskBriefPrompt,
  carryDecisionStates,
  diffFingerprint,
  diffPaths,
  parseTaskBriefResponse,
  type BriefDecisionState,
} from '../lib/task-brief';
import { DEFAULT_CONFIDENCE_PROMPT } from '../lib/task-confidence';
import { getAgentHookStatus } from './agentHookStatus';
import { store, setStore } from './core';
import { getProjectPath } from './projects';
import { getAgentOutputTail, isTaskWorking, normalizeCurrentFrame } from './taskStatus';
import { sendPrompt } from './tasks';
import type { Task } from './types';

/** A turn has to stay finished this long before it is summarised. */
const TURN_SETTLE_MS = 4_000;
/** Terminal heuristics can flicker between busy and idle; never brief more often than this. */
const MIN_BRIEF_INTERVAL_MS = 45_000;

const inFlight = new Map<string, { cancel: () => void }>();
/** Tasks whose turn ended again while their brief was being written. */
const rerun = new Set<string>();

function isLiveTask(task: Task | undefined): task is Task {
  return !!task && !task.closingStatus && !!task.worktreePath;
}

async function readTaskDiff(task: Task): Promise<string> {
  if (task.gitIsolation === 'none') return '';
  try {
    const { rawDiff } = await loadTaskDiff({
      worktreePath: task.worktreePath,
      projectRoot: getProjectPath(task.projectId),
      branchName: task.branchName,
      baseBranch: getTaskDiffBaseBranch(task.gitIsolation, task.baseBranch),
    });
    return rawDiff;
  } catch (error) {
    logWarn('taskBrief', 'Could not read the task diff', { error: errMessage(error) });
    return '';
  }
}

/** The agent's own end-of-turn message when hooks report it, else its visible screen. */
function latestAgentMessage(task: Task): string {
  let best: { at: number; text: string } | undefined;
  for (const agentId of task.agentIds) {
    const hook = getAgentHookStatus(agentId);
    const text = hook?.lastAssistantMessage?.trim();
    if (hook && text && (!best || hook.updatedAt > best.at)) best = { at: hook.updatedAt, text };
  }
  if (best) return best.text;
  const agentId = task.agentIds[0];
  return agentId ? normalizeCurrentFrame(getAgentOutputTail(agentId)) : '';
}

/** Prompts sent since the previous brief; the newest one when timestamps are missing. */
function promptsSince(task: Task, since: number): string[] {
  const history = task.promptHistory ?? [];
  const recent = history.filter((entry) => (entry.sentAt ?? 0) > since).map((e) => e.text);
  if (recent.length) return recent;
  if (since === 0 && task.savedInitialPrompt) return [task.savedInitialPrompt];
  return task.lastPrompt ? [task.lastPrompt] : [];
}

/**
 * Rewrites the task's brief from the previous one, the prompts of the turn, the
 * agent's last message and the branch diff. One request per task at a time; a
 * turn that ends meanwhile queues one more run.
 */
export async function refreshTaskBrief(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!store.taskBriefs || !isLiveTask(task)) return;
  if (inFlight.has(taskId)) {
    rerun.add(taskId);
    return;
  }
  let cancelled = false;
  const handle = {
    cancel: () => {
      cancelled = true;
    },
  };
  inFlight.set(taskId, handle);
  setStore('tasks', taskId, 'briefStatus', { state: 'generating' });
  const startedAt = Date.now();
  try {
    const previous = task.brief;
    const rawDiff = await readTaskDiff(task);
    if (cancelled) return;
    const prompts = promptsSince(task, previous?.generatedAt ?? 0);
    const request = startEvidenceModelRequest({
      prompt: buildTaskBriefPrompt({
        taskName: task.name,
        prompts,
        previous: previous?.brief,
        agentMessage: latestAgentMessage(task),
        rawDiff,
      }),
      cwd: task.worktreePath,
      settings: TASK_NAME_MODELS[store.taskNameModel],
      agentEnvFiles: store.agentEnvFiles,
      purpose: 'brief',
    });
    handle.cancel = () => {
      cancelled = true;
      request.cancel();
    };
    const response = await request.result;
    if (cancelled || !isLiveTask(store.tasks[taskId])) return;
    const { brief, turnOutcome } = parseTaskBriefResponse(response, diffPaths(rawDiff));
    const current = store.tasks[taskId].brief;
    setStore('tasks', taskId, 'brief', {
      brief,
      generatedAt: Date.now(),
      fingerprint: diffFingerprint(rawDiff),
      turns: appendBriefTurn(current?.turns ?? [], {
        prompt: prompts.at(-1) ?? '',
        outcome: turnOutcome || brief.headline,
        endedAt: startedAt,
      }),
      decisions: carryDecisionStates(current?.decisions, brief.decided),
    });
    setStore('tasks', taskId, 'briefStatus', undefined);
    logInfo('taskBrief', 'Brief updated', { taskId, durationMs: Date.now() - startedAt });
  } catch (error) {
    if (cancelled || !store.tasks[taskId]) return;
    const message = errMessage(error);
    logWarn('taskBrief', 'Brief generation failed', { taskId, error: message });
    setStore('tasks', taskId, 'briefStatus', { state: 'failed', message });
  } finally {
    if (inFlight.get(taskId) === handle) inFlight.delete(taskId);
    if (cancelled && store.tasks[taskId]?.briefStatus?.state === 'generating')
      setStore('tasks', taskId, 'briefStatus', undefined);
    if (rerun.delete(taskId)) void refreshTaskBrief(taskId);
  }
}

/**
 * Writes a brief whenever a task's agents go from working to finished and stay
 * there for a moment. Returns the stop function.
 */
export function startTaskBriefWatcher(): () => void {
  return createRoot((dispose) => {
    const working = new Map<string, boolean>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const lastRun = new Map<string, number>();

    function clearTimer(taskId: string): void {
      const timer = timers.get(taskId);
      if (timer !== undefined) clearTimeout(timer);
      timers.delete(taskId);
    }

    function schedule(taskId: string): void {
      clearTimer(taskId);
      const sinceLast = Date.now() - (lastRun.get(taskId) ?? 0);
      const delay = Math.max(TURN_SETTLE_MS, MIN_BRIEF_INTERVAL_MS - sinceLast);
      timers.set(
        taskId,
        setTimeout(() => {
          timers.delete(taskId);
          if (isTaskWorking(taskId)) return;
          lastRun.set(taskId, Date.now());
          void refreshTaskBrief(taskId);
        }, delay),
      );
    }

    createEffect(() => {
      if (!store.taskBriefs) return;
      const ids = new Set(store.taskOrder);
      for (const taskId of ids) {
        const now = isTaskWorking(taskId);
        const was = untrack(() => working.get(taskId)) ?? false;
        working.set(taskId, now);
        if (now) clearTimer(taskId);
        else if (was) schedule(taskId);
      }
      for (const taskId of [...working.keys()]) {
        if (ids.has(taskId)) continue;
        working.delete(taskId);
        clearTimer(taskId);
        inFlight.get(taskId)?.cancel();
      }
    });

    return () => {
      for (const taskId of [...timers.keys()]) clearTimer(taskId);
      for (const handle of inFlight.values()) handle.cancel();
      dispose();
    };
  });
}

function setDecisionState(taskId: string, text: string, state: BriefDecisionState | undefined) {
  if (!store.tasks[taskId]?.brief) return;
  setStore('tasks', taskId, 'brief', 'decisions', (prev) => {
    const next = { ...prev };
    if (state) next[text] = state;
    else delete next[text];
    return next;
  });
}

export function keepBriefDecision(taskId: string, text: string): void {
  setDecisionState(taskId, text, 'kept');
}

export function reopenBriefDecision(taskId: string, text: string): void {
  setDecisionState(taskId, text, undefined);
}

function mainAgentId(task: Task): string | undefined {
  return task.selectedAgentId && task.agentIds.includes(task.selectedAgentId)
    ? task.selectedAgentId
    : task.agentIds[0];
}

/** Sends the user's correction of a decision to the task's agent, then marks it. */
export async function changeBriefDecision(
  taskId: string,
  text: string,
  correction: string,
): Promise<void> {
  const task = store.tasks[taskId];
  const agentId = task && mainAgentId(task);
  if (!agentId) throw new Error('This task has no agent to send the change to.');
  await sendPrompt(taskId, agentId, correction.trim());
  setDecisionState(taskId, text, 'sent');
}

/** Asks the task's agent to rate its work and publish it with confidence_publish. */
export async function requestConfidenceRating(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  const agentId = task && mainAgentId(task);
  if (!agentId) throw new Error('This task has no agent to ask.');
  await sendPrompt(taskId, agentId, store.confidencePrompt.trim() || DEFAULT_CONFIDENCE_PROMPT);
}

/**
 * Stores a rating the agent published. The diff is read afterwards so the card
 * can tell when later work makes the rating out of date.
 */
export function publishTaskConfidence(taskId: string, input: unknown): void {
  const payload = parseConfidencePayload(input);
  const task = store.tasks[taskId];
  if (!Object.hasOwn(store.tasks, taskId) || !task || task.closingStatus)
    throw new Error('Task not available.');
  const publishedAt = Date.now();
  setStore('tasks', taskId, 'confidence', { ...payload, publishedAt });
  void readTaskDiff(task).then((rawDiff) => {
    if (store.tasks[taskId]?.confidence?.publishedAt !== publishedAt) return;
    setStore('tasks', taskId, 'confidence', 'fingerprint', diffFingerprint(rawDiff));
  });
}
