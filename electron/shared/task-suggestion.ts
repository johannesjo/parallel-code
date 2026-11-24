/**
 * Separate tasks an agent suggests through the `suggest_task` MCP tool. Nothing
 * starts on its own: the creating task shows a preview card with the title, a
 * short summary and the full prompt, and the user starts, edits or dismisses it.
 * Shared by the MCP server, the remote route and the renderer, which each check
 * requests again.
 */

export const TASK_SUGGESTION_LIMITS = {
  title: 80,
  tldr: 400,
  /** The opening prompt of the new task, in UTF-8 bytes. */
  promptBytes: 32_000,
  reason: 300,
  /** Unanswered suggestions per task; more would bury the terminal. */
  pending: 8,
  /** Answered suggestions kept so a late withdraw call learns what the user did. */
  answered: 20,
  /** A full-length prompt as JSON, with room for escaping. */
  payloadBytes: 128 * 1024,
} as const;

const ID = /^suggestion_[a-z0-9]{8}$/;
/**
 * Control, bidi and zero-width characters, as delegation rejects in peer prompts.
 * The card is the user's only look at the prompt before it runs, so nothing may
 * hide or reorder text in it, or break out of the bracketed paste that sends it.
 */
const UNSAFE_TEXT =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

export interface TaskSuggestionInput {
  title: string;
  tldr: string;
  prompt: string;
}

/**
 * `withdrawn` is the agent taking it back; `dismissed` and `started` are the
 * user's answers, which are final.
 */
export type TaskSuggestionStatus = 'pending' | 'started' | 'dismissed' | 'withdrawn';

export interface TaskSuggestion extends TaskSuggestionInput {
  id: string;
  createdAt: number;
  status: TaskSuggestionStatus;
  /** When it left `pending`. */
  answeredAt?: number;
  /** The task the user started from it. */
  startedTaskId?: string;
}

export type TaskSuggestionRequest =
  | ({ action: 'suggest' } & TaskSuggestionInput)
  | { action: 'withdraw'; suggestionId: string; reason?: string };

export type TaskSuggestionResult =
  | { action: 'suggest'; suggestionId: string; status: 'pending' }
  | {
      action: 'withdraw';
      suggestionId: string;
      withdrawn: boolean;
      status: TaskSuggestionStatus;
      message: string;
    };

export function isTaskSuggestionId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function line(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  if (UNSAFE_TEXT.test(value))
    throw new Error(`${name} must not contain control, bidi or zero-width characters.`);
  const result = value.replace(/\s+/g, ' ').trim();
  if (!result) throw new Error(`${name} must not be empty.`);
  if (result.length > max) throw new Error(`${name} must be at most ${max} characters.`);
  return result;
}

function prompt(value: unknown): string {
  if (typeof value !== 'string') throw new Error('prompt must be a string.');
  if (UNSAFE_TEXT.test(value))
    throw new Error('prompt must not contain control, bidi or zero-width characters.');
  const result = value.trim();
  if (!result) throw new Error('prompt must not be empty.');
  if (new TextEncoder().encode(result).length > TASK_SUGGESTION_LIMITS.promptBytes)
    throw new Error(`prompt must be at most ${TASK_SUGGESTION_LIMITS.promptBytes} bytes.`);
  return result;
}

/** Reads the fields of a new suggestion; throws with a message the agent can act on. */
export function parseTaskSuggestionInput(value: unknown): TaskSuggestionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('A task suggestion must be an object {title, tldr, prompt}.');
  const record = value as Record<string, unknown>;
  return {
    title: line(record.title, 'title', TASK_SUGGESTION_LIMITS.title),
    tldr: line(record.tldr, 'tldr', TASK_SUGGESTION_LIMITS.tldr),
    prompt: prompt(record.prompt),
  };
}

export function parseTaskSuggestionRequest(value: unknown): TaskSuggestionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object.');
  const record = value as Record<string, unknown>;
  if (record.action === 'suggest')
    return { action: 'suggest', ...parseTaskSuggestionInput(record) };
  if (record.action === 'withdraw') {
    if (!isTaskSuggestionId(record.suggestionId))
      throw new Error('suggestionId must be an id returned by suggest_task.');
    const reason =
      record.reason === undefined
        ? undefined
        : line(record.reason, 'reason', TASK_SUGGESTION_LIMITS.reason);
    return {
      action: 'withdraw',
      suggestionId: record.suggestionId,
      ...(reason && { reason }),
    };
  }
  throw new Error("action must be 'suggest' or 'withdraw'.");
}

const STATUSES: readonly TaskSuggestionStatus[] = ['pending', 'started', 'dismissed', 'withdrawn'];

/** Restores persisted suggestions; malformed entries are dropped rather than shown. */
export function restoreTaskSuggestions(value: unknown): TaskSuggestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: TaskSuggestion[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const { id, createdAt, status, answeredAt, startedTaskId } = record;
    if (!isTaskSuggestionId(id) || typeof createdAt !== 'number' || !Number.isFinite(createdAt))
      continue;
    if (!STATUSES.includes(status as TaskSuggestionStatus)) continue;
    try {
      result.push({
        id,
        createdAt,
        status: status as TaskSuggestionStatus,
        // Answered entries keep only their title; see pruneTaskSuggestions.
        ...(status === 'pending'
          ? parseTaskSuggestionInput(record)
          : {
              title: line(record.title, 'title', TASK_SUGGESTION_LIMITS.title),
              tldr: '',
              prompt: '',
            }),
        ...(typeof answeredAt === 'number' && Number.isFinite(answeredAt) && { answeredAt }),
        ...(typeof startedTaskId === 'string' && startedTaskId && { startedTaskId }),
      });
    } catch {
      // Not worth keeping: the agent can suggest it again.
    }
  }
  return result.length ? result : undefined;
}

/**
 * Keeps every pending suggestion and only the newest answered ones. An answered
 * entry only has to tell a late withdraw what the user did and recognise a
 * dismissed repeat, so it drops its summary and prompt instead of saving them.
 */
export function pruneTaskSuggestions(list: readonly TaskSuggestion[]): TaskSuggestion[] {
  const answered = list
    .filter((s) => s.status !== 'pending')
    .sort((a, b) => (b.answeredAt ?? b.createdAt) - (a.answeredAt ?? a.createdAt))
    .slice(0, TASK_SUGGESTION_LIMITS.answered);
  const keep = new Set(answered.map((s) => s.id));
  return list
    .filter((s) => s.status === 'pending' || keep.has(s.id))
    .map((s) => (s.status === 'pending' ? s : { ...s, tldr: '', prompt: '' }));
}

/** A suggestion whose task closed unanswered lives on as a board idea with this text. */
export function taskSuggestionIdeaText(suggestion: TaskSuggestionInput): string {
  return `${suggestion.title}\n\n${suggestion.prompt}`;
}
