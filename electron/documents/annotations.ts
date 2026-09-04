/**
 * Annotations for document workspaces: notes and agent-answered questions
 * anchored to a passage. They sit beside the document and never modify it,
 * which makes them the safe way to interrogate a draft.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { BrowserWindow } from 'electron';
import { IPC } from '../ipc/channels.js';
import { errMessage } from '../log.js';
import { atomicWriteFileSync } from '../mcp/atomic.js';
import { buildPtySpawnEnv, validateCommand } from '../ipc/pty.js';
import { loadEnvFile } from '../ipc/env-file.js';
import { buildHeadlessLaunch, createHeadlessParser } from './agents.js';
import { documentAgentSupport } from './shared.js';
import { validateDocumentPath, validateSha } from './runs.js';
import type {
  DocumentAnchor,
  DocumentAnnotation,
  DocumentAnnotationEvent,
  DocumentAnnotationsFile,
} from './types.js';

export const ANNOTATIONS_REL_PATH = path.posix.join('.parallel', 'annotations.json');
const MAX_TEXT_CHARS = 20_000;
const MAX_ANSWER_CHARS = 50_000;
const MAX_ANNOTATIONS = 2_000;
const ANSWER_TIMEOUT_MS = 10 * 60_000;
const KILL_GRACE_MS = 5_000;

function annotationsPath(projectRoot: string): string {
  return path.join(projectRoot, ANNOTATIONS_REL_PATH);
}

function nowIso(): string {
  return new Date().toISOString();
}

// --- Validation -----------------------------------------------------------

function validateAnnotationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(value))
    throw new Error('annotation id is invalid');
  return value;
}

function text(value: unknown, label: string, max = MAX_TEXT_CHARS): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value.slice(0, max);
}

function validateAnchor(value: unknown): DocumentAnchor {
  if (!value || typeof value !== 'object') throw new Error('anchor must be an object');
  const a = value as Record<string, unknown>;
  const startLine = Number(a.startLine);
  const endLine = Number(a.endLine);
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  )
    throw new Error('anchor lines are invalid');
  const baseSha =
    a.baseSha === null || a.baseSha === undefined ? null : validateSha(a.baseSha, 'anchor.baseSha');
  const heading =
    typeof a.heading === 'string' && a.heading.trim() ? a.heading.slice(0, 300) : undefined;
  return {
    path: validateDocumentPath(a.path),
    baseSha,
    startLine,
    endLine,
    quote: text(a.quote, 'anchor.quote'),
    prefix: text(a.prefix, 'anchor.prefix', 500),
    suffix: text(a.suffix, 'anchor.suffix', 500),
    heading,
  };
}

/** Accepts what the renderer sends for a new or edited annotation. */
export function validateAnnotationInput(value: unknown): DocumentAnnotation {
  if (!value || typeof value !== 'object') throw new Error('annotation must be an object');
  const v = value as Record<string, unknown>;
  const kind = v.kind === 'question' ? 'question' : v.kind === 'note' ? 'note' : null;
  if (!kind) throw new Error('annotation kind is invalid');
  const id = validateAnnotationId(v.id);
  const answer =
    v.answer && typeof v.answer === 'object'
      ? {
          text: text((v.answer as Record<string, unknown>).text, 'answer.text', MAX_ANSWER_CHARS),
          agentId: text((v.answer as Record<string, unknown>).agentId, 'answer.agentId', 64),
          agentName: text((v.answer as Record<string, unknown>).agentName, 'answer.agentName', 64),
          answeredAt: text(
            (v.answer as Record<string, unknown>).answeredAt,
            'answer.answeredAt',
            64,
          ),
        }
      : undefined;
  const status = v.answerStatus;
  const runId =
    typeof v.runId === 'string' && /^[a-z0-9-]{1,64}$/i.test(v.runId) ? v.runId : undefined;
  return {
    id,
    kind,
    anchor: validateAnchor(v.anchor),
    text: text(v.text, 'text'),
    createdAt: typeof v.createdAt === 'string' ? v.createdAt.slice(0, 64) : nowIso(),
    updatedAt: nowIso(),
    resolved: v.resolved === true,
    answer,
    answerStatus:
      status === 'pending' || status === 'answered' || status === 'failed' ? status : undefined,
    answerError: typeof v.answerError === 'string' ? v.answerError.slice(0, 2_000) : undefined,
    runId,
  };
}

// --- File -----------------------------------------------------------------

export function readAnnotations(projectRoot: string): DocumentAnnotation[] {
  try {
    const raw = JSON.parse(fs.readFileSync(annotationsPath(projectRoot), 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object') return [];
    const file = raw as Partial<DocumentAnnotationsFile>;
    if (file.version !== 1 || !Array.isArray(file.annotations)) return [];
    const out: DocumentAnnotation[] = [];
    for (const entry of file.annotations) {
      try {
        const valid = validateAnnotationInput(entry);
        // Keep the stored timestamp; validation stamps "now" for edits only.
        valid.updatedAt =
          typeof (entry as DocumentAnnotation).updatedAt === 'string'
            ? (entry as DocumentAnnotation).updatedAt
            : valid.updatedAt;
        out.push(valid);
      } catch {
        // A malformed entry (hand-edited or from another tool) is skipped, not fatal.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeAnnotations(projectRoot: string, annotations: DocumentAnnotation[]): void {
  const file: DocumentAnnotationsFile = { version: 1, annotations };
  fs.mkdirSync(path.dirname(annotationsPath(projectRoot)), { recursive: true });
  atomicWriteFileSync(annotationsPath(projectRoot), JSON.stringify(file, null, 2) + '\n');
}

const fileLocks = new Map<string, Promise<void>>();

function withFileLock<T>(projectRoot: string, fn: () => T | Promise<T>): Promise<T> {
  const key = path.resolve(projectRoot);
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  fileLocks.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

export function saveAnnotation(projectRoot: string, input: unknown): Promise<DocumentAnnotation> {
  const annotation = validateAnnotationInput(input);
  return withFileLock(projectRoot, () => {
    const all = readAnnotations(projectRoot);
    const idx = all.findIndex((a) => a.id === annotation.id);
    if (idx >= 0) {
      // A pending answer belongs to the running ask, not to the edit.
      const stored = all[idx];
      if (stored.answerStatus === 'pending' && annotation.answerStatus !== 'pending') {
        annotation.answer = stored.answer;
        annotation.answerStatus = stored.answerStatus;
      }
      annotation.createdAt = stored.createdAt;
      all[idx] = annotation;
    } else {
      if (all.length >= MAX_ANNOTATIONS) throw new Error('Too many annotations in this project.');
      all.push(annotation);
    }
    writeAnnotations(projectRoot, all);
    return annotation;
  });
}

export function deleteAnnotation(projectRoot: string, idRaw: unknown): Promise<void> {
  const id = validateAnnotationId(idRaw);
  cancelAsk(id);
  return withFileLock(projectRoot, () => {
    const all = readAnnotations(projectRoot);
    writeAnnotations(
      projectRoot,
      all.filter((a) => a.id !== id),
    );
  });
}

function updateAnnotation(
  projectRoot: string,
  id: string,
  mutate: (a: DocumentAnnotation) => void,
): Promise<DocumentAnnotation | null> {
  return withFileLock(projectRoot, () => {
    const all = readAnnotations(projectRoot);
    const target = all.find((a) => a.id === id);
    if (!target) return null;
    mutate(target);
    target.updatedAt = nowIso();
    writeAnnotations(projectRoot, all);
    return target;
  });
}

// --- Asking an agent ------------------------------------------------------

export interface AskAnnotationArgs {
  projectRoot: string;
  documentPath: unknown;
  annotationId: unknown;
  agentId: unknown;
  agentName: unknown;
  command: unknown;
  envFile?: unknown;
}

interface ActiveAsk {
  proc: ChildProcess;
  timer: ReturnType<typeof setTimeout>;
}

const activeAsks = new Map<string, ActiveAsk>();

/** Builds the read-only question prompt. Exported for tests. */
export function buildAnnotationPrompt(annotation: DocumentAnnotation): string {
  const a = annotation.anchor;
  const where = a.heading
    ? `lines ${a.startLine}-${a.endLine} (under "${a.heading}")`
    : `lines ${a.startLine}-${a.endLine}`;
  const quote = a.quote
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  return [
    'You are answering a question about a document in a Parallel Code document workspace. ' +
      'Read the document (and anything else in the project you need) but do not modify any file.',
    `Document: ${a.path}`,
    `Passage: ${where}\n${quote}`,
    `Question:\n${annotation.text.trim()}`,
    [
      'Rules:',
      '- Answer the question about this passage directly and concisely, in Markdown.',
      '- Quote the document where it supports your answer; say plainly when it does not.',
      '- Do not rewrite the passage unless the question asks for a rewrite, and then show it as a suggestion.',
      '- Do not edit, create or delete files, and do not run commands.',
    ].join('\n'),
  ].join('\n\n');
}

function killAsk(entry: ActiveAsk): void {
  const pid = entry.proc.pid;
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (pid) process.kill(-pid, sig);
      else entry.proc.kill(sig);
    } catch {
      // Already gone.
    }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref?.();
}

export function cancelAsk(annotationId: string): void {
  const entry = activeAsks.get(annotationId);
  if (!entry) return;
  clearTimeout(entry.timer);
  activeAsks.delete(annotationId);
  killAsk(entry);
}

export function stopAllAsks(): void {
  for (const id of [...activeAsks.keys()]) cancelAsk(id);
}

/**
 * Runs a headless, read-only agent in the project checkout and writes its
 * final message into the annotation. Progress is pushed as
 * `IPC.DocumentAnnotationEvent`.
 */
export async function askAnnotation(
  win: BrowserWindow,
  args: AskAnnotationArgs,
): Promise<DocumentAnnotation> {
  const { projectRoot } = args;
  validateDocumentPath(args.documentPath);
  const annotationId = validateAnnotationId(args.annotationId);
  const agentId = text(args.agentId, 'agentId', 64);
  if (!documentAgentSupport(agentId).headless)
    throw new Error(`Agent "${agentId}" has no headless mode for document questions.`);
  const agentName = text(args.agentName, 'agentName', 64);
  const command = text(args.command, 'command', 200);
  if (!command.trim() || /[\s;&|<>$`'"\\]/.test(command)) throw new Error('command is invalid');
  const envFile = args.envFile === undefined ? undefined : text(args.envFile, 'envFile', 1_000);
  validateCommand(command);

  cancelAsk(annotationId);
  const annotation = await updateAnnotation(projectRoot, annotationId, (a) => {
    a.kind = 'question';
    a.answerStatus = 'pending';
    a.answerError = undefined;
  });
  if (!annotation) throw new Error('Annotation not found');

  const launch = buildHeadlessLaunch({
    agentId,
    command,
    prompt: buildAnnotationPrompt(annotation),
    newSessionId: randomUUID(),
    readOnly: true,
  });
  const env = buildPtySpawnEnv({}, envFile?.trim() ? loadEnvFile(envFile) : {});
  const parser = createHeadlessParser(agentId);
  const proc = spawn(launch.command, launch.args, {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  let stderrTail = '';
  proc.stdout?.on('data', (chunk: string) => void parser.feed(chunk));
  proc.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4_000);
  });

  const entry: ActiveAsk = {
    proc,
    timer: setTimeout(() => {
      stderrTail = 'Timed out.';
      killAsk(entry);
    }, ANSWER_TIMEOUT_MS),
  };
  activeAsks.set(annotationId, entry);

  const emit = (a: DocumentAnnotation) => {
    if (!win.isDestroyed()) {
      const event: DocumentAnnotationEvent = { projectRoot, annotation: a };
      win.webContents.send(IPC.DocumentAnnotationEvent, event);
    }
  };
  emit(annotation);

  let settled = false;
  const settle = async (exitCode: number | null, spawnError?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(entry.timer);
    const wasActive = activeAsks.get(annotationId) === entry;
    if (wasActive) activeAsks.delete(annotationId);
    const outcome = parser.finish();
    const failure =
      spawnError?.message ??
      outcome.error ??
      (!outcome.resultText.trim()
        ? stderrTail.trim() || `The agent exited with code ${exitCode ?? 'unknown'} and no answer.`
        : undefined);
    const updated = await updateAnnotation(projectRoot, annotationId, (a) => {
      if (!wasActive) return; // cancelled or superseded: leave whatever the newer ask wrote
      if (failure && !outcome.resultText.trim()) {
        a.answerStatus = 'failed';
        a.answerError = failure.slice(0, 2_000);
      } else {
        a.answerStatus = 'answered';
        a.answerError = failure?.slice(0, 2_000);
        a.answer = {
          text: outcome.resultText.slice(0, MAX_ANSWER_CHARS),
          agentId,
          agentName,
          answeredAt: nowIso(),
        };
      }
    }).catch((err) => {
      console.warn('[annotations] failed to store answer:', errMessage(err));
      return null;
    });
    if (updated && wasActive) emit(updated);
  };
  proc.on('close', (code) => void settle(code));
  proc.on('error', (err) => void settle(1, err));
  return annotation;
}
