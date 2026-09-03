/**
 * Document workspaces: proposals from headless agents in isolated worktrees,
 * accepted into the canonical branch as one readable commit.
 *
 * Git holds the content; `.parallel/runs/` holds the run records. Nothing in
 * here changes the canonical document except `acceptDocumentCandidate`.
 */
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { BrowserWindow } from 'electron';
import { IPC } from './channels.js';
import { debug as logDebug, errMessage } from '../log.js';
import { atomicWriteFileSync } from '../mcp/atomic.js';
import { buildPtySpawnEnv, validateCommand } from './pty.js';
import { loadEnvFile } from './env-file.js';
import { createWorktree, ensureWorktreeContainerExclude, removeWorktree } from './git.js';
import { buildHeadlessLaunch, createHeadlessParser } from './document-agents.js';
import { buildDocumentPrompt, parseDocumentRationale } from './document-prompt.js';
import { MAX_DOCUMENT_CANDIDATES } from '../shared/document-agents.js';
import type {
  DocumentCandidateRecord,
  DocumentCandidateSpec,
  DocumentHistoryEntry,
  DocumentRunEvent,
  DocumentRunRecord,
  DocumentScope,
  DocumentSnapshot,
} from './shared-types.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 20 * 1024 * 1024;
/** A proposal that runs longer than this is killed and marked failed. */
const CANDIDATE_TIMEOUT_MS = 30 * 60_000;
/** Longest instruction accepted from the renderer. */
const MAX_INSTRUCTION_CHARS = 20_000;
const RUNS_DIR = path.join('.parallel', 'runs');
const MAIN_WORKTREE_DIR = path.join('.worktrees', 'parallel-doc-main');
const BRANCH_PREFIX = 'parallel-doc';
const WATCH_DEBOUNCE_MS = 200;
const WATCH_POLL_MS = 3_000;
const STDERR_TAIL_CHARS = 4_000;
const MAX_LOG_LINE_CHARS = 4_000;

async function git(cwd: string, args: string[]): Promise<string> {
  logDebug('git', args.join(' '));
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

// --- Validation -----------------------------------------------------------

/** A document path is repo-relative and stays inside the project. */
export function validateDocumentPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('documentPath must be a string');
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.isAbsolute(normalized)) throw new Error('documentPath must be relative');
  if (normalized.split('/').some((seg) => seg === '..' || seg === ''))
    throw new Error('documentPath must not contain ".." or empty segments');
  if (normalized.startsWith('.parallel/') || normalized.startsWith('.worktrees/'))
    throw new Error('documentPath must not point into .parallel or .worktrees');
  return normalized;
}

function validateRunId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9-]{4,64}$/i.test(value))
    throw new Error('runId is invalid');
  return value;
}

function validateCandidateId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(value))
    throw new Error('candidateId is invalid');
  return value;
}

export function validateSha(value: unknown, label = 'sha'): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{7,64}$/i.test(value))
    throw new Error(`${label} must be a commit hash`);
  return value;
}

function validateScope(value: unknown, documentPath: string): DocumentScope {
  if (!value || typeof value !== 'object') throw new Error('scope must be an object');
  const s = value as Record<string, unknown>;
  const wholeDocument = s.wholeDocument === true;
  const startLine = Number(s.startLine);
  const endLine = Number(s.endLine);
  if (!wholeDocument) {
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1)
      throw new Error('scope lines must be positive integers');
    if (endLine < startLine) throw new Error('scope endLine must not precede startLine');
  }
  const quote = typeof s.quote === 'string' ? s.quote : '';
  const heading = typeof s.heading === 'string' && s.heading.trim() ? s.heading.trim() : undefined;
  return {
    path: documentPath,
    wholeDocument,
    startLine: wholeDocument ? 1 : startLine,
    endLine: wholeDocument ? 1 : endLine,
    quote: quote.slice(0, 20_000),
    heading,
  };
}

function validateCandidateSpecs(value: unknown): DocumentCandidateSpec[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('candidates must be a list');
  if (value.length > MAX_DOCUMENT_CANDIDATES)
    throw new Error(`At most ${MAX_DOCUMENT_CANDIDATES} candidates per run`);
  const seen = new Set<string>();
  return value.map((raw): DocumentCandidateSpec => {
    if (!raw || typeof raw !== 'object') throw new Error('candidate must be an object');
    const c = raw as Record<string, unknown>;
    const id = validateCandidateId(c.id);
    if (seen.has(id)) throw new Error('duplicate candidate id');
    seen.add(id);
    const str = (key: string): string => {
      const v = c[key];
      if (typeof v !== 'string' || !v.trim()) throw new Error(`candidate.${key} must be a string`);
      return v;
    };
    const optStr = (key: string): string | undefined => {
      const v = c[key];
      if (v === undefined || v === null || v === '') return undefined;
      if (typeof v !== 'string') throw new Error(`candidate.${key} must be a string`);
      return v;
    };
    const label = str('label');
    if (!/^[A-Za-z0-9 _-]{1,24}$/.test(label)) throw new Error('candidate.label is invalid');
    const command = str('command');
    if (/[\s;&|<>$`'"\\]/.test(command)) throw new Error('candidate.command is invalid');
    const sessionId = optStr('sessionId');
    if (sessionId && !/^[A-Za-z0-9_.-]{1,128}$/.test(sessionId))
      throw new Error('candidate.sessionId is invalid');
    return {
      id,
      label,
      agentId: str('agentId'),
      agentName: str('agentName').slice(0, 64),
      command,
      isMain: c.isMain === true,
      sessionId,
      sessionLastSha: optStr('sessionLastSha'),
      envFile: optStr('envFile'),
    };
  });
}

// --- Snapshots and watcher ------------------------------------------------

async function headSha(projectRoot: string): Promise<string | null> {
  try {
    return (await git(projectRoot, ['rev-parse', '--verify', 'HEAD'])).trim() || null;
  } catch {
    return null;
  }
}

async function currentBranch(projectRoot: string): Promise<string | null> {
  try {
    const out = (await git(projectRoot, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Pathspec that leaves run records out of "pending edits": they are committed
 *  explicitly by acceptance and rejection so they never bury content commits. */
const CONTENT_PATHSPEC = ['--', '.', ':(exclude).parallel'];

async function isDirty(projectRoot: string): Promise<boolean> {
  const out = await git(projectRoot, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    ...CONTENT_PATHSPEC,
  ]);
  return out.trim().length > 0;
}

export async function readDocumentSnapshot(
  projectRoot: string,
  documentPath: string,
): Promise<DocumentSnapshot> {
  const abs = path.join(projectRoot, documentPath);
  let content = '';
  let missing = false;
  try {
    content = await fs.promises.readFile(abs, 'utf-8');
  } catch {
    missing = true;
  }
  const [sha, branch, dirty] = await Promise.all([
    headSha(projectRoot),
    currentBranch(projectRoot),
    isDirty(projectRoot).catch(() => false),
  ]);
  return { content, headSha: sha, branch, dirty, missing };
}

interface DocumentWatcher {
  fsWatcher: fs.FSWatcher | null;
  debounce: ReturnType<typeof setTimeout> | null;
  poll: ReturnType<typeof setInterval>;
  lastKey: string;
}

const watchers = new Map<string, DocumentWatcher>();

function snapshotKey(s: DocumentSnapshot): string {
  return `${s.headSha ?? ''}|${s.branch ?? ''}|${s.dirty}|${s.missing}|${s.content.length}|${s.content}`;
}

export function startDocumentWatcher(
  win: BrowserWindow,
  key: string,
  projectRoot: string,
  documentPath: string,
): void {
  stopDocumentWatcher(key);
  const docDir = path.dirname(path.join(projectRoot, documentPath));
  const docName = path.basename(documentPath);

  const emit = async () => {
    const current = watchers.get(key);
    if (!current || win.isDestroyed()) return;
    const snapshot = await readDocumentSnapshot(projectRoot, documentPath).catch(() => null);
    if (!snapshot) return;
    const k = snapshotKey(snapshot);
    if (k === current.lastKey) return;
    current.lastKey = k;
    win.webContents.send(IPC.DocumentChanged, { key, snapshot });
  };

  const schedule = () => {
    const current = watchers.get(key);
    if (!current) return;
    if (current.debounce) clearTimeout(current.debounce);
    current.debounce = setTimeout(() => {
      current.debounce = null;
      void emit();
    }, WATCH_DEBOUNCE_MS);
  };

  let fsWatcher: fs.FSWatcher | null = null;
  try {
    fsWatcher = fs.watch(docDir, (_event, fileName) => {
      if (fileName && fileName !== docName) return;
      schedule();
    });
    fsWatcher.on('error', (err) => console.warn(`[documents] watcher error for ${docDir}:`, err));
  } catch (err) {
    console.warn(`[documents] cannot watch ${docDir}:`, err);
  }

  watchers.set(key, {
    fsWatcher,
    debounce: null,
    // HEAD and dirty state change without touching the document (commits in
    // a terminal, edits to other files), so poll those on a slow cadence.
    poll: setInterval(() => void emit(), WATCH_POLL_MS),
    lastKey: '',
  });
}

export function stopDocumentWatcher(key: string): void {
  const entry = watchers.get(key);
  if (!entry) return;
  if (entry.debounce) clearTimeout(entry.debounce);
  clearInterval(entry.poll);
  entry.fsWatcher?.close();
  watchers.delete(key);
}

export function stopAllDocumentWatchers(): void {
  for (const key of [...watchers.keys()]) stopDocumentWatcher(key);
}

// --- Run records ----------------------------------------------------------

function runsDir(projectRoot: string): string {
  return path.join(projectRoot, RUNS_DIR);
}

function runRecordRelPath(runId: string): string {
  return path.posix.join('.parallel', 'runs', `${runId}.json`);
}

function runRecordPath(projectRoot: string, runId: string): string {
  return path.join(runsDir(projectRoot), `${runId}.json`);
}

function writeRunRecord(projectRoot: string, run: DocumentRunRecord): void {
  fs.mkdirSync(runsDir(projectRoot), { recursive: true });
  atomicWriteFileSync(runRecordPath(projectRoot, run.id), JSON.stringify(run, null, 2) + '\n');
}

function readRunRecord(projectRoot: string, runId: string): DocumentRunRecord | null {
  try {
    const raw = fs.readFileSync(runRecordPath(projectRoot, runId), 'utf-8');
    const parsed = JSON.parse(raw) as DocumentRunRecord;
    if (parsed.version !== 1 || !Array.isArray(parsed.candidates)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function requireRunRecord(projectRoot: string, runId: string): DocumentRunRecord {
  const run = readRunRecord(projectRoot, runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  return run;
}

// --- Active runs ----------------------------------------------------------

interface ActiveCandidate {
  proc: ChildProcess;
  timer: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

interface ActiveRun {
  projectRoot: string;
  candidates: Map<string, ActiveCandidate>;
}

const activeRuns = new Map<string, ActiveRun>();
const projectLocks = new Map<string, Promise<void>>();

function withProjectLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectRoot);
  const prev = projectLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  projectLocks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function sendEvent(win: BrowserWindow, event: DocumentRunEvent): void {
  if (!win.isDestroyed()) win.webContents.send(IPC.DocumentRunEvent, event);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Runs the app persisted as running but that no process backs any more. */
function reconcileInterrupted(projectRoot: string, run: DocumentRunRecord): DocumentRunRecord {
  if (run.status !== 'running' || activeRuns.has(run.id)) return run;
  for (const c of run.candidates) {
    if (c.status === 'running') {
      c.status = 'interrupted';
      c.finishedAt = nowIso();
      c.error = 'The app was closed while this proposal was running.';
    }
  }
  run.status = 'finished';
  run.finishedAt = run.finishedAt ?? nowIso();
  writeRunRecord(projectRoot, run);
  return run;
}

export function listDocumentRuns(projectRoot: string): DocumentRunRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(runsDir(projectRoot)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const runs: DocumentRunRecord[] = [];
  for (const name of names) {
    const run = readRunRecord(projectRoot, name.slice(0, -'.json'.length));
    if (run) runs.push(reconcileInterrupted(projectRoot, run));
  }
  runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return runs;
}

// --- Pending manual edits -------------------------------------------------

/**
 * Commits whatever the user changed in the checkout as a plain commit, so the
 * run has a real base. Returns HEAD afterwards. Throws in an empty repository.
 */
export async function commitPendingEdits(projectRoot: string): Promise<string> {
  ensureWorktreeContainerExclude(projectRoot);
  if (await isDirty(projectRoot)) {
    await git(projectRoot, ['add', '-A', ...CONTENT_PATHSPEC]);
    await git(projectRoot, ['commit', '-q', '-m', 'Manual edits']);
  }
  const sha = await headSha(projectRoot);
  if (!sha) throw new Error('The project repository has no commits yet.');
  return sha;
}

// --- Worktrees ------------------------------------------------------------

function shortRunId(runId: string): string {
  return runId.replace(/-/g, '').slice(0, 8);
}

function candidateBranch(runId: string, label: string): string {
  return `${BRANCH_PREFIX}/${shortRunId(runId)}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** The main session keeps one worktree so its working directory never changes. */
async function prepareMainWorktree(
  projectRoot: string,
  branch: string,
  baseSha: string,
): Promise<string> {
  const worktreePath = path.join(projectRoot, MAIN_WORKTREE_DIR);
  ensureWorktreeContainerExclude(projectRoot);
  await gitOk(projectRoot, ['worktree', 'prune']);
  if (!fs.existsSync(path.join(worktreePath, '.git'))) {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    await git(projectRoot, ['worktree', 'add', '-b', branch, worktreePath, baseSha]);
    return worktreePath;
  }
  await git(worktreePath, ['reset', '--hard', '-q']);
  await git(worktreePath, ['clean', '-fdq']);
  await git(worktreePath, ['checkout', '-q', '-B', branch, baseSha]);
  return worktreePath;
}

async function prepareAlternateWorktree(
  projectRoot: string,
  branch: string,
  baseSha: string,
): Promise<string> {
  const { path: worktreePath } = await createWorktree(projectRoot, branch, [], baseSha, true);
  return worktreePath;
}

async function cleanupCandidate(
  projectRoot: string,
  candidate: DocumentCandidateRecord,
): Promise<void> {
  if (candidate.isMain) {
    // The persistent worktree stays; only drop the branch when it is no
    // longer checked out there (the next dispatch moves it anyway).
    const mainPath = path.join(projectRoot, MAIN_WORKTREE_DIR);
    const checkedOut = await currentBranch(mainPath).catch(() => null);
    if (checkedOut !== candidate.branch)
      await gitOk(projectRoot, ['branch', '-D', candidate.branch]);
    return;
  }
  await removeWorktree(projectRoot, candidate.branch, true, candidate.worktreePath).catch((err) =>
    console.warn(`[documents] cleanup of ${candidate.branch} failed:`, err),
  );
}

// --- Scope enforcement ----------------------------------------------------

/** Counts hunks of a `-U0` diff whose old-file range lies outside the scope. */
export function countOutOfScopeHunks(diffU0: string, scope: DocumentScope): number {
  if (scope.wholeDocument) return 0;
  let count = 0;
  const re = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diffU0)) !== null) {
    const start = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    // A pure insertion reports the line *before* it with length 0; treat it
    // as touching that line and the next.
    const from = start;
    const to = len === 0 ? start + 1 : start + len - 1;
    // One line of slack on either side: agents routinely re-wrap the
    // neighbouring blank line or paragraph boundary.
    const inScope = to >= scope.startLine - 1 && from <= scope.endLine + 1;
    if (!inScope) count++;
  }
  return count;
}

// --- Dispatch -------------------------------------------------------------

export interface DispatchDocumentRunArgs {
  projectRoot: string;
  documentPath: unknown;
  instruction: unknown;
  scope: unknown;
  candidates: unknown;
}

function parseChangedPaths(porcelainZ: string): string[] {
  const out: string[] = [];
  for (const entry of porcelainZ.split('\0')) {
    if (!entry.trim()) continue;
    // "XY path" or "XY orig -> path" (renames use a second NUL entry; the
    // first path after the status is what we act on).
    const p = entry.slice(3);
    if (p) out.push(p);
  }
  return out;
}

function trailerBlock(entries: [string, string][]): string {
  return entries
    .filter(([, v]) => v.trim().length > 0)
    .map(([k, v]) => `Parallel-${k}: ${v.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

function scopeTrailer(scope: DocumentScope): string {
  if (scope.wholeDocument) return scope.path;
  return `${scope.path}#L${scope.startLine}-L${scope.endLine}`;
}

function commitTitle(summary: string, fallback: string): string {
  const line = (summary || fallback).split('\n')[0].trim();
  return line.length > 72 ? line.slice(0, 69).trimEnd() + '…' : line;
}

async function finalizeCandidate(
  run: DocumentRunRecord,
  candidate: DocumentCandidateRecord,
  outcome: { resultText: string; sessionId?: string; error?: string },
  exitCode: number | null,
  stderrTail: string,
  cancelled: boolean,
): Promise<void> {
  const { worktreePath } = candidate;
  candidate.exitCode = exitCode;
  candidate.finishedAt = nowIso();
  if (outcome.sessionId) candidate.sessionId = outcome.sessionId;
  candidate.resultText = outcome.resultText.slice(0, 50_000);

  if (cancelled) {
    candidate.status = 'cancelled';
    candidate.error = 'Cancelled.';
    return;
  }

  try {
    const changed = parseChangedPaths(
      await git(worktreePath, ['status', '--porcelain', '-z', '--untracked-files=all']),
    );
    const docPath = run.documentPath;
    const outOfScope = changed.filter((p) => p !== docPath);
    if (outOfScope.length > 0) {
      // Keep the document edit, drop everything else.
      const docAbs = path.join(worktreePath, docPath);
      const keep = fs.existsSync(docAbs) ? fs.readFileSync(docAbs, 'utf-8') : null;
      await git(worktreePath, ['checkout', '-q', '--', '.']);
      await git(worktreePath, ['clean', '-fdq']);
      if (keep !== null) fs.writeFileSync(docAbs, keep);
      candidate.outOfScopeFiles = outOfScope.slice(0, 50);
    }

    const docChanged = !(await gitOk(worktreePath, ['diff', '--quiet', '--', docPath]));
    const rationale = parseDocumentRationale(outcome.resultText);
    candidate.rationale = rationale;

    if (!docChanged) {
      candidate.noChanges = true;
      candidate.commitSha = null;
      candidate.status = outcome.error || (exitCode !== 0 && exitCode !== null) ? 'failed' : 'done';
      candidate.error = outcome.error ?? (candidate.status === 'failed' ? stderrTail : undefined);
      return;
    }

    const diffU0 = await git(worktreePath, ['diff', '-U0', '--', docPath]);
    const strayHunks = countOutOfScopeHunks(diffU0, run.scope);
    if (strayHunks > 0) candidate.outOfScopeHunks = strayHunks;

    const body = [
      commitTitle(rationale.summary, `Proposal from ${candidate.agentName}`),
      '',
      ...rationale.changes.map((c) => `- ${c}`),
      '',
      trailerBlock([
        ['Run', run.id],
        ['Agent', candidate.agentName],
        ['Candidate', candidate.label],
        ['Scope', scopeTrailer(run.scope)],
        ['Base', run.baseSha],
      ]),
    ].join('\n');
    await git(worktreePath, ['add', '--', docPath]);
    await git(worktreePath, ['commit', '-q', '-m', body]);
    candidate.commitSha = (await git(worktreePath, ['rev-parse', 'HEAD'])).trim();
    candidate.status = 'done';
    if (outcome.error) candidate.error = outcome.error;
  } catch (err) {
    candidate.status = 'failed';
    candidate.error = errMessage(err);
    candidate.commitSha = null;
  }
}

function spawnCandidate(
  win: BrowserWindow,
  projectRoot: string,
  run: DocumentRunRecord,
  spec: DocumentCandidateSpec,
  candidate: DocumentCandidateRecord,
  prompt: string,
): void {
  const active = activeRuns.get(run.id);
  if (!active) return;

  const launch = buildHeadlessLaunch({
    agentId: spec.agentId,
    command: spec.command,
    prompt,
    sessionId: spec.sessionId,
    newSessionId: randomUUID(),
  });
  const fileEnv = spec.envFile?.trim() ? loadEnvFile(spec.envFile) : {};
  const env = buildPtySpawnEnv({}, fileEnv);
  const parser = createHeadlessParser(spec.agentId);

  const proc = spawn(launch.command, launch.args, {
    cwd: candidate.worktreePath,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const entry: ActiveCandidate = {
    proc,
    cancelled: false,
    timer: setTimeout(() => {
      candidate.error = 'Timed out.';
      proc.kill('SIGTERM');
    }, CANDIDATE_TIMEOUT_MS),
  };
  active.candidates.set(candidate.id, entry);

  let stderrTail = '';
  const log = (text: string) => {
    const clipped =
      text.length > MAX_LOG_LINE_CHARS ? text.slice(0, MAX_LOG_LINE_CHARS) + '…' : text;
    sendEvent(win, { type: 'log', runId: run.id, candidateId: candidate.id, text: clipped });
  };

  proc.stdout?.on('data', (chunk: Buffer) => {
    for (const line of parser.feed(chunk.toString('utf8'))) log(line);
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
    if (text.trim()) log(text.trimEnd());
  });

  let settled = false;
  const settle = async (exitCode: number | null, spawnError?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(entry.timer);
    const outcome = parser.finish();
    if (spawnError) outcome.error = spawnError.message;
    else if (candidate.error === 'Timed out.') outcome.error = 'Timed out.';
    await finalizeCandidate(run, candidate, outcome, exitCode, stderrTail, entry.cancelled);
    active.candidates.delete(candidate.id);
    sendEvent(win, { type: 'candidate', runId: run.id, candidate });
    if (active.candidates.size === 0) {
      activeRuns.delete(run.id);
      run.status = 'finished';
      run.finishedAt = nowIso();
    }
    try {
      writeRunRecord(projectRoot, run);
    } catch (err) {
      console.warn('[documents] failed to write run record:', err);
    }
    if (run.status === 'finished') sendEvent(win, { type: 'run', run });
  };

  proc.on('close', (code) => void settle(code));
  proc.on('error', (err) => void settle(1, err));
}

export async function dispatchDocumentRun(
  win: BrowserWindow,
  args: DispatchDocumentRunArgs,
): Promise<DocumentRunRecord> {
  const { projectRoot } = args;
  const documentPath = validateDocumentPath(args.documentPath);
  if (typeof args.instruction !== 'string' || !args.instruction.trim())
    throw new Error('instruction must be a non-empty string');
  if (args.instruction.length > MAX_INSTRUCTION_CHARS) throw new Error('instruction is too long');
  const instruction = args.instruction;
  const scope = validateScope(args.scope, documentPath);
  const specs = validateCandidateSpecs(args.candidates);
  if (specs.filter((s) => s.isMain).length > 1) throw new Error('Only one main candidate per run');
  for (const spec of specs) validateCommand(spec.command);

  return withProjectLock(projectRoot, async () => {
    if (!fs.existsSync(path.join(projectRoot, documentPath)))
      throw new Error(`Document not found: ${documentPath}`);
    const baseSha = await commitPendingEdits(projectRoot);
    const runId = randomUUID();
    const run: DocumentRunRecord = {
      version: 1,
      id: runId,
      documentPath,
      createdAt: nowIso(),
      instruction,
      scope,
      baseSha,
      status: 'running',
      candidates: [],
    };

    const prepared: { spec: DocumentCandidateSpec; candidate: DocumentCandidateRecord }[] = [];
    try {
      for (const spec of specs) {
        const branch = candidateBranch(runId, spec.label);
        const worktreePath = spec.isMain
          ? await prepareMainWorktree(projectRoot, branch, baseSha)
          : await prepareAlternateWorktree(projectRoot, branch, baseSha);
        const candidate: DocumentCandidateRecord = {
          id: spec.id,
          label: spec.label,
          agentId: spec.agentId,
          agentName: spec.agentName,
          isMain: spec.isMain,
          branch,
          worktreePath,
          status: 'running',
          commitSha: null,
          startedAt: nowIso(),
        };
        run.candidates.push(candidate);
        prepared.push({ spec, candidate });
      }
    } catch (err) {
      for (const { candidate } of prepared) await cleanupCandidate(projectRoot, candidate);
      throw err;
    }

    writeRunRecord(projectRoot, run);
    activeRuns.set(runId, { projectRoot, candidates: new Map() });

    for (const { spec, candidate } of prepared) {
      let catchUpDiff: string | undefined;
      if (spec.sessionId && spec.sessionLastSha && spec.sessionLastSha !== baseSha) {
        catchUpDiff = await git(projectRoot, [
          'diff',
          `${spec.sessionLastSha}..${baseSha}`,
          '--',
          documentPath,
        ]).catch(() => undefined);
      }
      const prompt = buildDocumentPrompt({ documentPath, scope, instruction, catchUpDiff });
      try {
        spawnCandidate(win, projectRoot, run, spec, candidate, prompt);
      } catch (err) {
        candidate.status = 'failed';
        candidate.error = errMessage(err);
        candidate.finishedAt = nowIso();
      }
    }

    const active = activeRuns.get(runId);
    if (active && active.candidates.size === 0) {
      activeRuns.delete(runId);
      run.status = 'finished';
      run.finishedAt = nowIso();
    }
    writeRunRecord(projectRoot, run);
    sendEvent(win, { type: 'run', run });
    return run;
  });
}

export function cancelDocumentRun(runId: unknown): void {
  const id = validateRunId(runId);
  const active = activeRuns.get(id);
  if (!active) return;
  for (const entry of active.candidates.values()) {
    entry.cancelled = true;
    entry.proc.kill('SIGTERM');
  }
}

// --- Accept / reject ------------------------------------------------------

function integrationMessage(run: DocumentRunRecord, candidate: DocumentCandidateRecord): string {
  const rationale = candidate.rationale;
  const lines = [
    commitTitle(rationale?.summary ?? '', `Accept proposal from ${candidate.agentName}`),
    '',
  ];
  if (rationale?.changes.length) lines.push(...rationale.changes.map((c) => `- ${c}`), '');
  if (rationale?.assumptions.length)
    lines.push('Assumptions:', ...rationale.assumptions.map((c) => `- ${c}`), '');
  if (rationale?.questions.length)
    lines.push('Open questions:', ...rationale.questions.map((c) => `- ${c}`), '');
  lines.push(
    trailerBlock([
      ['Run', run.id],
      ['Agent', candidate.agentName],
      ['Candidate', candidate.label],
      ['Scope', scopeTrailer(run.scope)],
      ['Base', run.baseSha],
      ['Instruction', run.instruction.slice(0, 300)],
    ]),
  );
  return lines.join('\n');
}

export async function acceptDocumentCandidate(
  projectRoot: string,
  runIdRaw: unknown,
  candidateIdRaw: unknown,
): Promise<{ sha: string }> {
  const runId = validateRunId(runIdRaw);
  const candidateId = validateCandidateId(candidateIdRaw);
  return withProjectLock(projectRoot, async () => {
    const run = requireRunRecord(projectRoot, runId);
    if (run.status === 'accepted') throw new Error('This run was already accepted.');
    if (run.status === 'rejected') throw new Error('This run was rejected.');
    if (activeRuns.has(runId)) throw new Error('Wait for every candidate to finish first.');
    const candidate = run.candidates.find((c) => c.id === candidateId);
    if (!candidate) throw new Error('Candidate not found');
    if (!candidate.commitSha) throw new Error('This candidate produced no change to accept.');
    if (!(await gitOk(projectRoot, ['cat-file', '-e', `${candidate.commitSha}^{commit}`])))
      throw new Error('The proposal commit no longer exists.');

    await commitPendingEdits(projectRoot);
    const head = await headSha(projectRoot);
    if (head !== run.baseSha) {
      // The base moved: a three-way squash merge either applies cleanly or
      // the proposal is stale. Never leave a half-merged tree behind.
      const ok = await gitOk(projectRoot, ['merge', '--squash', '-q', candidate.commitSha]);
      if (!ok) {
        await gitOk(projectRoot, ['reset', '--hard', '-q', 'HEAD']);
        run.status = 'stale';
        writeRunRecord(projectRoot, run);
        throw new Error(
          'The document changed since this proposal was made and the change no longer applies. Re-run it.',
        );
      }
    } else {
      await git(projectRoot, ['merge', '--squash', '-q', candidate.commitSha]);
    }

    run.status = 'accepted';
    run.acceptedCandidateId = candidateId;
    run.finishedAt = run.finishedAt ?? nowIso();
    writeRunRecord(projectRoot, run);
    try {
      await git(projectRoot, ['add', '-f', '--', runRecordRelPath(runId)]);
      await git(projectRoot, ['commit', '-q', '-m', integrationMessage(run, candidate)]);
    } catch (err) {
      await gitOk(projectRoot, ['reset', '--hard', '-q', 'HEAD']);
      run.status = 'finished';
      run.acceptedCandidateId = undefined;
      writeRunRecord(projectRoot, run);
      throw new Error(`Integration commit failed: ${errMessage(err)}`);
    }
    const sha = (await git(projectRoot, ['rev-parse', 'HEAD'])).trim();
    for (const c of run.candidates) await cleanupCandidate(projectRoot, c);
    return { sha };
  });
}

export async function rejectDocumentRun(
  projectRoot: string,
  runIdRaw: unknown,
): Promise<DocumentRunRecord> {
  const runId = validateRunId(runIdRaw);
  cancelDocumentRun(runId);
  return withProjectLock(projectRoot, async () => {
    const run = requireRunRecord(projectRoot, runId);
    if (run.status === 'accepted') throw new Error('An accepted run cannot be rejected.');
    for (const c of run.candidates) await cleanupCandidate(projectRoot, c);
    run.status = 'rejected';
    run.finishedAt = run.finishedAt ?? nowIso();
    for (const c of run.candidates) {
      if (c.status === 'running') c.status = 'cancelled';
    }
    writeRunRecord(projectRoot, run);
    // Keep the record in history (it documents what was tried) without
    // touching content: a metadata-only commit the history view filters out.
    try {
      await git(projectRoot, ['add', '-f', '--', runRecordRelPath(runId)]);
      await git(projectRoot, [
        'commit',
        '-q',
        '-m',
        `Reject proposals\n\nParallel-Run: ${runId}\nParallel-Metadata: true`,
        '--',
        runRecordRelPath(runId),
      ]);
    } catch (err) {
      console.warn('[documents] could not commit rejected run record:', err);
    }
    return run;
  });
}

export function setDocumentCandidateNote(
  projectRoot: string,
  runIdRaw: unknown,
  candidateIdRaw: unknown,
  note: unknown,
): DocumentRunRecord {
  const runId = validateRunId(runIdRaw);
  const candidateId = validateCandidateId(candidateIdRaw);
  if (typeof note !== 'string') throw new Error('note must be a string');
  const run = requireRunRecord(projectRoot, runId);
  const candidate = run.candidates.find((c) => c.id === candidateId);
  if (!candidate) throw new Error('Candidate not found');
  candidate.note = note.slice(0, 5_000) || undefined;
  writeRunRecord(projectRoot, run);
  return run;
}

// --- History --------------------------------------------------------------

const TRAILER_RE = /^Parallel-([A-Za-z]+):\s*(.*)$/;

/** Splits a commit body into prose and `Parallel-*` trailers. Exported for tests. */
export function parseCommitBody(body: string): { text: string; trailers: Record<string, string> } {
  const trailers: Record<string, string> = {};
  const text: string[] = [];
  for (const line of body.split('\n')) {
    const m = TRAILER_RE.exec(line.trim());
    if (m) trailers[m[1]] = m[2].trim();
    else text.push(line);
  }
  return { text: text.join('\n').trim(), trailers };
}

export async function getDocumentHistory(
  projectRoot: string,
  documentPath: string,
  wholeProject: boolean,
  limit = 200,
): Promise<DocumentHistoryEntry[]> {
  const pathArgs = wholeProject ? ['--', '.', ':(exclude).parallel'] : ['--', documentPath];
  let out = '';
  try {
    out = await git(projectRoot, [
      'log',
      `--max-count=${limit}`,
      '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%b%x1e',
      ...pathArgs,
    ]);
  } catch {
    return [];
  }
  const entries: DocumentHistoryEntry[] = [];
  for (const record of out.split('\x1e')) {
    if (!record.trim()) continue;
    const [sha, shortSha, author, at, subject, body = ''] = record.replace(/^\n/, '').split('\x1f');
    if (!sha) continue;
    const { text, trailers } = parseCommitBody(body);
    entries.push({
      sha,
      shortSha,
      subject,
      body: text,
      author,
      timestamp: Number(at) || 0,
      trailers,
      manual: !trailers.Agent,
    });
  }
  return entries;
}

export async function getDocumentAtCommit(
  projectRoot: string,
  sha: string,
  documentPath: string,
): Promise<string | null> {
  try {
    return await git(projectRoot, ['show', `${sha}:${documentPath}`]);
  } catch {
    return null;
  }
}

/** Unified diff of one document between two commits (`from` may be `<sha>^`). */
export async function getDocumentDiff(
  projectRoot: string,
  from: string,
  to: string,
  documentPath: string,
): Promise<string> {
  try {
    return await git(projectRoot, ['diff', '-U3', `${from}..${to}`, '--', documentPath]);
  } catch {
    // Root commit: nothing to diff against.
    return '';
  }
}

export async function revertDocumentCommit(projectRoot: string, sha: string): Promise<string> {
  return withProjectLock(projectRoot, async () => {
    await commitPendingEdits(projectRoot);
    try {
      await git(projectRoot, ['revert', '--no-edit', sha]);
    } catch (err) {
      await gitOk(projectRoot, ['revert', '--abort']);
      throw new Error(`Revert failed: ${errMessage(err)}`);
    }
    return (await git(projectRoot, ['rev-parse', 'HEAD'])).trim();
  });
}

/** Markdown files tracked in the repository, for the document picker. */
export async function listDocumentFiles(projectRoot: string): Promise<string[]> {
  try {
    const out = await git(projectRoot, ['ls-files', '-z', '--', '*.md', '*.markdown']);
    return out
      .split('\0')
      .filter((p) => p && !p.startsWith('.parallel/') && !p.startsWith('.worktrees/'))
      .slice(0, 1000);
  } catch {
    return [];
  }
}

/** Kill every running proposal process; used on app quit. */
export function stopAllDocumentRuns(): void {
  for (const [runId] of activeRuns) cancelDocumentRun(runId);
}
