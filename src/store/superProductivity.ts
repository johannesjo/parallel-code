/**
 * Super Productivity integration: track time on the focused task, keep task
 * titles in sync, and complete the linked task when a task is merged or
 * closed. Every request goes through the main process (the token lives
 * there); the rules themselves are pure and live in
 * electron/shared/super-productivity.ts.
 *
 * Kept free of imports from tasks.ts/navigation.ts, which call into it.
 */
import { createEffect, createRoot, createSignal, on, untrack, type Accessor } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { warn as logWarn } from '../lib/log';
import { parseGitHubUrl } from '../lib/github-url';
import { isDocumentAgentTaskId } from '../documents/task-id';
import { store, setStore } from './core';
import { showNotification } from './notification';
import {
  buildSpDoneNote,
  decideSpFocusAction,
  resolveSpTitleSync,
  SP_MAX_BATCH_IDS,
  toSpTitle,
  type SpBannerReason,
  type SpConnectionState,
  type SpProject,
  type SpResult,
  type SpTaskDetail,
  type SpTaskSummary,
  type SpTrackingState,
} from '../../electron/shared/super-productivity';

/** How long focus must rest on a task before it counts — tabbing through
 *  tasks must not leave a trail of new Super Productivity tasks. */
const FOCUS_SETTLE_MS = 1_500;

const CONNECTION_STATES: ReadonlySet<string> = new Set<SpConnectionState>([
  'not_configured',
  'unreachable',
  'disabled',
  'unauthorized',
  'not_ready',
]);

const [spConnection, setSpConnection] = createSignal<SpConnectionState>('not_configured');
export { spConnection };

export interface SpBanner {
  taskId: string;
  reason: SpBannerReason;
  trackingTitle?: string;
}

const [spBanner, setSpBanner] = createSignal<SpBanner | null>(null);
export { spBanner };

/** Bumped when the token is saved or removed: a reply to a request made
 *  before that must not bring back the old connection state. */
let connectionGen = 0;

async function callSp<T>(channel: IPC, args?: Record<string, unknown>): Promise<SpResult<T>> {
  const gen = connectionGen;
  let res: SpResult<T>;
  try {
    res = await invoke<SpResult<T>>(channel, args);
  } catch (err) {
    logWarn('super-productivity', 'IPC call failed', { channel, err: String(err) });
    return { ok: false, reason: 'error' };
  }
  if (gen !== connectionGen) return { ok: false, reason: 'not_configured' };
  if (res.ok) setSpConnection('connected');
  else if (CONNECTION_STATES.has(res.reason)) setSpConnection(res.reason as SpConnectionState);
  return res;
}

function isEnabled(): boolean {
  return spConnection() !== 'not_configured';
}

/** A task whose focus is the user's attention: not a document workspace's
 *  hidden agent task, and not on its way out. Plain terminals aren't tasks. */
function isTrackableTask(taskId: string): boolean {
  const task = store.tasks[taskId];
  return !!task && !isDocumentAgentTaskId(taskId) && !task.closingStatus && !task.collapsed;
}

// ---------------------------------------------------------------------------
// Connection

/** A token saved while Super Productivity was unreachable still gets its
 *  projects matched — on the first successful check afterwards. */
let autoMapPending = false;

export async function refreshSpConnection(): Promise<SpConnectionState> {
  const gen = connectionGen;
  try {
    const state = await invoke<SpConnectionState>(IPC.SuperProductivityGetState);
    if (gen !== connectionGen) return spConnection();
    setSpConnection(state);
    if (state === 'connected' && autoMapPending) {
      autoMapPending = false;
      await autoMapProjectsByName();
    }
    return state;
  } catch (err) {
    logWarn('super-productivity', 'Could not read connection state', { err: String(err) });
    return spConnection();
  }
}

/** Save the access token; on success, match projects by name. Throws on a malformed token. */
export async function connectSuperProductivity(token: string): Promise<SpConnectionState> {
  const gen = ++connectionGen;
  const state = await invoke<SpConnectionState>(IPC.SuperProductivitySetToken, { token });
  if (gen !== connectionGen) return spConnection();
  setSpConnection(state);
  autoMapPending = state !== 'connected';
  if (state === 'connected') await autoMapProjectsByName();
  return state;
}

export async function disconnectSuperProductivity(): Promise<void> {
  connectionGen++;
  await invoke(IPC.SuperProductivityClearToken);
  autoMapPending = false;
  setSpConnection('not_configured');
  setSpBanner(null);
}

// ---------------------------------------------------------------------------
// Projects

export async function listSpProjects(): Promise<SpProject[] | null> {
  const res = await callSp<SpProject[]>(IPC.SuperProductivityListProjects);
  return res.ok ? res.value : null;
}

export function setProjectSpMapping(projectId: string, spProjectId: string | undefined): void {
  const idx = store.projects.findIndex((p) => p.id === projectId);
  if (idx >= 0) setStore('projects', idx, 'superProductivityProjectId', spProjectId);
}

/** Map still-unmapped projects to the Super Productivity project with the same name (unique, case-insensitive). */
async function autoMapProjectsByName(): Promise<void> {
  const spProjects = await listSpProjects();
  if (!spProjects) return;
  const byName = new Map<string, SpProject | null>();
  for (const p of spProjects) {
    const key = p.title.trim().toLowerCase();
    byName.set(key, byName.has(key) ? null : p);
  }
  for (const project of store.projects) {
    if (project.superProductivityProjectId) continue;
    const match = byName.get(project.name.trim().toLowerCase());
    if (match) setProjectSpMapping(project.id, match.id);
  }
}

// ---------------------------------------------------------------------------
// Links

function linkedSpTaskIds(): Set<string> {
  const ids = new Set<string>();
  for (const task of Object.values(store.tasks)) {
    if (task?.superProductivity) ids.add(task.superProductivity.taskId);
  }
  return ids;
}

export function setSpLink(taskId: string, spTaskId: string, syncedTitle: string): void {
  if (!store.tasks[taskId]) return;
  setStore('tasks', taskId, 'superProductivity', { taskId: spTaskId, syncedTitle });
}

function clearSpLink(taskId: string): void {
  if (store.tasks[taskId]) setStore('tasks', taskId, 'superProductivity', undefined);
}

const creatingLinks = new Map<string, Promise<string | null>>();

/** The linked Super Productivity task id, creating the task on first use. */
function ensureSpLink(taskId: string): Promise<string | null> {
  const existing = store.tasks[taskId]?.superProductivity;
  if (existing) return Promise.resolve(existing.taskId);
  const pending = creatingLinks.get(taskId);
  if (pending) return pending;
  const created = createSpTaskFor(taskId).finally(() => creatingLinks.delete(taskId));
  creatingLinks.set(taskId, created);
  return created;
}

async function createSpTaskFor(taskId: string): Promise<string | null> {
  const task = store.tasks[taskId];
  if (!task) return null;
  const title = toSpTitle(task.name) || 'Parallel Code task';
  // An agent-spawned subtask becomes a subtask of its parent's task.
  const parentSpTaskId = task.coordinatedBy
    ? store.tasks[task.coordinatedBy]?.superProductivity?.taskId
    : undefined;
  let spProjectId = store.projects.find((p) => p.id === task.projectId)?.superProductivityProjectId;
  // Super Productivity accepts an unknown projectId and files the task nowhere
  // visible, so a mapping to a since-deleted or archived project is dropped —
  // also when it is only the fallback for a parent that is gone.
  if (spProjectId) {
    const spProjects = await listSpProjects();
    if (spProjects && !spProjects.some((p) => p.id === spProjectId)) spProjectId = undefined;
  }
  // Fall back when the parent or project no longer exists over there (or the
  // parent is itself a subtask, which Super Productivity rejects).
  const attempts: Record<string, string>[] = [];
  if (parentSpTaskId) attempts.push({ parentId: parentSpTaskId });
  if (spProjectId) attempts.push({ projectId: spProjectId });
  attempts.push({});

  for (const placement of attempts) {
    const res = await callSp<SpTaskSummary>(IPC.SuperProductivityCreateTask, {
      title,
      ...placement,
    });
    if (res.ok) {
      setSpLink(taskId, res.value.id, res.value.title);
      return store.tasks[taskId] ? res.value.id : null;
    }
    if (res.reason !== 'not_found' && res.reason !== 'invalid_request') return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Titles

function applyTitleSync(taskId: string, remoteTitle: string): void {
  const task = store.tasks[taskId];
  const link = task?.superProductivity;
  if (!task || !link) return;
  const action = resolveSpTitleSync(link.syncedTitle, toSpTitle(task.name), remoteTitle.trim());
  switch (action.kind) {
    case 'none':
      return;
    case 'rebase':
      setStore('tasks', taskId, 'superProductivity', 'syncedTitle', action.title);
      return;
    case 'pull':
      if (!action.title) return;
      setStore('tasks', taskId, 'name', action.title);
      setStore('tasks', taskId, 'nameIsAutoGenerated', false);
      setStore('tasks', taskId, 'superProductivity', 'syncedTitle', action.title);
      return;
    case 'push':
      void pushTitle(taskId, action.title);
  }
}

async function pushTitle(taskId: string, title: string): Promise<void> {
  const spTaskId = store.tasks[taskId]?.superProductivity?.taskId;
  if (!spTaskId || !title) return;
  const res = await callSp<null>(IPC.SuperProductivityRenameTask, { taskId: spTaskId, title });
  if (res.ok && store.tasks[taskId]?.superProductivity?.taskId === spTaskId) {
    setStore('tasks', taskId, 'superProductivity', 'syncedTitle', title);
  }
}

/** Called after the user renames a task in Parallel Code. */
export function onTaskRenamed(taskId: string): void {
  const task = store.tasks[taskId];
  if (!isEnabled() || !task?.superProductivity) return;
  void pushTitle(taskId, toSpTitle(task.name));
}

async function refreshLinkedTitles(): Promise<void> {
  const byTaskId = new Map<string, string>();
  for (const task of Object.values(store.tasks)) {
    if (task?.superProductivity && !task.closingStatus && !isDocumentAgentTaskId(task.id)) {
      byTaskId.set(task.superProductivity.taskId, task.id);
    }
  }
  const ids = [...byTaskId.keys()];
  for (let start = 0; start < ids.length; start += SP_MAX_BATCH_IDS) {
    const res = await callSp<SpTaskSummary[]>(IPC.SuperProductivityGetTasks, {
      taskIds: ids.slice(start, start + SP_MAX_BATCH_IDS),
    });
    if (!res.ok) return;
    for (const spTask of res.value) {
      const taskId = byTaskId.get(spTask.id);
      if (taskId) applyTitleSync(taskId, spTask.title);
    }
  }
}

// ---------------------------------------------------------------------------
// Tracking

/** Bumped by every focus evaluation and every explicit start: an evaluation
 *  whose replies arrive after a newer one began must not act on them. */
let focusSeq = 0;
/** The task whose evaluation found Super Productivity unreachable; retried
 *  when the window regains focus. */
let retryTaskId: string | null = null;

const CONNECTION_FAILURES: ReadonlySet<string> = CONNECTION_STATES;

async function evaluateFocus(taskId: string): Promise<void> {
  if (!isTrackableTask(taskId)) return;
  const seq = ++focusSeq;

  const tracking = await callSp<SpTrackingState>(IPC.SuperProductivityGetTracking);
  if (!tracking.ok) {
    if (CONNECTION_FAILURES.has(tracking.reason) && tracking.reason !== 'not_configured') {
      retryTaskId = taskId;
    }
    return;
  }
  if (retryTaskId === taskId) retryTaskId = null;

  let own: SpTaskDetail | null = null;
  let ownMissing = false;
  const link = store.tasks[taskId]?.superProductivity;
  if (link) {
    const res = await callSp<SpTaskDetail>(IPC.SuperProductivityGetTask, { taskId: link.taskId });
    if (res.ok) {
      own = res.value;
      applyTitleSync(taskId, res.value.title);
    } else if (res.reason === 'not_found') {
      // Archived ("finish day") or deleted over there. Keep the link and ask:
      // the banner's button links a fresh task (trackTaskInSp).
      ownMissing = true;
    } else {
      return;
    }
  }
  // The user moved on, or tracking was started explicitly, meanwhile.
  if (store.activeTaskId !== taskId || seq !== focusSeq) return;

  const decision = decideSpFocusAction({
    tracking: tracking.value,
    ownSpTaskId: own?.id ?? null,
    ownSpTaskIsDone: own?.isDone ?? false,
    ownSpTaskMissing: ownMissing,
    linkedSpTaskIds: linkedSpTaskIds(),
  });
  if (decision.kind === 'banner') {
    setSpBanner({ taskId, reason: decision.reason, trackingTitle: decision.trackingTitle });
    return;
  }
  if (spBanner()?.taskId === taskId) setSpBanner(null);
  if (decision.kind === 'track') await trackTaskInSp(taskId, { onlyWhileActive: true });
}

/**
 * Start tracking time on this task in Super Productivity (the banner's
 * button, too). `onlyWhileActive` drops the start when the user moved on, or
 * the task started closing, while its Super Productivity task was created.
 */
export async function trackTaskInSp(
  taskId: string,
  opts: { onlyWhileActive?: boolean } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const spTaskId = await ensureSpLink(taskId);
    if (!spTaskId) return false;
    if (opts.onlyWhileActive && (store.activeTaskId !== taskId || !isTrackableTask(taskId))) {
      return false;
    }
    const res = await callSp<null>(IPC.SuperProductivityStartTracking, { taskId: spTaskId });
    if (res.ok) {
      focusSeq++; // an evaluation still in flight saw the state before this
      if (spBanner()?.taskId === taskId) setSpBanner(null);
      return true;
    }
    // Archived or deleted over there since it was linked: link a fresh task and retry once.
    if (res.reason !== 'not_found') return false;
    clearSpLink(taskId);
  }
  return false;
}

export function dismissSpBanner(): void {
  setSpBanner(null);
}

// ---------------------------------------------------------------------------
// Done

function prUrlOf(task: { prUrl?: string; githubUrl?: string }): string | undefined {
  if (task.prUrl) return task.prUrl;
  return task.githubUrl && parseGitHubUrl(task.githubUrl)?.type === 'pull'
    ? task.githubUrl
    : undefined;
}

/** Completions waiting for their task to leave the store (see armSpCompletion). */
const armedCompletions = new Map<string, () => void>();

function completeSpTask(spTaskId: string, note: string, name: string): void {
  void callSp<null>(IPC.SuperProductivityCompleteTask, { taskId: spTaskId, note }).then((res) => {
    // Gone over there, or never set up here: nothing to report.
    if (res.ok || res.reason === 'not_found' || res.reason === 'not_configured') return;
    // The task is gone here, so nothing will retry: say so.
    logWarn('super-productivity', 'Could not complete linked task', { reason: res.reason });
    showNotification(`Could not mark “${name}” done in Super Productivity`);
  });
}

/**
 * Prepare marking the linked task done for when this task leaves Parallel
 * Code by the user's close, a merge, or a coordinator closing it. Captures
 * everything now, because the task is gone by the time it fires; fired by
 * fireSpCompletion from removeTaskFromStore, so a close that fails and is
 * retried completes only once it really happened. Removing a project closes
 * its tasks without arming this, and collapsing never removes a task.
 *
 * Arms whenever a link exists, even before the connection check at startup
 * has run: a link means the integration was set up. A task whose linked
 * task is still being created completes that one once it exists.
 */
export function armSpCompletion(
  taskId: string,
  input: { kind: 'merged' | 'closed'; linesAdded?: number; linesRemoved?: number },
): void {
  const task = store.tasks[taskId];
  const link = task?.superProductivity;
  const creating = link ? undefined : creatingLinks.get(taskId);
  if (!task || (!link && !creating)) return;
  const note = buildSpDoneNote({
    kind: input.kind,
    branchName: task.gitIsolation === 'worktree' ? task.branchName : undefined,
    baseBranch: task.baseBranch,
    linesAdded: input.linesAdded,
    linesRemoved: input.linesRemoved,
    prUrl: prUrlOf(task),
  });
  const name = task.name;
  armedCompletions.set(taskId, () => {
    if (link) {
      completeSpTask(link.taskId, note, name);
      return;
    }
    void creating?.then((spTaskId) => {
      if (spTaskId) completeSpTask(spTaskId, note, name);
    });
  });
}

export function fireSpCompletion(taskId: string): void {
  const send = armedCompletions.get(taskId);
  armedCompletions.delete(taskId);
  if (spBanner()?.taskId === taskId) setSpBanner(null);
  send?.();
}

// ---------------------------------------------------------------------------
// Lifecycle

/**
 * Watch focus. A change of the active task counts once focus has rested on
 * it and the window is focused — a restore on launch or a background focus
 * change (a coordinator spawning a subtask) is not the user's attention. The
 * window check happens when the timer fires, not at the change: clicking a
 * task in a background window can reach the renderer before the window's
 * focus event does. Plain terminals are not tasks, so focusing one leaves
 * tracking on the last task.
 */
let stopActiveSync: (() => void) | null = null;

export function startSuperProductivitySync(windowFocused: Accessor<boolean>): () => void {
  // One watcher at a time (a dev reload can start another).
  stopActiveSync?.();
  void refreshSpConnection();
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const dispose = createRoot((disposeRoot) => {
    createEffect(
      on(
        () => store.activeTaskId,
        (taskId) => {
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = undefined;
          // A banner belongs to the task it was raised on; its button would
          // otherwise pull tracking back to a task the user left.
          if (untrack(spBanner)?.taskId !== taskId) setSpBanner(null);
          if (!taskId || !isEnabled() || !isTrackableTask(taskId)) return;
          settleTimer = setTimeout(() => {
            settleTimer = undefined;
            if (store.activeTaskId === taskId && untrack(windowFocused)) {
              void evaluateFocus(taskId);
            }
          }, FOCUS_SETTLE_MS);
        },
        { defer: true },
      ),
    );
    createEffect(
      on(
        windowFocused,
        (focused) => {
          if (!focused || !isEnabled()) return;
          void refreshLinkedTitles();
          // Re-check a showing banner: if the conflict was resolved over there
          // (the other task stopped, the break ended), the focused task gets
          // tracked like any focused task. Likewise retry a focus that found
          // Super Productivity unreachable. Otherwise, coming back to the
          // window changes nothing.
          const active = store.activeTaskId;
          const bannerTask = untrack(spBanner)?.taskId;
          if (active && (bannerTask === active || retryTaskId === active)) {
            void evaluateFocus(active);
          }
        },
        { defer: true },
      ),
    );
    return disposeRoot;
  });

  const stop = () => {
    if (settleTimer) clearTimeout(settleTimer);
    focusSeq++; // drop evaluations still in flight
    dispose();
    if (stopActiveSync === stop) stopActiveSync = null;
  };
  stopActiveSync = stop;
  return stop;
}
