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
/** GitHub can report a new head before it has created that head's checks. */
const NEW_HEAD_CHECKS_WAIT_MS = 2 * 60_000;
const GH_TIMEOUT_MS = 15_000;
const GH_MAX_BUFFER = 4 * 1024 * 1024;

/** A task's local branch, whose remote-tracking ref reveals pushes made outside the app. */
export interface PrBranch {
  worktreePath: string;
  branchName: string;
}

interface TaskEntry {
  /** Map key: the task ID for a task's primary PR, distinct per additional PR. */
  watchId: string;
  taskId: string;
  taskName: string;
  prUrl: string;
  /** Babysat PRs keep polling while the window is hidden, so their failures still reach the agent. */
  babysit: boolean;
  /** Only a task's primary PR has one; additional PRs follow it through a shared head. */
  branch: PrBranch | null;
  /** Last SHA seen at `origin/<branch>`, so a tick can tell when the branch was pushed. */
  originSha: string | null;
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
  /** When GitHub last reported a new head; until its checks appear it shows as running. */
  headChangedAt: number | null;
  /** Number of the latest poll. Replies can arrive out of order, so only its reply applies. */
  pollSeq: number;
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
 *  real "user isn't looking" signal. Babysat PRs are the exception: the agent,
 *  not the user, acts on their failures. */
export function initPrChecks(mainWindow: BrowserWindow): void {
  win = mainWindow;
  mainWindow.on('show', () => {
    if (tasks.size > 0 && !disabled) {
      ensureInterval();
      runTick().catch((err) => console.warn('[pr-checks] show tick failed:', err));
    }
  });
  mainWindow.on('hide', pauseUnlessBabysitting);
  mainWindow.on('minimize', pauseUnlessBabysitting);
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

/** Public: renderer-driven start. Registers a PR of a task; triggers an immediate refresh.
 *  `watchId` is the task ID for the task's primary PR; a task's additional PRs
 *  pass their own IDs so they are watched side by side. */
export function startPrChecksWatcher(args: {
  taskId: string;
  prUrl: string;
  taskName: string;
  watchId: string;
  babysit: boolean;
  branch: PrBranch | null;
}): void {
  if (disabled) return;
  if (!isPrUrl(args.prUrl)) return;

  const { watchId } = args;
  const existing = tasks.get(watchId);
  // If the URL changed we treat this as a brand-new subscription: counts,
  // headRefOid, and notification-dedupe all belong to the old PR and must
  // not leak into the new one. A rename-only update (same URL) just updates
  // the display name.
  const isFreshSubscription = !existing || existing.prUrl !== args.prUrl;
  const { babysit, branch } = args;
  // Another branch's ref is no baseline for this one.
  const sameBranch =
    existing?.branch?.worktreePath === branch?.worktreePath &&
    existing?.branch?.branchName === branch?.branchName;
  const next: TaskEntry = isFreshSubscription
    ? {
        watchId,
        taskId: args.taskId,
        taskName: args.taskName,
        prUrl: args.prUrl,
        babysit,
        branch,
        originSha: null,
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
        headChangedAt: null,
        pollSeq: 0,
      }
    : {
        ...existing,
        taskName: args.taskName,
        babysit,
        branch,
        originSha: sameBranch ? existing.originSha : null,
      };
  tasks.set(watchId, next);
  ensureInterval();
  if (isFreshSubscription) {
    void refreshOne(watchId);
  }
}

export function stopPrChecksWatcher(watchId: string): void {
  tasks.delete(watchId);
  if (tasks.size === 0) clearTickInterval();
}

/** Marks the PRs of a task's pushed branch as freshly pushed: its primary PR
 *  and further PRs sharing that head. Nested repositories' PRs keep their state. */
export function refreshPrChecksWatcher(taskId: string): void {
  if (disabled) return;
  const marked = markTaskPushed(taskId);
  ensureInterval();
  // Poll now instead of up to a tick later: a merge or ready-for-review shows
  // at once, and GitHub may already report a pushed head.
  for (const watchId of marked) refreshOne(watchId).catch(handleGhError);
}

/** Marks the task's primary PR and the PRs sharing its head; returns their watch IDs. */
function markTaskPushed(taskId: string): string[] {
  const primary = tasks.get(taskId);
  if (!primary) return [];
  const marked: string[] = [];
  for (const entry of tasks.values()) {
    const sharesHead =
      entry.taskId === taskId &&
      primary.headRefOid !== null &&
      entry.headRefOid === primary.headRefOid;
    if (entry === primary || sharesHead) {
      markPushed(entry);
      marked.push(entry.watchId);
    }
  }
  return marked;
}

function markPushed(entry: TaskEntry): void {
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
}

/** True if the window currently exists and is visible. */
function windowIsVisible(): boolean {
  return !!win && !win.isDestroyed() && win.isVisible();
}

function hasBabysitEntry(): boolean {
  for (const entry of tasks.values()) if (entry.babysit) return true;
  return false;
}

function pauseUnlessBabysitting(): void {
  if (!hasBabysitEntry()) clearTickInterval();
}

function ensureInterval(): void {
  if (tickHandle || disabled) return;
  if (!windowIsVisible() && !hasBabysitEntry()) return;
  tickHandle = setInterval(() => {
    const hidden = !windowIsVisible();
    // Babysitting was turned off while hidden; nothing else polls until shown again.
    if (hidden && !hasBabysitEntry()) {
      clearTickInterval();
      return;
    }
    runTick(hidden).catch((err) => console.warn('[pr-checks] tick failed:', err));
  }, TICK_MS);
  tickHandle.unref();
}

function clearTickInterval(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

/** `babysatOnly` skips the PRs nobody acts on while the window is hidden. */
async function runTick(babysatOnly = false): Promise<void> {
  if (disabled || isRefreshing) return;
  isRefreshing = true;
  try {
    const watched = [...tasks.values()].filter((entry) => !babysatOnly || entry.babysit);
    await Promise.all(watched.map(detectOutsidePush));
    const now = Date.now();
    const due: string[] = [];
    for (const entry of watched) {
      if (entry.overall === 'pending') {
        due.push(entry.watchId);
      } else if (now - entry.lastRefreshedAt >= SETTLED_REFRESH_MS) {
        due.push(entry.watchId);
      }
    }
    // Refresh due tasks in parallel. `refreshOne` handles its own errors via
    // `handleGhError`; a single failure must not cancel sibling refreshes.
    await Promise.all(due.map((id) => refreshOne(id).catch(handleGhError)));
  } finally {
    isRefreshing = false;
  }
}

/**
 * Pushes from the agent's terminal bypass the app, so a settled PR would wait
 * up to SETTLED_REFRESH_MS to notice its new head. `git push` moves the local
 * remote-tracking ref, which costs no network to read.
 */
async function detectOutsidePush(entry: TaskEntry): Promise<void> {
  if (!entry.branch) return;
  const sha = await readOriginSha(entry.branch);
  const previous = entry.originSha;
  entry.originSha = sha;
  // The first read is only a baseline. A ref at the PR's head, or one moved
  // while a push is still awaited, was pushed by the app, which marked the PR.
  if (!sha || !previous || sha === previous || sha === entry.headRefOid) return;
  if (entry.postPushRefreshUntil !== null) return;
  if (tasks.get(entry.watchId) === entry) markTaskPushed(entry.taskId);
}

async function readOriginSha(branch: PrBranch): Promise<string | null> {
  try {
    const { stdout } = await exec(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch.branchName}`],
      { cwd: branch.worktreePath, timeout: GH_TIMEOUT_MS },
    );
    return stdout.trim() || null;
  } catch (err) {
    // `--verify --quiet` exits 1 for a branch that was never pushed.
    if ((err as { code?: unknown }).code !== 1) {
      console.warn('[pr-checks] reading origin ref failed:', (err as Error)?.message ?? err);
    }
    return null;
  }
}

async function refreshOne(watchId: string): Promise<void> {
  const entry = tasks.get(watchId);
  if (!entry) return;

  const seq = ++entry.pollSeq;
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
  // A newer poll owns the result, or the watcher was stopped or replaced
  // meanwhile; a replacement polls on its own or on the next tick.
  if (tasks.get(watchId) !== entry || entry.pollSeq !== seq) return;

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
    tasks.delete(watchId);
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

  const prevSha = entry.headRefOid;
  const shaChanged = entry.hasFetched && prevSha !== view.headRefOid;
  const headChangedAt = shaChanged ? Date.now() : entry.headChangedAt;
  const summary = summarize(checks);
  // GitHub reports a new head before it creates that head's checks. Show it
  // as running meanwhile, so the status neither blanks out nor stops polling.
  const awaitingChecks =
    checks.length === 0 &&
    headChangedAt !== null &&
    Date.now() - headChangedAt < NEW_HEAD_CHECKS_WAIT_MS;
  const overall: PrChecksOverall = awaitingChecks ? 'pending' : summary.overall;
  const { passing, pending, failing } = summary;
  const counts = { passing, pending, failing };
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
    entry.headChangedAt = headChangedAt;
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
    watchId: entry.watchId,
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
    headSha: entry.headRefOid ?? undefined,
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

/** URLs of all open PRs whose head is `branchName`, e.g. one per base branch. */
export async function listOpenPrUrlsForBranch(
  worktreePath: string,
  branchName: string,
): Promise<string[]> {
  if (!(await isDirectory(worktreePath))) return [];
  const { stdout: remotes } = await exec('git', ['remote', '-v'], {
    cwd: worktreePath,
    timeout: GH_TIMEOUT_MS,
    maxBuffer: GH_MAX_BUFFER,
  });
  if (!remotes.trim()) return [];
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
      'url,headRefName,isCrossRepository,headRepositoryOwner',
      '--limit',
      '20',
    ],
    { cwd: worktreePath, timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER },
  );
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  const owners = remoteOwners(remotes);
  const urls: string[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const pr = item as Record<string, unknown>;
    const url = pr['url'];
    if (pr['headRefName'] !== branchName || typeof url !== 'string' || !isPrUrl(url)) continue;
    // `--head` matches any fork's branch of that name; shared names such as
    // `develop` would otherwise pick up strangers' PRs.
    if (pr['isCrossRepository'] === true && !owners.has(headOwnerOf(pr))) continue;
    urls.push(url);
  }
  return urls;
}

/** Lower-cased owners of the remotes in `git remote -v` output. */
function remoteOwners(remoteV: string): Set<string> {
  const owners = new Set<string>();
  for (const line of remoteV.split('\n')) {
    const url = line.split(/\s+/)[1];
    // Both git@host:owner/repo and scheme://host/owner/repo end in owner/repo.
    const parts =
      url
        ?.replace(/\/+$/, '')
        .replace(/\.git$/, '')
        .split(/[/:]/) ?? [];
    const owner = parts[parts.length - 2];
    if (owner) owners.add(owner.toLowerCase());
  }
  return owners;
}

function headOwnerOf(pr: Record<string, unknown>): string {
  const owner = pr['headRepositoryOwner'] as { login?: unknown } | null | undefined;
  return typeof owner?.login === 'string' ? owner.login.toLowerCase() : '';
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

/** The gh binary itself is not installed, as opposed to a missing working directory. */
export function isGhMissingError(err: unknown): boolean {
  const e = err as { code?: unknown; path?: unknown; syscall?: unknown };
  return (
    e?.code === 'ENOENT' &&
    (e.path === 'gh' || (typeof e.syscall === 'string' && e.syscall.includes('spawn gh')))
  );
}

/** gh refused because no account is logged in. Not a bare `gh auth login`
 *  match: gh also suggests that for repositories on unknown hosts. */
export function isGhAuthError(err: unknown): boolean {
  const stderr = (err as { stderr?: unknown })?.stderr;
  return (
    typeof stderr === 'string' &&
    /not logged into|authentication required|to get started with github cli/i.test(stderr)
  );
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
  if (isGhAuthError(err)) {
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
