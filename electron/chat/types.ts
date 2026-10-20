import type {
  AgentChatState,
  ChatDecision,
  ChatImage,
  ChatPermissionMode,
} from '../shared/agent-chat-types.js';

export interface AgentChat {
  readonly state: AgentChatState;
  subscribe(publish: (state: AgentChatState) => void): void;
  observe(listener: (state: AgentChatState) => void): () => void;
  send(text: string, images?: ChatImage[]): Promise<void>;
  interrupt(): Promise<void>;
  respond(id: string | number, decision: ChatDecision, answers?: Record<string, string>): void;
  loadModels(): Promise<void>;
  selectModel(model: string, reasoningEffort?: string): void | Promise<void>;
  /**
   * Run a `!` command in the worktree and add it and its output to the
   * conversation for the agent to answer. Only agents that can record one offer this.
   */
  runShell?(command: string): Promise<void>;
  /** Only agents whose CLI can change mode mid-session offer this. */
  setPermissionMode?(mode: ChatPermissionMode): Promise<void>;
  /** `immediate` is for app shutdown: no process may outlive Electron waiting on a timer. */
  stop(immediate?: boolean): void;
  /**
   * Stop, and resolve only once the CLI has let go of the conversation, so the
   * terminal can resume the same session without two processes writing it.
   * Rejects while a turn or a request is still open.
   */
  release(): Promise<Pick<AgentChatState, 'threadId' | 'model' | 'reasoningEffort'>>;
}

export interface ChatStartOptions {
  provider: 'codex' | 'claude';
  agentId: string;
  /** The task this chat belongs to; only chats with one are offered to paired phones. */
  taskId?: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  threadId?: string;
  skipPermissions?: boolean;
  /** The mode the user picked for this task, overriding their settings' defaultMode. */
  permissionMode?: ChatPermissionMode;
  /** App-owned, task-scoped MCP configuration generated at session startup. */
  mcpArgs?: string[];
}
