import { createEffect, createRoot, untrack } from 'solid-js';
import { produce } from 'solid-js/store';
import { BRIEF_MODELS } from '../../electron/shared/task-name-model';
import { parseConfidencePayload } from '../../electron/shared/task-confidence';
import { startModelRequest } from '../lib/model-request';
import { getTaskDiffBaseBranch, loadTaskDiff } from '../lib/load-task-diff';
import { errMessage, info as logInfo, warn as logWarn } from '../lib/log';
import { buildTaskBriefPrompt, diffFingerprint, parseTaskBriefResponse } from '../lib/task-brief';
import { isAgentChat } from './agent-chat';
import { getAgentHookStatus } from './agentHookStatus';
import { store, setStore } from './core';
import { canRetitleFromBrief, retitleFromBrief } from './model-task-name';
import { getProjectPath } from './projects';
import { getAgentOutputTail, isTaskWorking, normalizeCurrentFrame } from './taskStatus';
import type { Task } from './types';

/** A turn has to stay finished this long before it is summarised. */
const TURN_SETTLE_MS = 4_000;
/** Terminal heuristics can flicker between busy and idle; never brief more often than this. */
const MIN_BRIEF_INTERVAL_MS = 45_000;

const inFlight = new Map<string, { cancel: () => void }>();
/** Tasks whose turn ended again while their brief was being written. */
const rerun = new Set<string>();

export function isLiveTask(task: Task | undefined): task is Task {
  return !!task && !task.closingStatus && !!task.worktreePath;
}

/** The branch diff, '' when the task has no git, or undefined when it could not be read. */
export async function readTaskDiff(task: Task): Promise<string | undefined> {
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

interface AgentMessage {
  text: string;
  /** A reply the agent ended its turn with, as opposed to a snapshot of its screen. */
  isReply: boolean;
}

/**
 * The agent's own end-of-turn message: the selected pane's chat reply or
 * hook-reported message, else the newest one, else the visible terminal screen.
 */
function latestAgentMessage(task: Task): AgentMessage {
  const replies = new Map<string, { at: number; text: string }>();
  for (const agentId of task.agentIds) {
    if (isAgentChat(task, agentId)) {
      const reply = store.agents[agentId]?.chatState?.items.findLast(
        (item) => item.kind === 'assistant' && item.text.trim(),
      );
      // Chat items carry no time, so a hook-reported message counts as newer.
      if (reply?.kind === 'assistant') replies.set(agentId, { at: 0, text: reply.text.trim() });
      continue;
    }
    const hook = getAgentHookStatus(agentId);
    const text = hook?.lastAssistantMessage?.trim();
    if (hook && text) replies.set(agentId, { at: hook.updatedAt, text });
  }
  const selected = task.selectedAgentId ? replies.get(task.selectedAgentId) : undefined;
  const newest = [...replies.values()].reduce<{ at: number; text: string } | undefined>(
    (best, reply) => (!best || reply.at > best.at ? reply : best),
    undefined,
  );
  const reply = selected ?? newest;
  if (reply) return { text: reply.text, isReply: true };
  const agentId = task.agentIds.find((id) => !isAgentChat(task, id));
  return {
    text: agentId ? normalizeCurrentFrame(getAgentOutputTail(agentId)) : '',
    isReply: false,
  };
}

/** Prompts sent after `since`; for the first brief, the prompt the task started with. */
export function promptsSince(task: Task, since: number): string[] {
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
  const previous = task.brief;
  // Read before the diff is awaited, so a prompt sent meanwhile is left for the next brief.
  const prompts = promptsSince(task, previous?.generatedAt ?? 0);
  const message = latestAgentMessage(task);
  const withTitle = !previous && canRetitleFromBrief(task);
  // Screen snapshots change constantly, so only a real reply counts as news.
  const messageFingerprint = message.isReply ? diffFingerprint(message.text) : undefined;
  try {
    const rawDiff = await readTaskDiff(task);
    if (cancelled) return;
    const fingerprint = rawDiff === undefined ? '' : diffFingerprint(rawDiff);
    if (rawDiff !== undefined) noteCodeFingerprint(taskId, fingerprint, capturedAt);
    const unchanged =
      !!previous &&
      prompts.length === 0 &&
      (rawDiff === undefined || fingerprint === previous.fingerprint) &&
      (!messageFingerprint || messageFingerprint === previous.messageFingerprint);
    if ((unchanged || (!previous && !prompts.length && !rawDiff)) && !options.force) {
      setStore('tasks', taskId, 'briefStatus', undefined);
      return;
    }
    const request = startModelRequest({
      prompt: buildTaskBriefPrompt({
        taskName: task.name,
        prompts,
        previous: previous?.brief,
        agentMessage: message.text,
        rawDiff,
        withTitle,
      }),
      cwd: task.worktreePath,
      settings: BRIEF_MODELS[store.briefModel],
      agentEnvFiles: store.agentEnvFiles,
      projectId: task.projectId,
      purpose: 'brief',
    });
    handle.cancel = () => {
      cancelled = true;
      request.cancel();
    };
    const response = await request.result;
    if (cancelled || !isLiveTask(store.tasks[taskId])) return;
    const { brief, title } = parseTaskBriefResponse(response);
    // Checked again on apply: the user may have renamed the task meanwhile.
    if (withTitle && title) retitleFromBrief(taskId, title);
    setStore('tasks', taskId, 'brief', {
      brief,
      generatedAt: capturedAt,
      fingerprint,
      ...(messageFingerprint && { messageFingerprint }),
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
    // Every exit (cancel, skip, a task that closed meanwhile) must clear the spinner.
    if (store.tasks[taskId]?.briefStatus?.state === 'generating')
      setStore('tasks', taskId, 'briefStatus', undefined);
    if (cancelled) rerun.delete(taskId);
    else if (rerun.delete(taskId)) void refreshTaskBrief(taskId);
  }
}

/** Records the newest code fingerprint seen, which ratings are compared against. */
export function noteCodeFingerprint(taskId: string, fingerprint: string, at: number): void {
  const known = store.tasks[taskId]?.codeFingerprint;
  if (known && known.at >= at) return;
  setStore('tasks', taskId, 'codeFingerprint', { fingerprint, at });
}

/**
 * Reads the diff to tell whether a rating is still current. Briefs do this
 * after every turn; the Finish review also calls it, for changes made between turns.
 */
export async function refreshCodeFingerprint(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!isLiveTask(task)) return;
  const at = Date.now();
  const rawDiff = await readTaskDiff(task);
  if (rawDiff !== undefined) noteCodeFingerprint(taskId, diffFingerprint(rawDiff), at);
}

/**
 * Forgets the brief's question once the agent works again: the user answered
 * it, but the brief is only rewritten after the turn, so until then it would
 * show the old question again. The reply fingerprint goes too, so an agent
 * that asks the same question again still gets it into the next brief.
 */
export function dropAnsweredQuestion(taskId: string): void {
  if (!store.tasks[taskId]?.brief?.brief.needsYou) return;
  setStore(
    produce((s) => {
      const record = s.tasks[taskId]?.brief;
      if (!record) return;
      delete record.brief.needsYou;
      delete record.messageFingerprint;
    }),
  );
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
        if (now) {
          clearTimer(taskId);
          if (!was) untrack(() => dropAnsweredQuestion(taskId));
        } else if (was) schedule(taskId);
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
  // Replaced, not merged: a field the new rating leaves out must not survive from the old one.
  setStore(
    produce((s) => {
      const target = s.tasks[taskId];
      if (target) target.confidence = { ...payload, publishedAt };
    }),
  );
  void readTaskDiff(task).then((rawDiff) => {
    // Unread code cannot be compared later, so the rating keeps no fingerprint.
    if (rawDiff === undefined) return;
    if (store.tasks[taskId]?.confidence?.publishedAt !== publishedAt) return;
    setStore('tasks', taskId, 'confidence', 'fingerprint', diffFingerprint(rawDiff));
  });
}
