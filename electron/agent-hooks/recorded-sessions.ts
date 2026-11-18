import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { HookSource } from './hook-pipeline.js';

/** What the task shows at a point in a session: the attention state the UI reads. */
export type SessionExpectation = 'active' | 'needs_input' | 'idle';

/**
 * One thing that happened in a recorded session, in order. `hook` is a raw hook
 * payload, `output` what the agent wrote to its terminal, `input` what the user
 * typed, `wait` the milliseconds that passed, and `expect` what the task should
 * show at that point, written by whoever annotated the recording.
 */
export type SessionStep =
  | { hook: unknown }
  | { output: string }
  | { input: string }
  | { wait: number }
  | { expect: SessionExpectation };

export interface RecordedSession {
  /** File name without `.json`, e.g. `codex-0.167.0-tool-turn`. */
  name: string;
  /** The agent's command name, e.g. `claude` or `codex`; it picks the hook mapping. */
  command: string;
  /** Which hook route the payloads came in on, as the hook server tells them apart. */
  hooks: HookSource | 'none';
  version: string;
  summary: string;
  /** How it was recorded and what was replaced, so it can be redone for a new version. */
  recorded: string;
  steps: SessionStep[];
}

const SESSIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sessions');
const EXPECTATIONS: ReadonlySet<string> = new Set(['active', 'needs_input', 'idle']);

function isStep(value: unknown): value is SessionStep {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const [key, field] = Object.entries(value)[0] ?? [];
  if (key === 'hook') return typeof field === 'object' && field !== null;
  if (key === 'output' || key === 'input') return typeof field === 'string';
  if (key === 'wait') return typeof field === 'number' && field >= 0;
  return key === 'expect' && typeof field === 'string' && EXPECTATIONS.has(field);
}

function parseSession(name: string, raw: unknown): RecordedSession {
  const s = raw as Partial<RecordedSession> | null;
  const valid =
    typeof s?.command === 'string' &&
    (s.hooks === 'claude' || s.hooks === 'codex' || s.hooks === 'none') &&
    typeof s.version === 'string' &&
    typeof s.summary === 'string' &&
    typeof s.recorded === 'string' &&
    Array.isArray(s.steps) &&
    s.steps.every(isStep);
  if (!valid) throw new Error(`recorded session ${name} is malformed`);
  // An unannotated recording would replay green while checking nothing.
  if (!s?.steps?.some((step) => 'expect' in step))
    throw new Error(`recorded session ${name} has no expect steps`);
  return { ...(s as RecordedSession), name };
}

/** Every recorded session in `sessions/`, sorted by name. Test support only. */
export function loadRecordedSessions(): RecordedSession[] {
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const name = file.slice(0, -'.json'.length);
      return parseSession(name, JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8')));
    });
}

/** The raw hook payloads of one recorded session, in order. */
export function recordedHookPayloads(name: string): unknown[] {
  const session = loadRecordedSessions().find((s) => s.name === name);
  if (!session) throw new Error(`no recorded session ${name}`);
  return session.steps.flatMap((step) => ('hook' in step ? [step.hook] : []));
}
