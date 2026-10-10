import { matchesTaskProjectFilter } from './task-project-filter';
import { batch, createEffect, createRoot, createSignal, onCleanup, untrack } from 'solid-js';
import { store, setStore } from './core';
import { AGENT_HOOK_STALE_MS, getAgentHookStatus, type AgentHookStatus } from './agentHookStatus';
import { scrollTaskIntoView } from './focused-panel';
import { setActiveTask } from './navigation';
import { collapseTask, uncollapseTask } from './tasks';
import { getPrChecks } from './pr-checks-state';
import { getCoordinatorChildren } from './sidebar-order';
import { getTaskOpenQuestions, isAgentIdle, type TaskOpenQuestion } from './taskStatus';

// Activity baselines are session-only. Timed snoozes are also saved on the task.
const [backgroundTasks, setBackgroundTasks] = createSignal<ReadonlyMap<string, BackgroundTask>>(
  new Map(),
);

interface BackgroundTask extends ActivitySnapshot {
  snoozedUntil?: number;
}

export function getTaskSnoozedUntil(taskId: string): number | undefined {
  const owner = backgroundOwner(taskId);
  return owner ? backgroundTasks().get(owner)?.snoozedUntil : undefined;
}

export function isTaskBackgrounded(taskId: string): boolean {
  return backgroundOwner(taskId) !== undefined;
}

function backgroundOwner(taskId: string): string | undefined {
  if (backgroundTasks().has(taskId)) return taskId;
  const parentId = store.tasks[taskId]?.coordinatedBy;
  return parentId && backgroundTasks().has(parentId) ? parentId : undefined;
}

function taskBlock(taskId: string): string[] {
  return [taskId, ...getCoordinatorChildren(taskId).active];
}

interface AgentActivity {
  /** Process facts; any change is new activity. */
  process: string;
  /** Facts derived from the hook status or, once it is gone, from output heuristics. */
  activity: string;
  hooked: boolean;
  /** When the working/waiting claim was reported; only such claims expire. */
  claimAt?: number;
}

interface ActivitySnapshot {
  task: string;
  mergedPrTasks: readonly string[];
  agents: ReadonlyMap<string, AgentActivity>;
}

/** Every waiting event is a new ask. A done one is not: Claude's `idle_prompt`
 * re-reports a finished turn, and a new turn already shows as leaving idle. */
function hookMarker(hook: AgentHookStatus | null): unknown {
  if (!hook || hook.state === 'working') return null;
  return hook.state === 'waiting' ? [hook.event, hook.updatedAt] : 'done';
}

function agentActivity(agentId: string, questions: readonly TaskOpenQuestion[]): AgentActivity {
  const agent = store.agents[agentId];
  const hook = getAgentHookStatus(agentId);
  return {
    process: JSON.stringify([agent?.status, agent?.chatState?.error]),
    activity: JSON.stringify([
      isAgentIdle(agentId),
      questions.find((question) => question.agentId === agentId)?.since,
      hookMarker(hook),
    ]),
    hooked: hook !== null,
    claimAt: hook && hook.state !== 'done' ? hook.updatedAt : undefined,
  };
}

/** Ignore ordinary output and working hook heartbeats, but notice individual
 * agents finishing/resuming even when another agent masks the task's status. */
function activitySnapshot(taskId: string): ActivitySnapshot {
  const agents = new Map<string, AgentActivity>();
  const block = taskBlock(taskId);
  const mergedPrTasks = block.filter((id) => getPrChecks(id)?.merged === true);
  const tasks = block.map((id) => {
    const task = store.tasks[id];
    const agentIds = task?.agentIds ?? [];
    const questions = getTaskOpenQuestions(id);
    for (const agentId of agentIds) agents.set(agentId, agentActivity(agentId, questions));
    return {
      // Git-derived readiness can disappear during a refresh without any
      // agent activity. Only explicit review requests belong in this baseline.
      review: Boolean(
        task?.needsReview || task?.stepsContent?.at(-1)?.status === 'awaiting_review',
      ),
      // Agent questions are compared per agent; this covers shell terminals.
      question: questions.find((question) => !agentIds.includes(question.agentId)) ?? null,
      done: task?.signalDoneAt,
      notification: task?.stagedNotification?.batchId,
      agentIds,
    };
  });
  return { task: JSON.stringify(tasks), mergedPrTasks, agents };
}

/** Expired hooks and cleared merge state reset the baseline without new activity. */
function activityChange(
  baseline: ActivitySnapshot,
  current: ActivitySnapshot,
): 'same' | 'rebaseline' | 'new' {
  if (current.task !== baseline.task) return 'new';
  if (current.mergedPrTasks.some((id) => !baseline.mergedPrTasks.includes(id))) return 'new';
  let change: 'same' | 'rebaseline' =
    current.mergedPrTasks.length !== baseline.mergedPrTasks.length ? 'rebaseline' : 'same';
  for (const [agentId, now] of current.agents) {
    const then = baseline.agents.get(agentId);
    if (!then || now.process !== then.process) return 'new';
    const expired =
      !now.hooked && then.claimAt !== undefined && Date.now() - then.claimAt >= AGENT_HOOK_STALE_MS;
    // Rebaseline hook expiry even when both sources still report the agent busy.
    if (expired) change = 'rebaseline';
    else if (now.activity !== then.activity) return 'new';
  }
  return change;
}

/** Nearest foreground task, preferring the left neighbor as closing a task does. */
function foregroundNeighbor(taskId: string, block: readonly string[]): string | undefined {
  const index = store.taskOrder.indexOf(taskId);
  const candidates = [
    ...store.taskOrder.slice(0, index).reverse(),
    ...store.taskOrder.slice(index + 1),
  ];
  return candidates.find(
    (id) => !block.includes(id) && !isTaskBackgrounded(id) && matchesTaskProjectFilter(id),
  );
}

/** Moving a tile re-inserts its DOM nodes, which drops focus inside it, e.g. in
 * the terminal whose focus just selected this task. Restore it once the DOM settles. */
function keepFocusAcrossReorder(): void {
  if (typeof document === 'undefined') return;
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || focused === document.body) return;
  queueMicrotask(() => {
    const lost = !document.activeElement || document.activeElement === document.body;
    if (lost && focused.isConnected) focused.focus({ preventScroll: true });
  });
}

function validSnoozeHours(hours: number): boolean {
  return Number.isFinite(hours) && hours >= 0.01 && hours <= 168;
}

export async function snoozeTask(taskId: string, hours: number, keepRunning = true): Promise<void> {
  if (!validSnoozeHours(hours)) return;
  taskId = backgroundOwner(taskId) ?? taskId;
  const task = store.tasks[taskId];
  if (!task || task.collapsed || task.closingStatus || !store.taskOrder.includes(taskId)) return;
  if (keepRunning) {
    sendTaskToBack(taskId, hours);
    return;
  }
  // The coordinator registry owns its agents; collapse cannot safely replace them.
  if (task.coordinatorMode || task.delegationParent || task.coordinatedBy) return;
  const snoozedUntil = Date.now() + hours * 3_600_000;
  await collapseTask(taskId);
  if (!store.tasks[taskId]?.collapsed) return;
  batch(() => {
    setStore('tasks', taskId, 'snoozedUntil', snoozedUntil);
    setBackgroundTasks((previous) =>
      new Map(previous).set(taskId, { ...activitySnapshot(taskId), snoozedUntil }),
    );
  });
}

export function sendTaskToBack(taskId: string, snoozeHours?: number): void {
  if (snoozeHours !== undefined && !validSnoozeHours(snoozeHours)) return;
  taskId = backgroundOwner(taskId) ?? taskId;
  const task = store.tasks[taskId];
  if (!task || task.collapsed || task.closingStatus || !store.taskOrder.includes(taskId)) return;
  const block = taskBlock(taskId);
  const remaining = store.taskOrder.filter((id) => !block.includes(id));
  const snapshot: BackgroundTask = {
    ...activitySnapshot(taskId),
    snoozedUntil: snoozeHours === undefined ? undefined : Date.now() + snoozeHours * 3_600_000,
  };
  const neighbor = foregroundNeighbor(taskId, block);
  batch(() => {
    for (const id of block) setStore('tasks', id, 'snoozedUntil', undefined);
    setBackgroundTasks((previous) => {
      const next = new Map(previous);
      for (const id of block) next.delete(id);
      return next.set(taskId, snapshot);
    });
    setStore('tasks', taskId, 'snoozedUntil', snapshot.snoozedUntil);
    setStore('taskOrder', [...remaining, ...block]);
    if (store.activeTaskId && block.includes(store.activeTaskId)) {
      if (neighbor) setActiveTask(neighbor);
      else {
        setStore('activeTaskId', null);
        setStore('activeAgentId', null);
      }
    }
  });
}

export function bringTaskToFront(taskId: string): void {
  const owner = backgroundOwner(taskId);
  if (!owner) return;
  const restorePaused =
    store.tasks[owner]?.snoozedUntil !== undefined &&
    !store.tasks[owner]?.closingStatus &&
    store.collapsedTaskOrder.includes(owner);
  batch(() => {
    if (store.tasks[owner]) setStore('tasks', owner, 'snoozedUntil', undefined);
    setBackgroundTasks((previous) => {
      const next = new Map(previous);
      next.delete(owner);
      return next;
    });
    if (restorePaused && store.tasks[owner]?.collapsed) uncollapseTask(owner, { activate: false });
    if (!store.taskOrder.includes(owner)) return;
    const block = taskBlock(owner);
    keepFocusAcrossReorder();
    setStore('taskOrder', [...block, ...store.taskOrder.filter((id) => !block.includes(id))]);
    // Reordering can push the active tile offscreen without changing selection.
    // The helper waits for the DOM update and respects draft focus and focus mode.
    if (store.activeTaskId) scrollTaskIntoView(store.activeTaskId, 'instant');
  });
}

/** Independent of OS notification preferences and window focus. Auto-return
 * changes order only; it never takes focus from the task the user is working on. */
export function startBackgroundTaskWatcher(): () => void {
  return createRoot((dispose) => {
    // loadState restores task/agent sessions first. Rebuild only timed snoozes;
    // untimed activity baselines belong to the previous run.
    batch(() => {
      const restored = new Map(backgroundTasks());
      for (const taskId of [...store.taskOrder, ...store.collapsedTaskOrder]) {
        const task = store.tasks[taskId];
        if (task?.snoozedUntil !== undefined) {
          restored.set(taskId, { ...activitySnapshot(taskId), snoozedUntil: task.snoozedUntil });
        }
      }
      setBackgroundTasks(restored);
      // A saved/fallback selection must not immediately cancel a restored snooze.
      if (store.activeTaskId && isTaskBackgrounded(store.activeTaskId)) {
        const foreground = store.taskOrder.find(
          (id) => !isTaskBackgrounded(id) && matchesTaskProjectFilter(id),
        );
        if (foreground) setActiveTask(foreground);
        else {
          setStore('activeTaskId', null);
          setStore('activeAgentId', null);
          setStore('focusMode', false);
        }
      }
    });
    createEffect(() => {
      const deadlines = [...backgroundTasks().values()].flatMap((task) =>
        task.snoozedUntil === undefined ? [] : [task.snoozedUntil],
      );
      if (!deadlines.length) return;
      // Recheck wall time periodically, including after sleep or a clock change.
      const timer = setTimeout(
        () => {
          for (const [taskId, task] of backgroundTasks()) {
            if (task.snoozedUntil !== undefined && task.snoozedUntil <= Date.now()) {
              bringTaskToFront(taskId);
            }
          }
          setBackgroundTasks((tasks) => new Map(tasks));
        },
        Math.max(0, Math.min(60_000, Math.min(...deadlines) - Date.now())),
      );
      onCleanup(() => clearTimeout(timer));
    });
    createEffect(() => {
      for (const [taskId, baseline] of backgroundTasks()) {
        const task = store.tasks[taskId];
        const current = baseline.snoozedUntil === undefined ? activitySnapshot(taskId) : undefined;
        const change = current ? activityChange(baseline, current) : 'same';
        if (
          !task ||
          task.closingStatus ||
          (task.collapsed
            ? baseline.snoozedUntil === undefined || !store.collapsedTaskOrder.includes(taskId)
            : !store.taskOrder.includes(taskId)) ||
          (baseline.snoozedUntil !== undefined && task.snoozedUntil === undefined) ||
          taskBlock(taskId).includes(store.activeTaskId ?? '') ||
          change === 'new'
        ) {
          untrack(() => bringTaskToFront(taskId));
        } else if (change === 'rebaseline' && current) {
          untrack(() => setBackgroundTasks((previous) => new Map(previous).set(taskId, current)));
        }
      }
    });
    return dispose;
  });
}
