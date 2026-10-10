import type { AgentChatState } from '../shared/agent-chat-types.js';

/**
 * Task attention state, mirrored from the desktop's TaskAttentionState so the
 * mobile overview can show the same richer status ("needs input", "working",
 * etc.) rather than just running/exited. Kept as a string union at this shared
 * boundary; the renderer maps its TaskAttentionState onto these values.
 */
export type RemoteAttentionState =
  | 'idle'
  | 'active'
  | 'shell_busy'
  | 'needs_input'
  | 'error'
  | 'ready'
  | 'review';

/** Agent summary sent in the agents list. */
export interface RemoteAgent {
  agentId: string;
  taskId: string;
  taskName: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  lastLine: string;
  projectName?: string;
  projectColor?: string;
  agentName?: string;
  /** Richer, renderer-derived task status. Defaults to 'idle' when unknown. */
  attention: RemoteAttentionState;
  /** Set for the app's built-in chat, which has no terminal to stream. */
  kind?: 'chat';
  /** True when the task is collapsed / minimized on the desktop. */
  collapsed?: boolean;
}

/** An agent the mobile "New Task" screen can launch, with the models it offers. */
export interface RemoteAgentChoice {
  id: string;
  name: string;
  /** The agent the desktop New Task dialog would preselect. */
  isDefault: boolean;
  /** Model overrides; empty when the agent only runs with its configured model. */
  models: { id: string; label: string }[];
}

/**
 * The desktop's answer to a phone's close request. `closed: false` means
 * nothing was closed because closing would lose work; `warnings` says what.
 */
export type RemoteCloseResult = { closed: true } | { closed: false; warnings: string[] };

/** A task's changes against its base branch, as a unified diff; `truncated` when cut short. */
export interface RemoteTaskDiff {
  diff: string;
  truncated: boolean;
  /** True when the task has no branch of its own, so there is nothing to compare. */
  unsupported?: boolean;
}

/** One readiness row in a phone's merge dialog; mirrors the desktop's panel. */
export interface RemoteReadinessCheck {
  label: string;
  status: 'pass' | 'warning' | 'blocked' | 'checking' | 'neutral';
  detail: string;
}

/**
 * Read-only merge readiness, plus the flags a phone's confirm dialog needs.
 * Built by the desktop's own `buildMergeReadiness`, so both surfaces agree on
 * what blocks a merge. `canMerge` is false only for a blocker, never a warning.
 */
export interface RemoteMergeReadiness {
  readiness: {
    overall: 'ready' | 'attention' | 'blocked' | 'checking';
    checks: RemoteReadinessCheck[];
  };
  canMerge: boolean;
  baseBranch: string;
  branchName: string;
}

/** Metadata attached to a task's remote agent entry. */
export type RemoteTaskContext = Pick<
  RemoteAgent,
  'projectName' | 'projectColor' | 'agentName' | 'lastLine'
> & {
  taskName?: string;
  collapsed?: boolean;
};

/** Conversation actions a paired phone may take on a running chat. */
export const REMOTE_CHAT_ACTIONS = [
  'models',
  'selectModel',
  'send',
  'interrupt',
  'respond',
] as const;
export type RemoteChatAction = (typeof REMOTE_CHAT_ACTIONS)[number];

// --- Server -> Client messages ---

export interface OutputMessage {
  type: 'output';
  agentId: string;
  data: string; // base64
}

export interface StatusMessage {
  type: 'status';
  agentId: string;
  status: 'running' | 'exited';
  exitCode: number | null;
}

export interface AgentsMessage {
  type: 'agents';
  list: RemoteAgent[];
}

export interface ScrollbackMessage {
  type: 'scrollback';
  agentId: string;
  data: string; // base64
  cols: number;
  rows?: number;
}

/** The whole conversation, sent on subscribe and then at most every few hundred ms. */
export interface ChatStateMessage {
  type: 'chat-state';
  agentId: string;
  state: AgentChatState;
}

/** Answers an `input` or `chat-action` that carried a requestId. */
export interface InputResultMessage {
  type: 'input-result';
  requestId: string;
  ok: boolean;
  error?: string;
}

export type ServerMessage =
  | OutputMessage
  | StatusMessage
  | AgentsMessage
  | ScrollbackMessage
  | ChatStateMessage
  | InputResultMessage;

// --- Client -> Server messages ---

export interface InputCommand {
  type: 'input';
  agentId: string;
  data: string;
  requestId?: string;
  /** Submit a composed message after pasting its text. */
  submit?: boolean;
  /**
   * Keystroke to type before the paste, in its own terminal write. Agent TUIs
   * open their shell prompt only for a `!` that arrives alone; inside a paste
   * it stays literal text.
   */
  prefixKey?: string;
}

export interface ResizeCommand {
  type: 'resize';
  agentId: string;
  cols: number;
  rows: number;
}

/**
 * A paired phone's terminal size for an agent it is viewing: the PTY takes it
 * so full-screen TUIs fill the phone. Without cols/rows it hands the size back
 * to the desktop; so does disconnecting.
 */
export interface ViewSizeCommand {
  type: 'view-size';
  agentId: string;
  cols?: number;
  rows?: number;
}

export interface KillCommand {
  type: 'kill';
  agentId: string;
}

export interface SubscribeCommand {
  type: 'subscribe';
  agentId: string;
}

export interface UnsubscribeCommand {
  type: 'unsubscribe';
  agentId: string;
}

export interface ChatSubscribeCommand {
  type: 'chat-subscribe' | 'chat-unsubscribe';
  agentId: string;
}

export interface ChatActionCommand {
  type: 'chat-action';
  agentId: string;
  requestId: string;
  action: RemoteChatAction;
  /** Action arguments, validated by the same code as the desktop's. */
  params: Record<string, unknown>;
}

export interface AuthCommand {
  type: 'auth';
  token: string;
}

export type ClientMessage =
  | AuthCommand
  | InputCommand
  | ResizeCommand
  | ViewSizeCommand
  | KillCommand
  | SubscribeCommand
  | UnsubscribeCommand
  | ChatSubscribeCommand
  | ChatActionCommand;

/** Minimal validation for incoming client messages. */
export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    if (typeof msg.type !== 'string') return null;

    // Auth message doesn't require agentId
    if (msg.type === 'auth') {
      if (typeof msg.token !== 'string' || msg.token.length > 200) return null;
      return { type: 'auth', token: msg.token };
    }

    if (typeof msg.agentId !== 'string' || msg.agentId.length > 100) return null;

    switch (msg.type) {
      case 'input':
        if (typeof msg.data !== 'string') return null;
        if (msg.data.length > 4096) return null;
        if (
          msg.requestId !== undefined &&
          (typeof msg.requestId !== 'string' || !msg.requestId.length || msg.requestId.length > 80)
        )
          return null;
        if (msg.submit !== undefined && typeof msg.submit !== 'boolean') return null;
        if (
          msg.prefixKey !== undefined &&
          (typeof msg.prefixKey !== 'string' || !msg.prefixKey.length || msg.prefixKey.length > 4)
        )
          return null;
        return {
          type: 'input',
          agentId: msg.agentId,
          data: msg.data,
          ...(typeof msg.requestId === 'string' ? { requestId: msg.requestId } : {}),
          ...(typeof msg.submit === 'boolean' ? { submit: msg.submit } : {}),
          ...(typeof msg.prefixKey === 'string' ? { prefixKey: msg.prefixKey } : {}),
        };
      case 'resize':
        if (!isTerminalDimension(msg.cols) || !isTerminalDimension(msg.rows)) return null;
        return {
          type: 'resize',
          agentId: msg.agentId,
          cols: msg.cols,
          rows: msg.rows,
        };
      case 'view-size': {
        if (msg.cols === undefined && msg.rows === undefined)
          return { type: 'view-size', agentId: msg.agentId };
        if (!isTerminalDimension(msg.cols) || !isTerminalDimension(msg.rows)) return null;
        return { type: 'view-size', agentId: msg.agentId, cols: msg.cols, rows: msg.rows };
      }
      case 'kill':
        return { type: 'kill', agentId: msg.agentId };
      case 'subscribe':
        return { type: 'subscribe', agentId: msg.agentId };
      case 'unsubscribe':
        return { type: 'unsubscribe', agentId: msg.agentId };
      case 'chat-subscribe':
      case 'chat-unsubscribe':
        return { type: msg.type, agentId: msg.agentId };
      case 'chat-action':
        return parseChatAction(msg, msg.agentId);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function isTerminalDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 500;
}

function parseChatAction(msg: Record<string, unknown>, agentId: string): ChatActionCommand | null {
  if (typeof msg.requestId !== 'string' || !msg.requestId.length || msg.requestId.length > 80)
    return null;
  if (!REMOTE_CHAT_ACTIONS.includes(msg.action as RemoteChatAction)) return null;
  const params = msg.params ?? {};
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null;
  return {
    type: 'chat-action',
    agentId,
    requestId: msg.requestId,
    action: msg.action as RemoteChatAction,
    params: params as Record<string, unknown>,
  };
}
