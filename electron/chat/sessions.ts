import { spawn, execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { ClaudeChat } from './claude.js';
import { CodexChat } from '../ipc/codex-chat.js';
import type { AgentChatState } from '../shared/agent-chat-types.js';
import type { AgentChat, ChatStartOptions } from './types.js';

const chats = new Map<
  string,
  {
    provider: ChatStartOptions['provider'];
    chat: AgentChat;
    canvasTools: boolean;
    taskId?: string;
  }
>();
const starts = new Map<string, { cancelled: boolean; promise: Promise<void> }>();
const listListeners = new Set<() => void>();

function notifyListChanged(): void {
  for (const listener of listListeners) {
    try {
      listener();
    } catch (error) {
      console.error('Agent chat list listener failed:', error);
    }
  }
}

/** Use the user's unmodified executable and its own authentication flow. */
async function resolveExecutable(opts: ChatStartOptions): Promise<string> {
  if (opts.command.includes('/')) return resolve(opts.cwd, opts.command);
  try {
    const { stdout } = await promisify(execFile)('which', [opts.command], {
      env: opts.env,
      encoding: 'utf8',
      timeout: 3000,
    });
    const found = stdout.split('\n')[0]?.trim();
    if (found) return found;
  } catch (error) {
    throw new Error(
      `Could not find "${opts.command}" on PATH: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  throw new Error(`Could not find "${opts.command}" on PATH. Use its full path instead.`);
}

export async function startAgentChat(
  opts: ChatStartOptions,
  publish: (state: AgentChatState) => void,
  prepare: () => Promise<{ args: string[]; dispose: () => void } | undefined> = async () =>
    undefined,
): Promise<{ canvasTools: boolean }> {
  const pending = starts.get(opts.agentId);
  if (pending) {
    await pending.promise;
    return startAgentChat(opts, publish, prepare);
  }
  const existing = chats.get(opts.agentId);
  if (existing?.provider === opts.provider && existing.chat.state.status !== 'closed') {
    existing.chat.subscribe(publish);
    return { canvasTools: existing.canvasTools };
  }
  existing?.chat.stop();
  const startup = { cancelled: false, promise: Promise.resolve() };
  starts.set(opts.agentId, startup);
  startup.promise = (async () => {
    let resources: Awaited<ReturnType<typeof prepare>>;
    let chat: AgentChat | undefined;
    let unobserve: (() => void) | undefined;
    const release = () => {
      unobserve?.();
      const owned = resources;
      resources = undefined;
      owned?.dispose();
    };
    const assertStarting = () => {
      if (startup.cancelled) throw new Error('Chat startup was cancelled.');
    };
    try {
      const command = opts.provider === 'claude' ? await resolveExecutable(opts) : opts.command;
      assertStarting();
      resources = await prepare();
      assertStarting();
      let start: () => Promise<void>;
      if (opts.provider === 'claude') {
        const claude = new ClaudeChat(
          undefined,
          { ...opts, command, mcpArgs: resources?.args },
          publish,
        );
        chat = claude;
        start = () => claude.start();
      } else {
        const proc = spawn(command, ['app-server', ...(resources?.args ?? [])], {
          cwd: opts.cwd,
          env: opts.env,
          stdio: 'pipe',
          detached: true,
        });
        const codex = new CodexChat(proc, publish);
        chat = codex;
        start = () => codex.start(opts.cwd, opts.threadId, opts.skipPermissions);
      }
      chats.set(opts.agentId, {
        provider: opts.provider,
        chat,
        canvasTools: !!resources,
        taskId: opts.taskId,
      });
      unobserve = chat.observe((state) => {
        if (state.status !== 'closed') return;
        release();
        notifyListChanged();
      });
      chat.subscribe(publish);
      await start();
      assertStarting();
      notifyListChanged();
    } catch (error) {
      chat?.stop();
      release();
      if (chats.get(opts.agentId)?.chat === chat && chats.delete(opts.agentId)) notifyListChanged();
      throw error;
    } finally {
      starts.delete(opts.agentId);
    }
  })();
  await startup.promise;
  return { canvasTools: chats.get(opts.agentId)?.canvasTools === true };
}

export function getAgentChat(agentId: string): AgentChat {
  const chat = chats.get(agentId)?.chat;
  if (!chat) throw new Error('Open Chat before sending a message.');
  return chat;
}
export function stopAgentChat(agentId: string, immediate = false): void {
  const starting = starts.get(agentId);
  if (starting) starting.cancelled = true;
  try {
    chats.get(agentId)?.chat.stop(immediate);
  } finally {
    // Deregister even when the provider throws. The caller already treats the chat as gone, and
    // a stuck entry would keep answering `runningAgentChatIds` and block the next start.
    if (chats.delete(agentId)) notifyListChanged();
  }
}
/** Called on app shutdown, where a chat's own grace timer would never get to run. */
export function stopAllAgentChats(immediate = false): void {
  for (const starting of starts.values()) starting.cancelled = true;
  for (const id of chats.keys()) {
    // One provider failing to shut down must not strand the remaining chats — nor the PTYs
    // and containers killed after this returns.
    try {
      stopAgentChat(id, immediate);
    } catch (error) {
      console.error('Could not stop agent chat', id, error);
    }
  }
}
export function runningAgentChatIds(): string[] {
  return [...chats].filter(([, entry]) => entry.chat.state.status !== 'closed').map(([id]) => id);
}

/**
 * Chats that belong to a task, for surfaces outside the desktop window. A chat
 * whose process ended on its own stays listed, as `exited`, while the desktop
 * still shows its transcript: stopping, releasing or closing the task removes it.
 */
export function listTaskChats(): {
  agentId: string;
  taskId: string;
  status: 'running' | 'exited';
}[] {
  return [...chats].flatMap(([agentId, { taskId, chat }]) =>
    taskId
      ? [{ agentId, taskId, status: chat.state.status === 'closed' ? 'exited' : 'running' }]
      : [],
  );
}

/** The agent's chat, ended or not, or undefined — unlike getAgentChat, absence is not an error. */
export function findAgentChat(agentId: string): AgentChat | undefined {
  return chats.get(agentId)?.chat;
}

/** Called when a chat starts or ends. Returns the unsubscribe function. */
export function onAgentChatsChanged(listener: () => void): () => void {
  listListeners.add(listener);
  return () => listListeners.delete(listener);
}

/** Stop the chat's own process before the native CLI can resume its conversation. */
export async function releaseChat(agentId: string) {
  if (starts.has(agentId))
    throw new Error('Wait for chat startup to finish before switching views.');
  const entry = chats.get(agentId);
  if (!entry) return {};
  try {
    return await entry.chat.release();
  } finally {
    // A timed-out release has already stopped the app-server. Only a refusal to
    // release at all (a running turn, a pending request) leaves a usable chat.
    if (chats.get(agentId) === entry && entry.chat.state.status === 'closed') {
      chats.delete(agentId);
      notifyListChanged();
    }
  }
}
