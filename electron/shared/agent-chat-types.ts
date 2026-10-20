export interface ChatItem {
  id: string;
  /** 'shell' is a command the user ran with `!`; it carries a command activity. */
  kind: 'user' | 'assistant' | 'tool' | 'shell';
  text: string;
  images?: ChatImage[];
  activity?: {
    type: 'command' | 'files' | 'tool';
    label: string;
    status: 'running' | 'completed' | 'failed' | 'declined' | 'interrupted';
    exitCode?: number;
    files?: string[];
    /** The command line a command activity ran; `text` then holds only its output. */
    command?: string;
    /** What a files activity changed, one unified diff per file. */
    diffs?: ChatDiff[];
  };
}

export interface ChatDiff {
  path: string;
  /** Unified diff hunks: `@@` headers and lines prefixed with ' ', '-' or '+'. */
  diff: string;
  /** Lines added and removed by the whole change, even when `diff` is cut short. */
  added: number;
  removed: number;
}

export interface ChatQuestion {
  id: string;
  question: string;
  isSecret: boolean;
  multiSelect?: boolean;
  options: { label: string; description: string }[];
}

/** How the user answered a request. 'accept-always' also stops the agent asking again. */
export type ChatDecision = 'accept' | 'accept-always' | 'decline';

export function isChatDecision(value: unknown): value is ChatDecision {
  return value === 'accept' || value === 'accept-always' || value === 'decline';
}

export interface ChatRequest {
  id: string | number;
  since: number;
  kind: 'approval' | 'question';
  /** What the agent wants to do, in the agent's own words. */
  text: string;
  /** Short noun phrase for the action, e.g. "Read file". Heads the card when present. */
  action?: string;
  /** The raw tool name and arguments, shown only when the user opens the details. */
  details?: string;
  questions?: ChatQuestion[];
  /** The agent asked that approval not be one keystroke away; open the card on Decline. */
  defaultToNo?: boolean;
  /** Approving can be remembered, so this ask does not come back. */
  canAlwaysAllow?: boolean;
  /** What remembering would change, including any settings file it would write. */
  alwaysAllowNote?: string;
}

/**
 * Permission modes a chat session can run in. 'bypassPermissions' is missing on
 * purpose: it cannot be switched on mid-session, so it stays the task's own
 * "skip permissions" setting, applied when the session launches.
 */
export const CHAT_PERMISSION_MODES = ['default', 'auto', 'acceptEdits', 'plan'] as const;
export type ChatPermissionMode = (typeof CHAT_PERMISSION_MODES)[number];

export function isChatPermissionMode(value: unknown): value is ChatPermissionMode {
  return CHAT_PERMISSION_MODES.includes(value as ChatPermissionMode);
}

export interface ChatModel {
  model: string;
  displayName: string;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
}

/** A command or skill the agent accepts at the start of a message. */
export interface ChatCommand {
  /** Defaults to `/` for Claude commands; Codex skills use `$`. */
  prefix?: '/' | '$';
  name: string;
  description: string;
  argumentHint: string;
}

export interface AgentChatState {
  model?: string;
  reasoningEffort?: string;
  models?: ChatModel[];
  modelsError?: string;
  /** What the composer offers after a leading `/` or `$`; absent when the agent lists none. */
  commands?: ChatCommand[];
  threadId?: string;
  status: 'starting' | 'ready' | 'working' | 'closed';
  items: ChatItem[];
  requests: ChatRequest[];
  error?: string;
  startedAt?: number;
  interrupted?: boolean;
  /** Latest context estimate, separate from cumulative session token usage. */
  contextUsage?: { usedTokens: number; maxTokens: number };
  tokenUsage?: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    /** Claude's cumulative SDK accounting restarts when the connection resumes. */
    scope: 'conversation' | 'connection';
  };
  plan?: { step: string; status: 'pending' | 'in_progress' | 'completed' }[];
  /** The mode the agent reports it is actually running in, once it says so. */
  permissionMode?: string;
  /** Why the running mode differs from the one the user configured, if it does. */
  permissionNote?: string;
}

export function readContextUsage(
  usedTokens: unknown,
  maxTokens: unknown,
): AgentChatState['contextUsage'] {
  if (
    typeof usedTokens !== 'number' ||
    !Number.isSafeInteger(usedTokens) ||
    usedTokens < 0 ||
    typeof maxTokens !== 'number' ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens <= 0
  )
    return undefined;
  return { usedTokens, maxTokens };
}

/** Images are sent directly to the provider; the app writes no attachment files. */
export interface ChatImage {
  name: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
}

export interface ChatSession {
  threadId: string;
  provider: 'codex' | 'claude';
  title: string;
  updatedAt: number;
}

export function restoreChatSessions(value: unknown): ChatSession[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ChatSession =>
      !!entry &&
      typeof entry === 'object' &&
      typeof entry.threadId === 'string' &&
      entry.threadId.length > 0 &&
      (entry.provider === 'codex' || entry.provider === 'claude') &&
      typeof entry.title === 'string' &&
      typeof entry.updatedAt === 'number' &&
      Number.isFinite(entry.updatedAt),
  );
}

export function validateChatImages(value: unknown): ChatImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new Error('Attach at most four images.');
  let size = 0;
  return value.map((image: unknown) => {
    if (!image || typeof image !== 'object') throw new Error('Invalid image attachment.');
    const entry = image as Record<string, unknown>;
    if (
      typeof entry.name !== 'string' ||
      entry.name.length > 255 ||
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(entry.mediaType)) ||
      typeof entry.data !== 'string' ||
      !entry.data.length ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.data) ||
      entry.data.length % 4 !== 0
    )
      throw new Error('Attach a PNG, JPEG, WebP, or GIF image.');
    size += entry.data.length;
    if (size > 8 * 1024 * 1024) throw new Error('Images must total less than 6 MB.');
    return {
      name: entry.name,
      mediaType: entry.mediaType as ChatImage['mediaType'],
      data: entry.data,
    };
  });
}
