import { runChatAction } from '../chat/actions.js';
import type { AgentChat } from '../chat/types.js';
import type { AgentChatState } from '../shared/agent-chat-types.js';
import type { ChatActionCommand, ServerMessage } from './protocol.js';

/** How the remote server reaches the desktop's chats. */
export interface RemoteChatSource {
  list(): { agentId: string; taskId: string; status: 'running' | 'exited' }[];
  find(agentId: string): AgentChat | undefined;
  /** Called when a chat starts or ends; returns the unsubscribe function. */
  onChange(listener: () => void): () => void;
}

// Providers publish every 50 ms while streaming, and each frame is the whole
// conversation; a phone on Wi-Fi needs far fewer.
export const CHAT_FRAME_INTERVAL_MS = 200;

/**
 * The conversation as a phone receives it, without the slash-command list that
 * only the desktop composer completes from.
 * shortcut: images are dropped rather than sent — base64 attachments would ride
 * along in every frame; serve them by URL if phones should show them.
 */
function phoneFrame({ commands: _commands, ...state }: AgentChatState): AgentChatState {
  if (!state.items.some((item) => item.images?.length)) return state;
  return { ...state, items: state.items.map(({ images: _images, ...item }) => item) };
}

/**
 * One socket's chat subscriptions. Frames are throttled per chat; the latest
 * state always goes out, because providers mutate one state object in place.
 * While `isCongested` reports a backed-up socket, frames wait for the next tick:
 * each one is the whole conversation, so skipping the ones in between loses nothing.
 */
export function createChatSubscriptions(
  source: RemoteChatSource,
  sendMessage: (message: ServerMessage) => void,
  isCongested: () => boolean = () => false,
) {
  // The chat each subscription observes; none while the agent has no chat.
  const subscriptions = new Map<string, { chat?: AgentChat; stop: () => void }>();

  function observe(agentId: string, chat: AgentChat | undefined) {
    if (!chat) return { stop: () => {} };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        flush();
      }, CHAT_FRAME_INTERVAL_MS);
    };
    const flush = () => {
      if (isCongested()) schedule();
      else sendMessage({ type: 'chat-state', agentId, state: phoneFrame(chat.state) });
    };
    const stopObserving = chat.observe(schedule);
    flush();
    return {
      chat,
      stop: () => {
        stopObserving();
        clearTimeout(timer);
      },
    };
  }

  /** Reconnecting puts a new chat under the same agent id; follow it, not the ended one. */
  function refresh(agentId: string): void {
    const bound = subscriptions.get(agentId);
    const chat = source.find(agentId);
    if (!bound || bound.chat === chat) return;
    bound.stop();
    subscriptions.set(agentId, observe(agentId, chat));
  }

  function subscribe(agentId: string): void {
    if (subscriptions.has(agentId)) return refresh(agentId);
    const chat = source.find(agentId);
    if (chat) subscriptions.set(agentId, observe(agentId, chat));
  }

  function unsubscribe(agentId: string): void {
    subscriptions.get(agentId)?.stop();
    subscriptions.delete(agentId);
  }

  return {
    subscribe,
    unsubscribe,
    /** Call when the chat list changes. */
    rebind(): void {
      for (const agentId of [...subscriptions.keys()]) refresh(agentId);
    },
    dispose(): void {
      for (const agentId of [...subscriptions.keys()]) unsubscribe(agentId);
    },
  };
}

/** Run a phone's chat action. Rejects with a message fit to show on the phone. */
export async function runRemoteChatAction(
  source: RemoteChatSource,
  command: ChatActionCommand,
): Promise<void> {
  const chat = source.find(command.agentId);
  if (!chat) throw new Error('This chat has closed. Open the task on your computer.');
  await runChatAction(chat, { ...command.params, action: command.action });
}
