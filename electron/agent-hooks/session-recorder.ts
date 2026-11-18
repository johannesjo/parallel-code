import fs from 'fs';
import path from 'path';
import { warn as logWarn, errMessage } from '../log.js';
import type { HookSource } from './hook-pipeline.js';
import type { SessionStep } from './recorded-sessions.js';

/** Set to an absolute directory to record every agent launch for status replay tests. */
export const RECORD_SESSIONS_ENV = 'PARALLEL_CODE_RECORD_SESSIONS';

/** Gaps shorter than this are not worth a `wait` step; screen timers run in seconds. */
const MIN_WAIT_MS = 20;
/** Past this nothing more is kept; a status bug shows within minutes, not hours. */
const MAX_RECORDED_CHARS = 8 * 1024 * 1024;

interface Recording {
  file: string;
  command: string;
  hooks: HookSource | 'none';
  steps: SessionStep[];
  lastAt: number;
  chars: number;
}

const recordings = new Map<string, Recording>();
let warnedRelative = false;

/** The recording directory, or undefined when recording is off or misconfigured. */
function recordDir(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env[RECORD_SESSIONS_ENV];
  if (!dir) return undefined;
  if (path.isAbsolute(dir)) return dir;
  if (!warnedRelative) logWarn('agent-hooks', `${RECORD_SESSIONS_ENV} must be an absolute path`);
  warnedRelative = true;
  return undefined;
}

/** Adds the time since the last step, so replayed timers see the same pauses. */
function pushWait(recording: Recording): void {
  const now = Date.now();
  const gap = now - recording.lastAt;
  if (gap >= MIN_WAIT_MS) recording.steps.push({ wait: gap });
  recording.lastAt = now;
}

function push(launchId: string, step: SessionStep, size: number): void {
  const recording = recordings.get(launchId);
  if (!recording || recording.chars > MAX_RECORDED_CHARS) return;
  pushWait(recording);
  recording.chars += size;
  recording.steps.push(step);
}

/**
 * Starts recording an agent launch when `PARALLEL_CODE_RECORD_SESSIONS` is
 * set. Everything the launch prints, everything typed into it and its raw hook
 * payloads are kept in memory and written as one session file on exit, ready
 * to trim and annotate with `expect` steps (see `sessions/README.md`).
 * Recordings hold whatever was typed or shown, passwords included, so they are
 * written owner-only and never leave the machine unless someone reviews them.
 */
export function startSessionRecording(
  launchId: string,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = recordDir(env);
  if (!dir) return;
  const name = path.basename(command).replace(/[^\w.-]/g, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${name}-${stamp}-${launchId.slice(0, 8)}.json`);
  recordings.set(launchId, {
    file,
    command: name,
    hooks: 'none',
    steps: [],
    lastAt: Date.now(),
    chars: 0,
  });
}

export function recordSessionOutput(launchId: string, data: string): void {
  push(launchId, { output: data }, data.length);
}

export function recordSessionInput(launchId: string, data: string): void {
  push(launchId, { input: data }, data.length);
}

/** Records a payload before mapping, on purpose: ignored payloads are evidence too. */
export function recordSessionHook(launchId: string, source: HookSource, payload: unknown): void {
  const recording = recordings.get(launchId);
  if (!recording || payload === null) return;
  recording.hooks = source;
  push(launchId, { hook: payload }, JSON.stringify(payload).length);
}

/** Writes the launch's recording, if any, and forgets it. */
export function finishSessionRecording(launchId: string): void {
  const recording = recordings.get(launchId);
  if (!recording) return;
  recordings.delete(launchId);
  // The quiet stretch before exit is where an interrupt or idle timer settles.
  if (recording.chars <= MAX_RECORDED_CHARS) pushWait(recording);
  const truncated =
    recording.chars > MAX_RECORDED_CHARS ? '; everything past 8 MB was dropped' : '';
  const session = {
    command: recording.command,
    hooks: recording.hooks,
    version: 'unknown',
    summary: 'Describe what happens, then trim to the interesting part and add expect steps.',
    recorded: `Recorded with ${RECORD_SESSIONS_ENV} in Parallel Code${truncated}. Replace ids, paths and anything private.`,
    steps: recording.steps,
  };
  try {
    fs.mkdirSync(path.dirname(recording.file), { recursive: true, mode: 0o700 });
    // Each file name is new, so the owner-only mode always applies.
    fs.writeFileSync(recording.file, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    // A recording is a debugging aid; failing to save one must not disturb the agent's exit.
    logWarn('agent-hooks', 'could not write session recording', { err: errMessage(err) });
  }
}
