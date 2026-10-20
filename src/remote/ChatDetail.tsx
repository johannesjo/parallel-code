import { Show, createSignal, onCleanup } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { AgentChatState } from '../../electron/shared/agent-chat-types';
import type { RemoteChatAction } from '../../electron/remote/protocol';
import { ChatView } from '../components/chat/ChatView';
import { readLocal, writeLocal } from './storage';
import { TaskHeader } from './TaskHeader';
import { agents, canControl, sendChatAction, status, watchChat } from './ws';

// The server caps a socket message at 64 KiB and drops the connection past it;
// leave room for the rest of the envelope.
const MAX_MESSAGE_BYTES = 60_000;
// Unsent composer state (images, queued follow-ups) per chat, kept across visits
// for this page's lifetime. One scope per agent, as the desktop keeps one per task:
// ChatView tells conversations apart by thread id, which a new chat does not have
// yet, so a shared scope would hand one task's queued message to another.
const composerMemories = new Map<string, object>();
function composerMemory(agentId: string): object {
  let scope = composerMemories.get(agentId);
  if (!scope) composerMemories.set(agentId, (scope = {}));
  return scope;
}

/**
 * Links in the transcript: worktree files have nowhere to open on a phone, and a
 * web page must not replace this app, whose route lives in the URL hash.
 */
function handleLink(event: MouseEvent): void {
  const link = event.target instanceof Element ? event.target.closest('a') : null;
  const href = link?.getAttribute('href');
  if (!href || event.defaultPrevented) return;
  // In-page links, worktree file links among them, would change the route.
  if (href.startsWith('#')) {
    event.preventDefault();
    return;
  }
  if (!/^https?:/i.test(href)) return;
  event.preventDefault();
  window.open(href, '_blank', 'noopener,noreferrer');
}

/** A task whose agent runs in the desktop's built-in chat. */
export function ChatDetail(props: {
  agentId: string;
  taskName: string;
  onBack: () => void;
  onNeedsPairing: () => void;
}) {
  // eslint-disable-next-line solid/reactivity -- the screen is keyed on its agent
  const draftKey = `chat:${props.agentId}`;
  // Frames are reconciled by item id, as on the desktop, so only changed messages re-render.
  const [chat, setChat] = createStore<{ state?: AgentChatState }>({});
  const [draft, setDraft] = createSignal(readLocal(draftKey));
  // eslint-disable-next-line solid/reactivity -- the screen is keyed on its agent
  onCleanup(watchChat(props.agentId, (next) => setChat('state', reconcile(next))));
  const agentName = () =>
    agents().find((agent) => agent.agentId === props.agentId)?.agentName || 'the agent';
  const act = (action: RemoteChatAction, params?: Record<string, unknown>) =>
    sendChatAction(props.agentId, action, params);

  return (
    <div class="mobile-screen">
      <TaskHeader
        agentId={props.agentId}
        taskName={props.taskName}
        onBack={props.onBack}
        onNeedsPairing={props.onNeedsPairing}
      />
      {/* The desktop shows these, and its Reconnect, around the chat view rather than in it. */}
      <Show when={chat.state?.status === 'closed'}>
        <div class="mobile-banner info" role="status">
          This chat has stopped. Reconnect it on your computer to continue.
        </div>
      </Show>
      <Show when={chat.state?.error}>
        {(error) => (
          <div class="mobile-banner" role="alert">
            {error()}
          </div>
        )}
      </Show>
      <div class="mobile-chat" onClick={handleLink}>
        <Show
          when={chat.state}
          fallback={
            <p class="mobile-empty" role="status">
              Loading the conversation…
            </p>
          }
        >
          {(current) => (
            <ChatView
              agentName={agentName()}
              state={current()}
              draft={draft()}
              disabled={!canControl() || status() !== 'connected'}
              active
              memoryScope={composerMemory(props.agentId)}
              onSelectModel={(model, reasoningEffort) =>
                act('selectModel', { model, reasoningEffort })
              }
              onReloadModels={() => act('models')}
              onDraft={(text) => {
                setDraft(text);
                writeLocal(draftKey, text);
              }}
              onSend={(text, images) => {
                if (images.length)
                  return Promise.reject(
                    new Error('Images can only be attached on your computer for now.'),
                  );
                if (new TextEncoder().encode(JSON.stringify(text)).length > MAX_MESSAGE_BYTES)
                  return Promise.reject(
                    new Error('This message is too long to send from a phone.'),
                  );
                return act('send', { text });
              }}
              onStop={() => act('interrupt')}
              onRespond={(request, decision, answers) =>
                act('respond', { requestId: request.id, decision, answers })
              }
              onActions={() => {}}
            />
          )}
        </Show>
      </div>
    </div>
  );
}
