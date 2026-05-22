// Structured logger for the main process.
//
// Pairs with src/lib/log.ts (renderer); both modules expose the same
// `debug | info | warn | error` surface so call sites read identically.
// Renderer logs at warn/error (and info when verbose) are forwarded
// here over LogFromRenderer; this module is the merge point.
//
// This is the one place in the codebase where console.{info,debug}
// is intentional — every other module routes through this logger.

/* eslint-disable no-console */

import type { IpcMain } from 'electron';
import { IPC } from './ipc/channels.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = Record<string, unknown>;

export type LogFromRendererPayload = {
  level: LogLevel;
  category: string;
  msg: string;
  ctx?: LogContext;
  level_min: LogLevel;
  ts: number;
};

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const CTX_MAX_BYTES = 4 * 1024;
const STACK_MAX_LINES = 50;
const RENDERER_MALFORMED_SHAPES = new Set<string>();

const isProd = process.env.NODE_ENV === 'production';
let minLevel: LogLevel = isProd ? 'warn' : 'debug';

let inLogger = false;

// `console.*` writes to process.stdout/stderr asynchronously; if the parent
// pipe closes mid-shutdown (e.g. `concurrently` SIGTERMs us after vite dies),
// the resulting EPIPE surfaces as an *async* 'error' event the per-call
// try/catch in writeConsole can't catch. Swallow EPIPE here so a routine
// teardown doesn't become an Uncaught Exception. Re-throw anything else.
const swallowEpipe = (err: NodeJS.ErrnoException): void => {
  if (err.code !== 'EPIPE') throw err;
};
process.stdout.on('error', swallowEpipe);
process.stderr.on('error', swallowEpipe);

export function setMinLevel(level: LogLevel): void {
  minLevel = level;
}

export function getMinLevel(): LogLevel {
  return minLevel;
}

export function debug(category: string, msg: string, ctx?: LogContext): void {
  emit('debug', category, msg, ctx);
}

export function info(category: string, msg: string, ctx?: LogContext): void {
  emit('info', category, msg, ctx);
}

export function warn(category: string, msg: string, ctx?: LogContext): void {
  emit('warn', category, msg, ctx);
}

export function error(category: string, msg: string, err: unknown, ctx?: LogContext): void {
  emit('error', category, msg, ctx, err);
}

/** Reduce an unknown thrown value to a human-readable string. */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function emit(
  level: LogLevel,
  category: string,
  msg: string,
  ctx: LogContext | undefined,
  err?: unknown,
): void {
  if (inLogger) return;
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  inLogger = true;
  try {
    const ts = formatTimestamp(Date.now());
    const ctxStr = serialiseCtx(ctx);
    const head = `[${ts}] ${level.toUpperCase()} ${category} — ${msg}${ctxStr}`;
    writeConsole(level, head);
    if (level === 'error') {
      const stack = stackFrom(err);
      if (stack !== null) writeConsole(level, stack);
    }
  } catch {
    // Logger never throws into the caller.
  } finally {
    inLogger = false;
  }
}

function writeConsole(level: LogLevel, line: string): void {
  try {
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else if (level === 'info') console.info(line);
    else console.debug(line);
  } catch {
    // ignore — logger never throws
  }
}

function formatTimestamp(epochMs: number): string {
  try {
    const d = new Date(epochMs);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  } catch {
    return '00:00:00.000';
  }
}

function serialiseCtx(ctx: LogContext | undefined): string {
  if (ctx === undefined) return '';
  let body: string;
  try {
    body = JSON.stringify(ctx, replacerWithCircular());
  } catch {
    try {
      const safe: Record<string, unknown> = {};
      for (const k of Object.keys(ctx)) {
        try {
          JSON.stringify(ctx[k], replacerWithCircular());
          safe[k] = ctx[k];
        } catch {
          safe[k] = '[unserialisable]';
        }
      }
      body = JSON.stringify(safe);
    } catch {
      return '';
    }
  }
  if (body.length > CTX_MAX_BYTES) body = body.slice(0, CTX_MAX_BYTES) + '…';
  return ' ' + body;
}

function replacerWithCircular(): (k: string, v: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_k, v) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
      // `Node` is a DOM global, undefined in the main process. Guard the
      // instanceof check so it doesn't ReferenceError on every plain object.
      // (The renderer-side logger has the same guard.)
      const hasNodeType = (v as { nodeType?: unknown }).nodeType;
      if (typeof hasNodeType === 'number') {
        return '[node]';
      }
    }
    if (typeof v === 'function') return '[function]';
    return v;
  };
}

function stackFrom(err: unknown): string | null {
  if (err === undefined) return null;
  if (err instanceof Error && typeof err.stack === 'string') return clipStack(err.stack);
  if (err && typeof err === 'object' && typeof (err as { stack?: unknown }).stack === 'string') {
    return clipStack((err as { stack: string }).stack);
  }
  if (err === null) return 'null';
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function clipStack(stack: string): string {
  const lines = stack.split('\n');
  if (lines.length <= STACK_MAX_LINES) return stack;
  return lines.slice(0, STACK_MAX_LINES).join('\n') + '\n…';
}

const VALID_LEVELS: ReadonlySet<string> = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);

const CATEGORY_MAX_LEN = 256;
const MSG_MAX_LEN = 4096;
const CTX_MAX_BYTES_INPUT = 16 * 1024;

export function isValidPayload(value: unknown): value is LogFromRendererPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!VALID_LEVELS.has(v.level as string)) return false;
  if (!VALID_LEVELS.has(v.level_min as string)) return false;
  if (typeof v.category !== 'string' || v.category.length > CATEGORY_MAX_LEN) return false;
  if (typeof v.msg !== 'string' || v.msg.length > MSG_MAX_LEN) return false;
  if (typeof v.ts !== 'number') return false;
  if (v.ctx !== undefined) {
    if (typeof v.ctx !== 'object' || v.ctx === null || Array.isArray(v.ctx)) return false;
    // Bound input ctx size so a renderer cannot OOM main with a huge
    // object. Use a circular-safe stringify so a circular reference
    // doesn't bypass the bound by throwing.
    let size = 0;
    try {
      size = JSON.stringify(v.ctx, ctxSizeReplacer()).length;
    } catch {
      // Stringify still failed — reject rather than silently accept.
      return false;
    }
    if (size > CTX_MAX_BYTES_INPUT) return false;
  }
  return true;
}

function ctxSizeReplacer(): (k: string, v: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_k, v) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
    }
    if (typeof v === 'function') return '[function]';
    return v;
  };
}

function payloadShape(value: unknown): string {
  if (!value || typeof value !== 'object') return typeof value;
  const v = value as Record<string, unknown>;
  return [
    `level=${typeof v.level}`,
    `category=${typeof v.category}`,
    `msg=${typeof v.msg}`,
    `ctx=${v.ctx === undefined ? 'undefined' : typeof v.ctx}`,
    `level_min=${typeof v.level_min}`,
    `ts=${typeof v.ts}`,
  ].join(',');
}

/**
 * Wire the LogFromRenderer IPC handler. Call once at app startup.
 */
export function registerLogHandler(ipc: IpcMain): void {
  ipc.handle(IPC.LogFromRenderer, (_e, raw) => {
    if (!isValidPayload(raw)) {
      const shape = payloadShape(raw);
      if (!RENDERER_MALFORMED_SHAPES.has(shape)) {
        RENDERER_MALFORMED_SHAPES.add(shape);
        warn('log.ipc', 'malformed LogFromRenderer payload dropped', { shape });
      }
      return;
    }
    // Reconcile main's level from the renderer's reported minimum so a
    // verbose-toggle change in the renderer converges in one round-trip.
    // We assign rather than only-lower so flipping verbose OFF actually
    // restores main's floor (a previous version only lowered, which left
    // main stuck at debug forever).
    minLevel = raw.level_min;
    // Forward the entry through main's normal pipeline.
    emit(raw.level, `r.${raw.category}`, raw.msg, raw.ctx);
  });
}
