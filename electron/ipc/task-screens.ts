import { execFile } from 'child_process';
import { rmSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { getDiffBaseSha } from './git.js';
import { killAllCaptures, startCapture } from './task-screens-run.js';
import { freePorts, startServer } from './task-screens-serve.js';
import { changedFilesNote, worktreeStatus } from './task-screens-changes.js';
import {
  commandsToRun,
  parseScreensAnswer,
  buildScreensPrompt,
  SYSTEM_PROMPT,
  type ScreensAnswer,
  type ShotPaths,
  type Side,
} from './task-screens-answer.js';
import { shootPage } from './task-screens-shoot.js';
import type {
  ScreenImage,
  ScreenShot,
  ServeCommands,
  TaskScreensResult,
} from '../shared/task-screens.js';
import { errMessage, warn as logWarn } from '../log.js';

const execFileAsync = promisify(execFile);

// Every image crosses IPC as a data URL and stays in the renderer's memory.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Where a version of the app answers, or why it did not start. */
type Origin = { url: string } | { error: string };
type Origins = Partial<Record<Side, Origin>>;

/** What serving one run's versions needs. */
interface ServeContext {
  dirs: Record<Side, string>;
  ports: Record<Side, number>;
  /** The capture's environment, so ending the capture stops the servers too. */
  env: Record<string, string>;
  /** Where each server's output goes, to tell why it did not start. */
  logDir: string;
  cancelled: () => boolean;
}

async function serveVersion(side: Side, command: string, ctx: ServeContext): Promise<Origin> {
  const port = ctx.ports[side];
  const logFile = join(ctx.logDir, `${side}.log`);
  try {
    const { env, cancelled } = ctx;
    await startServer({ cwd: ctx.dirs[side], command, port, env, logFile, cancelled });
    return { url: `http://localhost:${port}` };
  } catch (error) {
    return { error: `The version ${side} the task did not start: ${errMessage(error)}` };
  }
}

/**
 * Starts the versions the screens need, side by side. The app starts them, not
 * Claude: a server started in Claude's sandbox ends with the command that
 * started it, and listens where no window outside the sandbox can reach.
 */
async function serveVersions(commands: ServeCommands, ctx: ServeContext): Promise<Origins> {
  const [after, before] = await Promise.all([
    serveVersion('after', commands.after, ctx),
    commands.before ? serveVersion('before', commands.before, ctx) : undefined,
  ]);
  return { after, ...(before && { before }) };
}

function pageUrl(origin: Origin | undefined, path: string): string {
  if (!origin) throw new Error('The version was not started.');
  if ('error' in origin) throw new Error(origin.error);
  return origin.url + path;
}

/** Photographs a page into the output folder; the file opens in the system viewer. */
async function shootTo(outDir: string, url: string, name: string): Promise<ScreenImage> {
  const png = await shootPage(url);
  if (png.length > MAX_IMAGE_BYTES) throw new Error(`Screenshot too large: ${url}`);
  const file = join(outDir, name);
  await writeFile(file, png);
  return { path: file, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
}

/** Where a run's screenshots go, and whether it was cancelled meanwhile. */
interface ShootTarget {
  outDir: string;
  run: ActiveRun;
}

/** Photographs each screen in both versions; a screen that fails is left out, with why. */
async function shootAll(
  list: ShotPaths[],
  origins: Origins,
  { outDir, run }: ShootTarget,
): Promise<{ shots: ScreenShot[]; errors: string[] }> {
  const shots: ScreenShot[] = [];
  const errors: string[] = [];
  for (const [index, shot] of list.entries()) {
    if (run.cancelled) break;
    const name = (side: Side) => `${index + 1}-${side}.png`;
    try {
      const after = await shootTo(outDir, pageUrl(origins.after, shot.after), name('after'));
      const before = shot.before
        ? await shootTo(outDir, pageUrl(origins.before, shot.before), name('before'))
        : undefined;
      shots.push({ label: shot.label, after, ...(before && { before }) });
    } catch (error) {
      errors.push(errMessage(error));
      logWarn('taskScreens', 'Skipped a screenshot', { error: errMessage(error) });
    }
  }
  return { shots, errors };
}

/** What photographing the answer gave: the shots, and a note on any that are missing. */
async function readResult(
  answer: ScreensAnswer,
  origins: Origins,
  target: ShootTarget,
): Promise<Omit<TaskScreensResult, 'headSha'>> {
  const { shots, errors } = await shootAll(answer.shots, origins, target);
  if (target.run.cancelled) throw new Error('cancelled');
  const note = [
    answer.note,
    // The first reason is enough to act on; the rest are in the log.
    errors.length > 0 &&
      `${errors.length} of the screens could not be photographed: ${errors[0].slice(0, 500)}`,
    !answer.shots.length && !answer.note && 'No screens were captured.',
  ]
    .filter(Boolean)
    .join(' ');
  return { shots, ...(note && { note }) };
}

interface ActiveRun {
  cancelled: boolean;
  /** Set once the CLI runs; before that a cancel only marks the run. */
  stop?: (reason: string) => void;
  /** Settles once the run has ended and cleaned up, however it ended. */
  ended?: Promise<void>;
  /** Set while the run waits for the user to allow its commands; takes the commands allowed. */
  approve?: (commands: ServeCommands) => void;
}

const active = new Map<string, ActiveRun>();
/** Each task's latest output folder: its images open in the system viewer. */
const outDirs = new Map<string, string>();
/** Base checkouts of runs in progress, so a quit can remove them. */
const baseRoots = new Set<string>();

async function discardOutput(taskId: string): Promise<void> {
  const dir = outDirs.get(taskId);
  outDirs.delete(taskId);
  if (dir) await rm(dir, { recursive: true, force: true });
}

/**
 * Stops a task's capture with every process it started, and deletes its
 * screenshots; the renderer calls it on cancel and when the task closes.
 */
export function cancelTaskScreens(taskId: string): void {
  const run = active.get(taskId);
  if (run) return cancelRun(run);
  discardOutput(taskId).catch((error: unknown) =>
    logWarn('taskScreens', 'Could not delete screenshots', { error: errMessage(error) }),
  );
}

function cancelRun(run: ActiveRun): void {
  run.cancelled = true;
  run.stop?.('cancelled');
}

/** Lets a task's capture run the commands it asked about, if they are the ones the user saw. */
export function approveTaskScreens(taskId: string, commands: ServeCommands): void {
  active.get(taskId)?.approve?.(commands);
}

// Holds the base checkout meanwhile; a reload leaves no one to answer.
const ASK_TIMEOUT_MS = 30 * 60_000;

const sameCommands = (a: ServeCommands, b: ServeCommands) =>
  a.after === b.after && a.before === b.before;

/**
 * Waits for the user to allow the commands, which run in their shell outside
 * Claude's sandbox; a cancel meanwhile ends the wait.
 */
async function askToServe(run: ActiveRun, commands: ServeCommands, ask: Ask): Promise<void> {
  const stop = run.stop;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Nobody started the app, so the capture stopped.')),
        ASK_TIMEOUT_MS,
      );
      run.approve = (allowed) => {
        if (sameCommands(allowed, commands)) resolve();
        else logWarn('taskScreens', 'Ignored the approval of other commands');
      };
      run.stop = (reason) => {
        stop?.(reason);
        reject(new Error(reason));
      };
      ask(commands);
    });
  } finally {
    clearTimeout(timer);
    run.stop = stop;
    run.approve = undefined;
  }
}

/** Kills every capture and deletes its files; for app quit, which cannot wait. */
export function stopAllTaskScreens(): void {
  killAllCaptures();
  for (const dir of [...outDirs.values(), ...baseRoots]) {
    // rmSync unlinks symlinks such as node_modules without following them.
    rmSync(dir, { recursive: true, force: true });
  }
  outDirs.clear();
  baseRoots.clear();
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).stdout.trim();
}

async function removeBaseCheckout(worktree: string, baseRoot: string): Promise<void> {
  // `git worktree remove` unlinks symlinks such as node_modules without following them.
  try {
    await git(worktree, ['worktree', 'remove', '--force', join(baseRoot, 'base')]);
  } catch (error) {
    logWarn('taskScreens', 'Could not remove the base checkout', { error: errMessage(error) });
  }
  await rm(baseRoot, { recursive: true, force: true });
  // A failed remove, or a quit mid-run, leaves the checkout registered in the repo.
  await git(worktree, ['worktree', 'prune']).catch((error: unknown) =>
    logWarn('taskScreens', 'Could not prune worktrees', { error: errMessage(error) }),
  );
}

type Ask = (commands: ServeCommands) => void;

interface CaptureArgs {
  taskId: string;
  worktreePath: string;
  baseBranch?: string;
  envFile?: string;
  projectId?: string;
  /** Called with each step of the run, for progress in the UI. */
  onStep: (step: string) => void;
  /** Called with the commands to serve the task, which wait for approveTaskScreens. */
  onAsk: Ask;
}

/** What photographing a run's answer needs. */
interface ShootJob {
  args: CaptureArgs;
  answer: ScreensAnswer;
  ctx: ServeContext;
  target: ShootTarget;
}

/** Serves the versions once the user allows it and photographs them, noting files serving changed. */
async function serveAndShoot(job: ShootJob): Promise<Omit<TaskScreensResult, 'headSha'>> {
  const { args, answer, ctx, target } = job;
  const commands = commandsToRun(answer);
  if (!commands) return readResult(answer, {}, target);
  if (target.run.cancelled) throw new Error('cancelled');
  await askToServe(target.run, commands, args.onAsk);
  const statusBefore = await worktreeStatus(ctx.dirs.after);
  // A server started after the cancel would outlive the run, whose end already ran.
  if (target.run.cancelled) throw new Error('cancelled');
  args.onStep('Starting both versions');
  const origins = await serveVersions(commands, ctx);
  if (target.run.cancelled) throw new Error('cancelled');
  args.onStep('Taking the screenshots');
  const result = await readResult(answer, origins, target);
  const changed = changedFilesNote(statusBefore, await worktreeStatus(ctx.dirs.after));
  const note = [result.note, changed].filter(Boolean).join(' ');
  return { ...result, ...(note && { note }) };
}

/** Checks out the base commit beside the task, serves both versions as Claude says, and photographs them. */
async function captureWithBase(
  args: CaptureArgs,
  outDir: string,
  run: ActiveRun,
): Promise<TaskScreensResult> {
  const worktree = args.worktreePath;
  args.onStep('Checking out the code before the task');
  const baseRoot = await mkdtemp(join(tmpdir(), 'pc-screens-base-'));
  baseRoots.add(baseRoot);
  const base = join(baseRoot, 'base');
  try {
    const headSha = await git(worktree, ['rev-parse', 'HEAD']);
    const baseSha = await getDiffBaseSha(worktree, args.baseBranch);
    await git(worktree, ['worktree', 'add', '--detach', base, baseSha]);
    const [afterPort, beforePort] = await freePorts(2);
    // Until the CLI starts, a cancel only marks the run.
    if (run.cancelled) throw new Error('cancelled');
    const ports = { after: afterPort, before: beforePort };
    const capture = startCapture({
      cwd: worktree,
      addDirs: [base],
      prompt: buildScreensPrompt({ worktree, base, baseSha, ports }),
      systemPrompt: SYSTEM_PROMPT,
      envFile: args.envFile,
      projectId: args.projectId,
      onStep: args.onStep,
    });
    run.stop = capture.stop;
    try {
      const answer = parseScreensAnswer(await capture.result);
      const dirs = { after: worktree, before: base };
      const cancelled = () => run.cancelled;
      const ctx = { dirs, ports, env: capture.env, logDir: baseRoot, cancelled };
      return { ...(await serveAndShoot({ args, answer, ctx, target: { outDir, run } })), headSha };
    } finally {
      // The servers started for the screenshots carry the run's tag.
      capture.end();
    }
  } finally {
    baseRoots.delete(baseRoot);
    await removeBaseCheckout(worktree, baseRoot);
  }
}

/**
 * Cancels a run the renderer no longer knows of and waits for its cleanup:
 * a reload forgets a capture the main process is still running.
 */
async function replaceRun(taskId: string): Promise<void> {
  const previous = active.get(taskId);
  if (!previous) return;
  logWarn('taskScreens', 'Replacing a capture the renderer lost track of', { taskId });
  cancelRun(previous);
  await previous.ended;
}

async function runCapture(args: CaptureArgs, run: ActiveRun): Promise<TaskScreensResult> {
  const { taskId } = args;
  try {
    await discardOutput(taskId);
    const outDir = await mkdtemp(join(tmpdir(), 'pc-screens-'));
    outDirs.set(taskId, outDir);
    return await captureWithBase(args, outDir, run);
  } catch (error) {
    await discardOutput(taskId);
    throw error;
  } finally {
    active.delete(taskId);
  }
}

/**
 * Captures before/after screenshots of a task's interface changes. One run per
 * task at a time: a new request cancels a run still going. A new run replaces
 * the previous one's screenshots, and a failed or cancelled run leaves none.
 */
export async function captureTaskScreens(args: CaptureArgs): Promise<TaskScreensResult> {
  const { taskId } = args;
  await replaceRun(taskId);
  // Two requests replacing the same run: only the first starts.
  if (active.has(taskId)) throw new Error('Screenshots are already being captured.');
  const run: ActiveRun = { cancelled: false };
  active.set(taskId, run);
  const result = runCapture(args, run);
  // Only marks the end for a replacing request; the error itself goes to this caller.
  run.ended = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
