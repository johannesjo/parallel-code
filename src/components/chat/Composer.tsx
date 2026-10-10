import { For, Show } from 'solid-js';
import type { AgentChatState, ChatPermissionMode } from '../../../electron/shared/agent-chat-types';
import { ChatContext } from './ChatContext';
import { ContextMeter } from './ContextMeter';
import { MoreMenu, type MoreMenuItem } from './MoreMenu';
import { mod } from '../../lib/platform';
import { createFileMention } from './file-mention';
import type { Composer as ComposerState } from './composer-state';
import { ModelPicker, PermissionPicker } from './ModelPicker';
import { Progress } from './Progress';
import { RequestCard, type RespondToRequest } from './RequestCard';
import { ArrowUpAltIcon, PencilIcon, SendIcon, StopSmallIcon, SyncIcon } from '../icons';

export interface ChatHistoryEntry {
  title: string;
  open: () => void;
}

export interface ComposerProps {
  composer: ComposerState;
  agentName: string;
  state: AgentChatState;
  draft: string;
  disabled: boolean;
  active: boolean;
  onDraft: (text: string) => void;
  onRespond: RespondToRequest;
  onSelectModel: (model: string, reasoningEffort?: string) => Promise<void>;
  onReloadModels: () => Promise<void>;
  onListFiles?: () => Promise<string[]>;
  permissionMode?: string;
  permissionsDisabled?: boolean;
  onPermissionMode?: (mode: ChatPermissionMode) => Promise<void>;
  onNewChat?: () => void;
  /** Earlier conversations the host can reopen, newest first. */
  history?: ChatHistoryEntry[];
  /** Set when search has no button of its own, so the menu offers it. */
  onSearch?: () => void;
  textarea: (element: HTMLTextAreaElement) => void;
  focus: () => void;
}

function Queue(props: ComposerProps) {
  // eslint-disable-next-line solid/reactivity -- one composer per conversation, never replaced
  const c = props.composer;
  const paused = () => c.queuePaused() || !!props.state.error;
  return (
    <div class="chat-queue" aria-label="Queued messages">
      <div>
        {paused() ? 'Queue paused' : 'Sends when the agent finishes'} · {c.queue().length}
      </div>
      <For each={c.queue()}>
        {(entry) => (
          <div>
            <span>{entry.text}</span>
            <button
              class="btn-with-icon"
              disabled={c.sending()}
              onClick={() => {
                if (c.editQueued(entry)) props.focus();
              }}
            >
              <PencilIcon size={12} />
              Edit
            </button>
            <button
              disabled={c.sending()}
              aria-label="Remove queued message"
              onClick={() => c.dequeue(entry.id)}
            >
              ×
            </button>
          </div>
        )}
      </For>
      <Show when={paused()}>
        <button
          class="btn-with-icon"
          disabled={c.sending() || props.disabled || props.state.status !== 'ready'}
          onClick={() => c.retryQueue()}
        >
          <SyncIcon size={12} />
          Retry queued message
        </button>
      </Show>
    </div>
  );
}

/** Everything below the log: progress, queue, pending requests and the message box. */
export function Composer(props: ComposerProps) {
  // eslint-disable-next-line solid/reactivity -- one composer per conversation, never replaced
  const c = props.composer;
  const working = () => props.state.status === 'working';
  // Leaving the conversation mid-turn or mid-start would orphan the turn.
  const switchBlocked = () => props.disabled || working() || props.state.status === 'starting';
  const moreItems = (): MoreMenuItem[] => [
    ...(props.onNewChat
      ? [{ label: 'New chat', disabled: switchBlocked(), run: () => props.onNewChat?.() }]
      : []),
    ...(props.onSearch
      ? [{ label: 'Search conversation', hint: `${mod}+F`, run: () => props.onSearch?.() }]
      : []),
    ...(props.history ?? []).map((entry) => ({
      label: entry.title,
      group: 'Switch conversation',
      disabled: switchBlocked(),
      run: entry.open,
    })),
  ];
  const placeholder = () =>
    `${working() ? 'Add a follow-up' : `Message ${props.agentName}`}… Shift+Enter for a new line${props.onListFiles ? ', @ for files' : ''}`;
  const hasContent = () => !!props.draft.trim() || c.images().length > 0 || c.files().length > 0;
  const busy = () => c.sending() || c.readingImages() || c.stopping();
  let textarea: HTMLTextAreaElement | undefined;
  const mention = createFileMention({
    textarea: () => textarea,
    draft: () => props.draft,
    onDraft: (text) => props.onDraft(text),
    files: () => c.files(),
  });
  return (
    <div class="chat-composer-dock">
      <Progress state={props.state} />
      <Show when={c.queue().length}>
        <Queue {...props} />
      </Show>
      <Show when={props.state.requests.length}>
        <div class="chat-requests" aria-label="Pending requests">
          {/* Keyed by request, so a card keeps its half-typed answers when one ahead resolves. */}
          <For each={props.state.requests}>
            {(request, index) => (
              <RequestCard
                request={request}
                agentName={props.agentName}
                respond={props.onRespond}
                autoFocus={props.active && index() === 0}
                onResolved={props.focus}
              />
            )}
          </For>
        </div>
      </Show>
      <Show when={c.error()}>
        <div role="alert" class="chat-error">
          {c.error()}
        </div>
      </Show>
      <div class="chat-composer">
        <div class="chat-composer-row">
          <textarea
            ref={(element) => {
              textarea = element;
              props.textarea(element);
            }}
            aria-label={`Message ${props.agentName}`}
            placeholder={placeholder()}
            disabled={props.disabled}
            value={props.draft}
            onInput={(event) => {
              props.onDraft(event.currentTarget.value);
              if (props.onListFiles) mention.onInput(event);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                void c.send();
              }
            }}
            onPaste={(event) => {
              const pasted = Array.from(event.clipboardData?.files ?? []);
              if (!pasted.length) return;
              event.preventDefault();
              void c.addImages(pasted);
            }}
            onDragOver={(event) => {
              if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
            }}
            onDrop={(event) => {
              if (!event.dataTransfer?.files.length) return;
              event.preventDefault();
              c.addDropped(Array.from(event.dataTransfer.files));
            }}
          />
        </div>
        <ChatContext
          files={c.files()}
          images={c.images()}
          disabled={props.disabled || busy()}
          open={mention.open()}
          onFiles={c.setFiles}
          onRemoveImage={c.removeImage}
          onClose={mention.close}
          onListFiles={props.onListFiles}
        />
        <Show when={c.readingImages()}>
          <div role="status" class="chat-composer-status">
            Reading images…
          </div>
        </Show>
        <Show when={working() && hasContent()}>
          <button
            class="chat-interrupt btn-with-icon"
            disabled={busy() || props.disabled}
            onClick={() => void c.stop(true)}
          >
            <SendIcon size={12} />
            Interrupt and send now
          </button>
        </Show>
        <div class="chat-composer-settings">
          <ModelPicker
            state={props.state}
            disabled={props.disabled || c.sending()}
            onSelectModel={props.onSelectModel}
            onReloadModels={props.onReloadModels}
          />
          <Show when={props.onPermissionMode}>
            {(onPermissionMode) => (
              <PermissionPicker
                mode={props.permissionMode}
                disabled={
                  !!props.permissionsDisabled || props.disabled || props.state.status !== 'ready'
                }
                onChange={onPermissionMode()}
                onError={c.setError}
              />
            )}
          </Show>
          <span class="chat-session-controls">
            <ContextMeter state={props.state} />
            <Show when={moreItems().length}>
              <MoreMenu items={moreItems()} />
            </Show>
            {/* Keep Stop available when a follow-up is ready to queue. */}
            <Show when={!working() || hasContent()}>
              <button
                class="chat-send"
                disabled={
                  busy() ||
                  props.disabled ||
                  !['ready', 'working'].includes(props.state.status) ||
                  !hasContent()
                }
                aria-label={working() ? 'Queue message' : 'Send message'}
                title={working() ? 'Queue message (Enter)' : 'Send message (Enter)'}
                onClick={() => void c.send()}
              >
                <ArrowUpAltIcon size={16} />
              </button>
            </Show>
            <Show when={working()}>
              <button
                class="chat-stop"
                disabled={c.stopping()}
                aria-label="Stop response"
                title="Stop response"
                onClick={() => void c.stop()}
              >
                <StopSmallIcon size={16} />
              </button>
            </Show>
          </span>
        </div>
      </div>
    </div>
  );
}
