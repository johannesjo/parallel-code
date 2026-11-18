/**
 * Program Status Protocol (OSC 7501, rev 0.3): any program in a terminal can
 * report idle / working / blocked / done / error with one escape sequence.
 * Spec: https://www.superlogical.com/rex/docs/build/program-status
 *
 * Claude Code emits it natively; any other agent or wrapper script can print
 * it. Reports from a launch that has no lifecycle hooks become hook-status
 * updates, so the task board, tooltips and coordinator read them like hooks.
 */

import { emitAgentHookEvent } from './events.js';
import { isCurrentAgentLaunch, observeAgentHook } from './observations.js';
import type { AgentHookPrompt, AgentHookStatusUpdate } from './status.js';

export const PROGRAM_STATUS_OSC = 7501;
/** A supporting terminal answers the `?` feature query with the same bytes. */
export const PROGRAM_STATUS_QUERY_REPLY = '\x1b]7501;?\x1b\\';
/** Hook event name for reports that have no Claude-style counterpart. */
export const PROGRAM_STATUS_EVENT = 'ProgramStatus';

type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error';
type ProgramKind = 'permission' | 'question' | 'auth';

export interface ProgramStatusReport {
  state: ProgramState | 'clear';
  /** Record path such as `build/test`; empty for the root record. */
  id: string;
  kind?: ProgramKind;
  msg?: string;
}

const STATES: ReadonlySet<string> = new Set([
  'idle',
  'working',
  'done',
  'blocked',
  'error',
  'clear',
]);
const KINDS: ReadonlySet<string> = new Set(['permission', 'question', 'auth']);
const KEY = /^[a-z]+$/;
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const ID = /^[A-Za-z0-9_.+-]{1,32}(?:\/[A-Za-z0-9_.+-]{1,32}){0,7}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// eslint-disable-next-line no-control-regex -- the spec forbids exactly these
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Direction overrides and invisible formatting, disarmed before display. */
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
/** 4096 bytes for the whole sequence, minus `ESC ] 7501 ;` and `ESC \`. */
const MAX_PAYLOAD = 4096 - 9;
const MAX_KEY = 16;
const MAX_ID = 128;
/** Encoded and decoded byte caps for the free-text keys. */
const TEXT_LIMITS: Record<string, { encoded: number; decoded: number }> = {
  msg: { encoded: 2732, decoded: 2048 },
  title: { encoded: 256, decoded: 192 },
};

/** Key/value pairs; a malformed pair is skipped, an over-long key voids the report. */
function parsePairs(payload: string): Map<string, string> | null {
  const pairs = new Map<string, string>();
  for (const raw of payload.split(':')) {
    const eq = raw.indexOf('=');
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (eq <= 0 || !KEY.test(key) || !VALUE.test(value)) continue;
    if (key.length > MAX_KEY) return null;
    pairs.set(key, value);
  }
  return pairs;
}

/** Decodes a base64 UTF-8 value; null when the spec says to discard the report. */
function decodeText(value: string, limit: { encoded: number; decoded: number }): string | null {
  if (value.length > limit.encoded || !BASE64.test(value)) return null;
  const unpadded = value.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=');
  let text: string;
  try {
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    if (bytes.length > limit.decoded) return null;
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null; // invalid base64 or UTF-8: the spec discards the whole report
  }
  return CONTROL.test(text) ? null : text.replace(INVISIBLE, '');
}

/**
 * Parses the payload of an OSC 7501 sequence (what follows `7501;`). Returns
 * `'query'` for feature detection and null for a report the spec ignores.
 */
export function parseProgramStatus(payload: string): ProgramStatusReport | 'query' | null {
  // Characters first, so an oversized payload is never encoded just to measure it.
  if (payload.length > MAX_PAYLOAD || new TextEncoder().encode(payload).length > MAX_PAYLOAD)
    return null;
  if (payload.trim() === '?') return 'query';
  const pairs = parsePairs(payload);
  const state = pairs?.get('state');
  if (!pairs || !state || !STATES.has(state)) return null;
  const id = pairs.get('id') ?? '';
  if (id && (id.length > MAX_ID || !ID.test(id))) return null;
  let msg: string | undefined;
  for (const key of ['msg', 'title']) {
    const value = pairs.get(key);
    if (value === undefined) continue;
    const text = decodeText(value, TEXT_LIMITS[key]);
    if (text === null) return null;
    if (key === 'msg' && text.trim()) msg = text.trim();
  }
  const kind = pairs.get('kind');
  return {
    state: state as ProgramStatusReport['state'],
    id,
    ...(state === 'blocked' && kind && KINDS.has(kind) ? { kind: kind as ProgramKind } : {}),
    ...(msg ? { msg } : {}),
  };
}

interface ProgramRecord {
  state: ProgramState;
  kind?: ProgramKind;
  msg?: string;
}

/** The spec's floor; past it the least recently updated record goes. */
const MAX_RECORDS = 64;
const URGENCY: readonly ProgramState[] = ['blocked', 'error', 'working', 'done', 'idle'];
const PROMPTS: Partial<Record<ProgramKind, AgentHookPrompt>> = {
  permission: 'permission',
  question: 'question',
};
const DETAIL_MAX_CHARS = 200;

function toUpdate(record: ProgramRecord, background: boolean): AgentHookStatusUpdate {
  const detail =
    record.msg && record.msg.length > DETAIL_MAX_CHARS
      ? `${record.msg.slice(0, DETAIL_MAX_CHARS - 1)}…`
      : record.msg;
  const base = { event: PROGRAM_STATUS_EVENT, ...(detail ? { detail } : {}) };
  switch (record.state) {
    case 'blocked': {
      const prompt = record.kind && PROMPTS[record.kind];
      return { ...base, state: 'waiting', ...(prompt ? { prompt } : {}) };
    }
    case 'working':
      return { ...base, state: 'working', ...(background ? { background } : {}) };
    // Claude's turn-boundary names, so unread marks and failure states apply.
    case 'error':
      return { ...base, state: 'done', event: 'StopFailure' };
    case 'done':
      return { ...base, state: 'done', event: 'Stop' };
    case 'idle':
      return { ...base, state: 'done' };
  }
}

/** The most urgent record wins; root and child records hold at the same time. */
function summarize(records: ReadonlyMap<string, ProgramRecord>): AgentHookStatusUpdate {
  const root = records.get('');
  for (const state of URGENCY) {
    const hit = root?.state === state ? root : [...records.values()].find((r) => r.state === state);
    // A worker still running under a finished lead is background work: the lead
    // sits at its prompt, yet the task is not done.
    if (hit) return toUpdate(hit, root !== undefined && hit !== root);
  }
  return { state: 'done', event: PROGRAM_STATUS_EVENT };
}

/**
 * One terminal's records, reduced to a single status after every report. A
 * clear that removes nothing yields null: the status it would claim was never reported.
 */
export function createProgramStatusRecords(): {
  apply(report: ProgramStatusReport): AgentHookStatusUpdate | null;
} {
  const records = new Map<string, ProgramRecord>();
  return {
    apply(report) {
      if (report.state === 'clear') {
        const before = records.size;
        for (const id of [...records.keys()]) {
          if (!report.id || id === report.id || id.startsWith(`${report.id}/`)) records.delete(id);
        }
        if (records.size === before) return null;
      } else {
        // Re-inserted so the map's order stays least recently updated first.
        records.delete(report.id);
        records.set(report.id, { state: report.state, kind: report.kind, msg: report.msg });
        if (records.size > MAX_RECORDS) records.delete(records.keys().next().value ?? '');
      }
      return summarize(records);
    },
  };
}

/** Feeds one launch's reports into the hook-status pipeline, like a hook event. */
export function createProgramStatusReporter(launch: {
  agentId: string;
  taskId: string;
  launchId: string;
}): (report: ProgramStatusReport) => void {
  const records = createProgramStatusRecords();
  return (report) => {
    const update = records.apply(report);
    if (!update || !isCurrentAgentLaunch(launch.agentId, launch.taskId, launch.launchId)) return;
    const event = { ...update, ...launch, at: Date.now() };
    observeAgentHook(event);
    emitAgentHookEvent(event);
  };
}
