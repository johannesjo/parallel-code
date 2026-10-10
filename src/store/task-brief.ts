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
import { isAgentChat } from './agent-chat';
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

/** The branch diff, '' when the task has no git, or undefined when it could not be read. */
async function readTaskDiff(task: Task): Promise<string | undefined> {
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
    return undefined;
  }
}

/**
 * The agent's own end-of-turn message: the last chat reply, the hook-reported
 * message, or else its visible terminal screen.
 */
function latestAgentMessage(task: Task): string {
  let best: { at: number; text: string } | undefined;
  for (const agentId of task.agentIds) {
    if (isAgentChat(task, agentId)) {
      const reply = store.agents[agentId]?.chatState?.items.findLast(
        (item) => item.kind === 'assistant' && item.text.trim(),
      );
      if (reply?.kind === 'assistant') return reply.text.trim();
      continue;
    }
    const hook = getAgentHookStatus(agentId);
    const text = hook?.lastAssistantMessage?.trim();
    if (hook && text && (!best || hook.updatedAt > best.at)) best = { at: hook.updatedAt, text };
  }
  if (best) return best.text;
  const agentId = task.agentIds.find((id) => !isAgentChat(task, id));
  return agentId ? normalizeCurrentFrame(getAgentOutputTail(agentId)) : '';
}

/** Prompts sent after `since`; for the first brief, the prompt the task started with. */
function promptsSince(task: Task, since: number): string[] {
  const history = task.promptHistory ?? [];
  const recent = history.filter((entry) => (entry.sentAt ?? 0) > since).map((e) => e.text);
  if (recent.length || since > 0) return recent;
  const first = task.savedInitialPrompt || history.at(-1)?.text || task.lastPrompt;
  return first ? [first] : [];
}

/**
 * Rewrites the task's brief from the previous one, the prompts of the turn, the
 * agent's last message and the branch diff. One request per task at a time; a
 * turn that ends meanwhile queues one more run. Unless `force` is set, nothing
 * is sent when no prompt went out and the code did not change since the last
 * brief: agents also look busy while starting up or echoing typed input.
 */
export async function refreshTaskBrief(
  taskId: string,
  options: { force?: boolean } = {},
): Promise<void> {
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
  // What the brief covers: prompts and code up to now, not up to when the model answers.
  const capturedAt = Date.now();
  try {
    const previous = task.brief;
    const rawDiff = await readTaskDiff(task);
    if (cancelled) return;
    const prompts = promptsSince(task, previous?.generatedAt ?? 0);
    const fingerprint = rawDiff === undefined ? '' : diffFingerprint(rawDiff);
    const unchanged =
      !!previous &&
      prompts.length === 0 &&
      (rawDiff === undefined || fingerprint === previous.fingerprint);
    if ((unchanged || (!previous && !prompts.length && !rawDiff)) && !options.force) {
      setStore('tasks', taskId, 'briefStatus', undefined);
      return;
    }
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
    const { brief, turnOutcome } = parseTaskBriefResponse(
      response,
      rawDiff === undefined ? undefined : diffPaths(rawDiff),
    );
    const current = store.tasks[taskId].brief;
    setStore('tasks', taskId, 'brief', {
      brief,
      generatedAt: capturedAt,
      fingerprint,
      turns: prompts.length
        ? appendBriefTurn(current?.turns ?? [], {
            prompt: prompts.at(-1) ?? '',
            outcome: turnOutcome || brief.headline,
            endedAt: capturedAt,
          })
        : (current?.turns ?? []),
      decisions: carryDecisionStates(current?.decisions, brief.decided),
    });
    setStore('tasks', taskId, 'briefStatus', undefined);
    logInfo('taskBrief', 'Brief updated', { taskId, durationMs: Date.now() - capturedAt });
  } catch (error) {
    if (cancelled || !store.tasks[taskId]) return;
    const message = errMessage(error);
    logWarn('taskBrief', 'Brief generation failed', { taskId, error: message });
    setStore('tasks', taskId, 'briefStatus', { state: 'failed', message });
  } finally {
    if (inFlight.get(taskId) === handle) inFlight.delete(taskId);
    if (cancelled) {
      rerun.delete(taskId);
      if (store.tasks[taskId]?.briefStatus?.state === 'generating')
        setStore('tasks', taskId, 'briefStatus', undefined);
    } else if (rerun.delete(taskId)) void refreshTaskBrief(taskId);
  }
}

/** Stops the brief being written for a task, and the one queued after it. */
function cancelTaskBrief(taskId: string): void {
  rerun.delete(taskId);
  inFlight.get(taskId)?.cancel();
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
      if (!store.taskBriefs) {
        // Forget what was working, so turning briefs back on is not read as a turn ending.
        for (const taskId of [...timers.keys()]) clearTimer(taskId);
        working.clear();
        return;
      }
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
        cancelTaskBrief(taskId);
      }
    });

    return () => {
      for (const taskId of [...timers.keys()]) clearTimer(taskId);
      for (const taskId of [...inFlight.keys()]) cancelTaskBrief(taskId);
      rerun.clear();
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
    // Unread code cannot be compared later, so the rating keeps no fingerprint.
    if (rawDiff === undefined) return;
    if (store.tasks[taskId]?.confidence?.publishedAt !== publishedAt) return;
    setStore('tasks', taskId, 'confidence', 'fingerprint', diffFingerprint(rawDiff));
  });
}
