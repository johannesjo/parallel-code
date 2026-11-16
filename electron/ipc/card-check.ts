/**
 * Runs a project check for a check card. The check is the user's own command,
 * run like any verify run; a card adds only its context as `PC_*` files in a
 * per-run directory outside the worktree, and in JSON mode reads the object
 * the command wrote to `PC_OUT_FILE`. See docs/cards.md.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { CardCheckResult } from './shared-types.js';
import type { VerificationRunner } from './verify.js';

/** The result file's ceiling; each slot's own limit is far lower. */
export const CARD_OUT_MAX_BYTES = 64 * 1024;

export type CardCheckMode = 'exit-code' | 'json';

export interface CardCheckRequest {
  key: string;
  worktreePath: string;
  command: string;
  mode: CardCheckMode;
  /** The verify variables plus `PC_TASK_NAME` and `PC_BASE_BRANCH`. */
  env: Record<string, string>;
  /** The card's last values as JSON, handed over as `PC_PREVIOUS_FILE`. */
  previous?: string;
  /** The task's branch diff, handed over as `PC_DIFF_FILE`; empty when it could not be read. */
  diff: string;
}

/** Runs of a task's check cards share this prefix, so deleting the task stops them all. */
export function cardRunKeyPrefix(taskId: string): string {
  return `${taskId}:card:`;
}

export function cardRunKey(taskId: string, cardId: string): string {
  return `${cardRunKeyPrefix(taskId)}${cardId}`;
}

async function writeContext(
  dir: string,
  request: CardCheckRequest,
): Promise<Record<string, string>> {
  const diffFile = path.join(dir, 'diff.patch');
  await fs.writeFile(diffFile, request.diff);
  const env = { ...request.env, PC_OUT_FILE: path.join(dir, 'out.json'), PC_DIFF_FILE: diffFile };
  if (request.previous === undefined) return env;
  const previousFile = path.join(dir, 'previous.json');
  await fs.writeFile(previousFile, request.previous);
  return { ...env, PC_PREVIOUS_FILE: previousFile };
}

type Output = Pick<CardCheckResult, 'output' | 'error'>;

async function readOutput(file: string): Promise<Output> {
  const handle = await fs.open(file, 'r').catch(() => undefined);
  if (!handle) return { error: 'PC_OUT_FILE missing' };
  try {
    // Read one byte past the cap so an oversized file is told apart without reading it all.
    // A read error propagates, so it is not reported as bad JSON.
    const buffer = Buffer.alloc(CARD_OUT_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > CARD_OUT_MAX_BYTES) return { error: 'PC_OUT_FILE is larger than 64 KB' };
    return parseOutput(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}

function parseOutput(text: string): Output {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'PC_OUT_FILE is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { error: 'PC_OUT_FILE must hold one JSON object' };
  return { output: parsed as Record<string, unknown> };
}

/**
 * Runs the check with its context files and reads its result. The files are
 * deleted afterwards, whatever the outcome; only a passed JSON-mode run is read.
 */
export async function runCardCheck(
  runner: Pick<VerificationRunner, 'start'>,
  request: CardCheckRequest,
): Promise<CardCheckResult> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-card-'));
  try {
    const env = await writeContext(dir, request);
    const run = await runner.start({
      key: request.key,
      worktreePath: request.worktreePath,
      command: request.command,
      env,
      lowPriority: true,
    });
    if (request.mode !== 'json' || run.status !== 'passed') return { run };
    return { run, ...(await readOutput(env.PC_OUT_FILE)) };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
