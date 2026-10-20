import { execFile } from 'child_process';
import { promisify } from 'util';
import { Notification, type BrowserWindow } from 'electron';
import { stat } from 'fs/promises';
import { IPC } from './channels.js';
import { parseMergeable, parsePrRef } from '../github/gh.js';
import type {
  PrCheckBucket,
  PrCheckRun,
  PrChecksOverall,
  PrChecksUpdatePayload,
  PrMergeable,
  PrReviewDecision,
} from './shared-types.js';

export type {
  PrCheckBucket,
  PrCheckRun,
  PrChecksOverall,
  PrChecksUpdatePayload,
  PrReviewDecision,
} from './shared-types.js';

const exec = promisify(execFile);

const TICK_MS = 30_000;
const SETTLED_REFRESH_MS = 5 * 60_000;
const POST_PUSH_REFRESH_GRACE_MS = 2 * 60_000;
const GH_TIMEOUT_MS = 15_000;
const GH_MAX_BUFFER = 4 * 1024 * 1024;

interface TaskEntry {
  taskId: string;
  taskName: string;
  prUrl: string;
  overall: PrChecksOverall;
  isDraft: boolean;
  reviewDecision: PrReviewDecision | null;
  mergeable: PrMergeable;
  passing: number;
  pending: number;
  failing: number;
  checks: PrCheckRun[];
  headRefOid: string | null;
  hasFetched: boolean;
  lastRefreshedAt: number;
  /** SHA at which we last fired a settled notification. null if never notified. */
  lastNotifiedSha: string | null;
  /** Outcome at the last notification, so the same (sha, outcome) doesn't refire. */
  lastNotifiedOutcome: Exclude<PrChecksOverall, 'pending' | 'none'> | null;
  /** After a local push, ignore stale old-SHA check data while GitHub catches up. */
  postPushRefreshUntil: number | null;
}

let win: BrowserWindow | null = null;
let tasks = new Map<string, TaskEntry>();
let tickHandle: ReturnType<typeof setInterval> | null = null;
let isRefreshing = false;
let disabled = false;
let disabledReason: 'missing' | 'auth' | null = null;

/** Public: wire window-lifecycle listeners. Call once from registerAllHandlers.
 *  We do NOT pause polling on `blur` — the point of OS notifications is to tell
 *  the user something finished while they were doing something else. We only
 *  pause if the window is actually hidden (minimised / cmd-H), which is the
 *  real "user isn't looking" signal. */
export function initPrChecks(mainWindow: BrowserWindow): void {
  win = mainWindow;
  mainWindow.on('show', () => {
    if (tasks.size > 0 && !disabled) {
      ensureInterval();
      runTick().catch((err) => console.warn('[pr-checks] show tick failed:', err));
    }
  });
  mainWindow.on('hide', () => {
    clearTickInterval();
  });
  mainWindow.on('minimize', () => {
    clearTickInterval();
  });
  mainWindow.on('restore', () => {
    if (tasks.size > 0 && !disabled) {
      ensureInterval();
      runTick().catch((err) => console.warn('[pr-checks] restore tick failed:', err));
    }
  });
  mainWindow.on('closed', () => {
    win = null;
    clearTickInterval();
    tasks.clear();
  });
}

/** Public: renderer-driven start. Registers a task; triggers an immediate refresh. */
export function startPrChecksWatcher(args: {
  taskId: string;
  prUrl: string;
  taskName: string;
}): void {
  if (disabled) return;
  if (!isPrUrl(args.prUrl)) return;

  const existing = tasks.get(args.taskId);
  // If the URL changed we treat this as a brand-new subscription: counts,
  // headRefOid, and notification-dedupe all belong to the old PR and must
  // not leak into the new one. A rename-only update (same URL) just updates
  // the display name.
  const isFreshSubscription = !existing || existing.prUrl !== args.prUrl;
  const next: TaskEntry = isFreshSubscription
    ? {
        taskId: args.taskId,
        taskName: args.taskName,
        prUrl: args.prUrl,
        overall: 'pending',
        isDraft: false,
        reviewDecision: null,
        mergeable: 'UNKNOWN',
        passing: 0,
        pending: 0,
        failing: 0,
        checks: [],
        headRefOid: null,
        hasFetched: false,
        lastRefreshedAt: 0,
        lastNotifiedSha: null,
        lastNotifiedOutcome: null,
        postPushRefreshUntil: null,
      }
    : { ...existing, taskName: args.taskName };
  tasks.set(args.taskId, next);
  ensureInterval();
  if (isFreshSubscription) {
    void refreshOne(next.taskId);
  }
}

export function stopPrChecksWatcher(taskId: string): void {
  tasks.delete(taskId);
  if (tasks.size === 0) clearTickInterval();
}

export function refreshPrChecksWatcher(taskId: string): void {
  if (disabled) return;
  const entry = tasks.get(taskId);
  if (!entry) return;
  // Deliberately leave entry.headRefOid in place: refreshOne uses it as the
  // pre-push SHA to detect when GitHub has caught up. Clearing it here would
  // make every fetch within the grace window look like a SHA change and let
  // stale old-head check data through.
  entry.postPushRefreshUntil = Date.now() + POST_PUSH_REFRESH_GRACE_MS;
  entry.overall = 'pending';
  entry.passing = 0;
  entry.pending = Math.max(1, entry.checks.length);
  entry.failing = 0;
  entry.checks = [];
  entry.lastRefreshedAt = Date.now();
  sendUpdate(entry);
  ensureInterval();
}

/** True if the window currently exists and is visible. */
function windowIsVisible(): boolean {
  return !!win && !win.isDestroyed() && win.isVisible();
}

function ensureInterval(): void {
  if (tickHandle || disabled) return;
  if (!windowIsVisible()) return;
  tickHandle = setInterval(() => {
    runTick().catch((err) => console.warn('[pr-checks] tick failed:', err));
  }, TICK_MS);
  tickHandle.unref();
}

function clearTickInterval(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

async function runTick(): Promise<void> {
  if (disabled || isRefreshing) return;
  isRefreshing = true;
  try {
    const now = Date.now();
    const due: string[] = [];
    for (const entry of tasks.values()) {
      if (entry.overall === 'pending') {
        due.push(entry.taskId);
      } else if (now - entry.lastRefreshedAt >= SETTLED_REFRESH_MS) {
        due.push(entry.taskId);
      }
    }
    // Refresh due tasks in parallel. `refreshOne` handles its own errors via
    // `handleGhError`; a single failure must not cancel sibling refreshes.
    await Promise.all(due.map((id) => refreshOne(id).catch(handleGhError)));
  } finally {
    isRefreshing = false;
  }
}

async function refreshOne(taskId: string): Promise<void> {
  const entry = tasks.get(taskId);
  if (!entry) return;

  let status: Awaited<ReturnType<typeof fetchPrStatus>>;
  try {
    status = await fetchPrStatus(entry.prUrl);
  } catch (err) {
    handleGhError(err);
    // Keep previous state. Do NOT bump lastRefreshedAt — a transient failure
    // should retry on the next tick, not trigger the settled-backoff timer
    // or break the first-refresh-silent invariant.
    return;
  }

  if (status.state === 'MERGED' || status.state === 'CLOSED') {
    // Emit one final `cleared` update so the renderer drops its watcher
    // bookkeeping and can restart if the same PR later reopens or the
    // task points back at it after something else.
    entry.overall = 'none';
    entry.passing = 0;
    entry.pending = 0;
    entry.failing = 0;
    entry.checks = [];
    entry.lastRefreshedAt = Date.now();
    sendUpdate(entry, {
      cleared: true,
      merged: status.state === 'MERGED',
      mergedAt: status.mergedAt,
    });
    tasks.delete(taskId);
    if (tasks.size === 0) clearTickInterval();
    return;
  }

  // GitHub does not run pull_request workflows on conflicted branches. Include
  // a local mergeability check so unrelated passing checks cannot imply success.
  const checks: PrCheckRun[] =
    status.mergeable === 'CONFLICTING'
      ? [...status.checks, { name: 'Merge conflicts with base branch', bucket: 'fail' }]
      : status.checks;
  const view = { state: status.state, headRefOid: status.headRefOid };

  const { overall, passing, pending, failing } = summarize(checks);
  const counts = { passing, pending, failing };
  const prevSha = entry.headRefOid;
  const shaChanged = entry.hasFetched && prevSha !== view.headRefOid;
  const firstRefresh = !entry.hasFetched;
  const waitingForPostPushHead =
    entry.postPushRefreshUntil !== null &&
    entry.hasFetched &&
    !shaChanged &&
    Date.now() < entry.postPushRefreshUntil;
  if (waitingForPostPushHead) {
    entry.lastRefreshedAt = Date.now();
    // Review metadata is PR-wide, so it can advance while old-head CI data
    // remains suppressed during the post-push grace period.
    if (
      entry.isDraft !== status.isDraft ||
      entry.reviewDecision !== status.reviewDecision ||
      entry.mergeable !== status.mergeable
    ) {
      entry.isDraft = status.isDraft;
      entry.reviewDecision = status.reviewDecision;
      entry.mergeable = status.mergeable;
      sendUpdate(entry);
    }
    return;
  }
  const nothingChanged =
    !firstRefresh &&
    entry.overall === overall &&
    entry.isDraft === status.isDraft &&
    entry.reviewDecision === status.reviewDecision &&
    entry.mergeable === status.mergeable &&
    entry.passing === counts.passing &&
    entry.pending === counts.pending &&
    entry.failing === counts.failing &&
    !shaChanged;

  // Reset notification dedupe when a new push arrives.
  if (shaChanged) {
    entry.lastNotifiedSha = null;
    entry.lastNotifiedOutcome = null;
    entry.postPushRefreshUntil = null;
  } else if (entry.postPushRefreshUntil !== null && Date.now() >= entry.postPushRefreshUntil) {
    entry.postPushRefreshUntil = null;
  }

  entry.overall = overall;
  entry.isDraft = status.isDraft;
  entry.reviewDecision = status.reviewDecision;
  entry.mergeable = status.mergeable;
  entry.passing = counts.passing;
  entry.pending = counts.pending;
  entry.failing = counts.failing;
  entry.checks = checks;
  entry.headRefOid = view.headRefOid;
  entry.hasFetched = true;
  entry.lastRefreshedAt = Date.now();

  if (nothingChanged) return;

  sendUpdate(entry);

  // Don't fire a notification on the very first refresh — that would alert
  // the user about PRs that settled before the app was opened. Record the
  // current SHA/outcome silently so a real transition during this session
  // still notifies.
  if (firstRefresh) {
    if (overall === 'success' || overall === 'failure') {
      entry.lastNotifiedSha = view.headRefOid;
      entry.lastNotifiedOutcome = overall;
    }
    return;
  }

  if (
    (overall === 'success' || overall === 'failure') &&
    (entry.lastNotifiedSha !== view.headRefOid || entry.lastNotifiedOutcome !== overall)
  ) {
    fireNotification(entry);
    entry.lastNotifiedSha = view.headRefOid;
    entry.lastNotifiedOutcome = overall;
  }
}

function sendUpdate(
  entry: TaskEntry,
  opts?: { cleared?: boolean; merged?: boolean; mergedAt?: string },
): void {
  if (!win || win.isDestroyed() || disabled) return;
  const payload: PrChecksUpdatePayload = {
    taskId: entry.taskId,
    prUrl: entry.prUrl,
    mergedAt: opts?.mergedAt,
    overall: entry.overall,
    isDraft: entry.isDraft,
    reviewDecision: entry.reviewDecision,
    mergeable: entry.mergeable,
    passing: entry.passing,
    pending: entry.pending,
    failing: entry.failing,
    checks: entry.checks,
    checkedAt: new Date(entry.lastRefreshedAt).toISOString(),
    cleared: opts?.cleared ?? false,
    merged: opts?.merged ?? false,
  };
  win.webContents.send(IPC.PrChecksUpdate, payload);
}

function fireNotification(entry: TaskEntry): void {
  if (disabled) return;
  try {
    if (!Notification.isSupported()) return;
    const { overall, taskName, passing, pending, failing, checks } = entry;
    const title =
      overall === 'success'
        ? `\u2713 Checks passed \u2014 ${taskName}`
        : `\u2717 Checks failed \u2014 ${taskName}`;
    const body =
      overall === 'success'
        ? `${passing} passing, 0 failing`
        : failureBody(checks, failing, pending);
    const notification = new Notification({ title, body });
    notification.on('click', () => {
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
    });
    notification.show();
    if (process.platform === 'linux') {
      setTimeout(() => notification.close(), 30_000);
    }
  } catch (err) {
    console.warn('[pr-checks] notification failed:', err);
  }
}

function failureBody(checks: PrCheckRun[], failing: number, pending: number): string {
  const failed = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
  const names = failed.slice(0, 3).map((c) => c.name);
  const extra = failed.length > 3 ? ` and ${failed.length - 3} more` : '';
  const namesPart = names.length > 0 ? names.join(', ') + extra : '';
  const pendingSuffix = pending > 0 ? `; ${pending} still pending` : '';
  return namesPart
    ? `${failing} failing: ${namesPart}${pendingSuffix}`
    : `${failing} failing${pendingSuffix}`;
}

// --- Pure helpers (exported for tests) ---

/** Reduces a list of check runs to overall state + per-bucket counts in one pass.
 *  Any `pending` wins; else any `fail`/`cancel` → failure; empty list → `none`. */
export function summarize(checks: PrCheckRun[]): {
  overall: PrChecksOverall;
  passing: number;
  pending: number;
  failing: number;
} {
  let passing = 0;
  let pending = 0;
  let failing = 0;
  for (const c of checks) {
    if (c.bucket === 'pass' || c.bucket === 'skipping') passing++;
    else if (c.bucket === 'pending') pending++;
    else if (c.bucket === 'fail' || c.bucket === 'cancel') failing++;
  }
  let overall: PrChecksOverall;
  if (checks.length === 0) overall = 'none';
  else if (pending > 0) overall = 'pending';
  else if (failing > 0) overall = 'failure';
  else overall = 'success';
  return { overall, passing, pending, failing };
}

export function isPrUrl(url: string): boolean {
  return parsePrRef(url) !== null;
}

export async function detectPrUrlForBranch(
  worktreePath: string,
  branchName: string,
): Promise<string | null> {
  if (!(await isDirectory(worktreePath))) return null;
  const { stdout: remotes } = await exec('git', ['remote'], {
    cwd: worktreePath,
    timeout: GH_TIMEOUT_MS,
    maxBuffer: GH_MAX_BUFFER,
  });
  if (!remotes.trim()) return null;
  const { stdout } = await exec(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'open',
      '--head',
      branchName,
      '--json',
      'url,headRefName',
      '--limit',
      '20',
    ],
    { cwd: worktreePath, timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER },
  );
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return null;
  const match = parsed.find((item) => {
    if (!item || typeof item !== 'object') return false;
    const pr = item as Record<string, unknown>;
    return pr['headRefName'] === branchName;
  });
  if (!match || typeof match !== 'object') return null;
  const url = (match as Record<string, unknown>)['url'];
  return typeof url === 'string' && isPrUrl(url) ? url : null;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Single gh call: combines PR state, review metadata, head SHA, and check runs in one fork.
 *  Uses `statusCheckRollup` which bundles check-run data with a normalised
 *  conclusion, so we map that to the same `bucket` taxonomy `gh pr checks`
 *  would have produced. The subcommand is `gh pr view`, not `gh pr status`
 *  (a different command). */
export async function fetchPrStatus(prUrl: string): Promise<{
  state: string;
  mergedAt?: string;
  headRefOid: string;
  isDraft: boolean;
  reviewDecision: PrReviewDecision | null;
  mergeable: PrMergeable;
  checks: PrCheckRun[];
}> {
  const { stdout } = await exec(
    'gh',
    [
      'pr',
      'view',
      prUrl,
      '--json',
      'state,mergedAt,headRefOid,isDraft,reviewDecision,mergeable,statusCheckRollup',
    ],
    { timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER },
  );
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== 'object') {
    return {
      state: 'UNKNOWN',
      headRefOid: '',
      isDraft: false,
      reviewDecision: null,
      mergeable: 'UNKNOWN',
      checks: [],
    };
  }
  const r = parsed as Record<string, unknown>;
  const rollup = Array.isArray(r['statusCheckRollup']) ? r['statusCheckRollup'] : [];
  const checks: PrCheckRun[] = [];
  for (const item of rollup) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const bucket = rollupBucket(
      asString(c['status']),
      asString(c['conclusion']),
      asString(c['state']),
    );
    if (!bucket) continue;
    checks.push({
      name: asString(c['name']) ?? asString(c['context']) ?? '',
      bucket,
    });
  }
  return {
    state: asString(r['state']) ?? 'UNKNOWN',
    mergedAt: asString(r['mergedAt']),
    headRefOid: asString(r['headRefOid']) ?? '',
    isDraft: r['isDraft'] === true,
    reviewDecision: parseReviewDecision(r['reviewDecision']),
    mergeable: parseMergeable(r['mergeable']),
    checks,
  };
}

function parseReviewDecision(value: unknown): PrReviewDecision | null {
  if (value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED') {
    return value;
  }
  return null;
}

/** Maps GitHub's CheckRun status/conclusion (or legacy status-context state)
 *  into the same bucket taxonomy that `gh pr checks --json bucket` produces.
 *  Returns null only for the no-useful-signal case (all inputs empty); any
 *  unrecognised settled conclusion defaults to `fail` so "something went
 *  wrong we don't understand" is surfaced rather than silently dropped. */
export function rollupBucket(
  status: string | undefined,
  conclusion: string | undefined,
  legacyState: string | undefined,
): PrCheckBucket | null {
  const hasStatus = !!status;
  const hasConclusion = !!conclusion;
  if (!hasStatus && !hasConclusion) {
    if (!legacyState) return null;
    const s = legacyState.toUpperCase();
    if (s === 'SUCCESS') return 'pass';
    if (s === 'PENDING' || s === 'EXPECTED') return 'pending';
    return 'fail'; // FAILURE / ERROR / anything else → treat as failure.
  }
  if (hasStatus && status && status.toUpperCase() !== 'COMPLETED') return 'pending';
  const c = (conclusion ?? '').toUpperCase();
  if (c === 'SUCCESS') return 'pass';
  if (c === 'SKIPPED' || c === 'NEUTRAL') return 'skipping';
  if (c === 'CANCELLED') return 'cancel';
  // FAILURE / TIMED_OUT / STARTUP_FAILURE / ACTION_REQUIRED / STALE / unknown:
  // any other settled conclusion is treated as failure.
  return 'fail';
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function handleGhError(err: unknown): void {
  if (disabled) return;
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') {
    disabled = true;
    disabledReason = 'missing';
    console.warn('[pr-checks] gh CLI not found — PR CI status disabled for this session');
    clearTickInterval();
    return;
  }
  const stderr = (err as { stderr?: string })?.stderr ?? '';
  if (typeof stderr === 'string' && /not logged into|authentication required/i.test(stderr)) {
    disabled = true;
    disabledReason = 'auth';
    console.warn('[pr-checks] gh not authenticated — PR CI status disabled for this session');
    clearTickInterval();
    return;
  }
  // Transient: keep previous state, let caller preserve entry.
  console.warn('[pr-checks] transient gh failure:', (err as Error)?.message ?? err);
}

// --- Test seams ---

/** Reset module state for tests only. */
export function __resetForTests(): void {
  win = null;
  tasks = new Map();
  clearTickInterval();
  isRefreshing = false;
  disabled = false;
  disabledReason = null;
}

/** Read module state for assertions in tests. */
export function __getStateForTests(): {
  disabled: boolean;
  disabledReason: 'missing' | 'auth' | null;
  taskIds: string[];
} {
  return { disabled, disabledReason, taskIds: Array.from(tasks.keys()) };
}

export function __runTickForTests(): Promise<void> {
  return runTick();
}
