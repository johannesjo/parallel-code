import { Show, createEffect, createMemo, on, onCleanup, onMount } from 'solid-js';
import type {
  AgentChatState,
  ChatImage,
  ChatPermissionMode,
} from '../../../electron/shared/agent-chat-types';
import { ChatScroll } from './ChatScroll';
import { Composer, type ChatHistoryEntry } from './Composer';
import { createComposer, type ComposerMemory } from './composer-state';
import { enableCopyOnSelect } from './copy-on-select';
import { FILE_LINK_PREFIX } from './chat-markdown';
import { focusRequestCard, type RespondToRequest } from './RequestCard';
import { Transcript } from './Transcript';
import { TranscriptSearch } from './TranscriptSearch';
import { DiffIcon } from '../icons';
import './chat.css';

export interface ChatActions {
  focus: () => void;
  /** Gives the keyboard to the first pending request; false when there is none, or when
   *  the composer holds unsent text, since Enter there means "send my message". */
  focusRequest: () => boolean;
  send: () => Promise<void>;
}

export interface ChatProps {
  agentName: string;
  state: AgentChatState;
  draft: string;
  disabled: boolean;
  /** This chat's panel is the one the user is working in; only it may claim focus. */
  active: boolean;
  /** Composer memory outlives this view for as long as this object does. */
  memoryScope: object;
  onSelectModel: (model: string, reasoningEffort?: string) => Promise<void>;
  onReloadModels: () => Promise<void>;
  onDraft: (text: string) => void;
  onSend: (text: string, images: ChatImage[]) => Promise<void>;
  /** Runs a `!` draft as a shell command; omitted where the agent cannot record one. */
  onShell?: (command: string) => Promise<void>;
  onStop: () => Promise<void>;
  onRespond: RespondToRequest;
  onActions: (actions: ChatActions) => void;
  onReview?: (path?: string) => void;
  onOpenFile?: (path: string) => void;
  onOpenTour?: () => void;
  onListFiles?: () => Promise<string[]>;
  /** Path to reference for a dropped file — worktree-relative when inside it — or
   *  undefined when it has no path on disk, such as an image dragged from a browser. */
  dropPathFor?: (file: File) => string | undefined;
  permissionMode?: string;
  permissionsDisabled?: boolean;
  onPermissionMode?: (mode: ChatPermissionMode) => Promise<void>;
  /** Drop the search and review buttons; Ctrl/Cmd+F still opens the search. */
  hideToolbar?: boolean;
  /** Offered beside the context meter when the host can start a fresh conversation. */
  onNewChat?: () => void;
  /** Earlier conversations offered in the same menu as New chat. */
  history?: ChatHistoryEntry[];
}

// Task objects are weak keys, so closing a task also releases its unsent image data.
const composerMemories = new WeakMap<object, Map<string, ComposerMemory>>();

function memoryFor(scope: object, key: string) {
  const memories = composerMemories.get(scope) ?? new Map<string, ComposerMemory>();
  composerMemories.set(scope, memories);
  return {
    get saved() {
      return memories.get(key);
    },
    save: (memory: ComposerMemory) => memories.set(key, memory),
  };
}

/** The file an agent-written link names, or undefined for web and in-page links,
 *  which keep their default behaviour. */
function linkedFile(href: string): string | undefined {
  const fileLink = href.startsWith(FILE_LINK_PREFIX);
  if (
    !fileLink &&
    (href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href))
  )
    return undefined;
  const target = fileLink ? decodeURIComponent(href.slice(FILE_LINK_PREFIX.length)) : href;
  return decodeURIComponent(target.split('#')[0]);
}

function Conversation(props: { chat: ChatProps; threadId: string }) {
  // A keyed Show mounts one Conversation per thread, so both props are fixed here.
  // eslint-disable-next-line solid/reactivity -- see above
  const chat = props.chat;
  const composer = createComposer(
    chat,
    // eslint-disable-next-line solid/reactivity -- see above
    memoryFor(chat.memoryScope, `${chat.agentName}:${props.threadId}`),
  );
  let root: HTMLDivElement | undefined;
  let textarea: HTMLTextAreaElement | undefined;
  let toLatest: (() => void) | undefined;
  let hold: (() => void) | undefined;
  let openSearch: (() => void) | undefined;
  const focus = () => textarea?.focus();
  // Whoever sends a message wants to see it land and the answer arrive.
  createEffect(on(composer.pendingMessage, (sent) => sent && toLatest?.()));
  // A message queued mid-turn is a send too; the queue only grows by the user's hand.
  createEffect(
    on(
      () => composer.queue().length,
      (length, previous) => previous !== undefined && length > previous && toLatest?.(),
    ),
  );
  // Reloaded commands are never running, so only one the user starts scrolls the log.
  createEffect(
    on(
      () =>
        chat.state.items.some(
          (item) => item.kind === 'shell' && item.activity?.status === 'running',
        ),
      (running) => running && toLatest?.(),
    ),
  );
  onMount(() =>
    chat.onActions({
      focus,
      // The field hides a shell draft's `!`, so an empty field there is still a draft.
      focusRequest: () =>
        !textarea?.value.trim() &&
        !composer.shellMode() &&
        focusRequestCard(root?.querySelector('.chat-request')),
      send: () => composer.send(),
    }),
  );
  function jump(id: string) {
    const element = Array.from(root?.querySelectorAll<HTMLElement>('[data-chat-id]') ?? []).find(
      (element) => element.dataset.chatId === id,
    );
    if (!element) return;
    // Opening the match grows the log; following would snap back to the bottom.
    hold?.();
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement)
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    element.querySelectorAll('details').forEach((details) => (details.open = true));
    element.scrollIntoView({ block: 'center' });
    element.tabIndex = -1;
    element.focus({ preventScroll: true });
  }
  function findShortcut(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'f') return;
    event.preventDefault();
    openSearch?.();
  }
  const search = (floating: boolean) => (
    <TranscriptSearch
      items={chat.state.items}
      onJump={jump}
      floating={floating}
      onControls={(open) => (openSearch = open)}
      onClose={focus}
    />
  );
  function openLink(event: MouseEvent) {
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    const href = link?.getAttribute('href');
    if (!chat.onOpenFile || !href) return;
    try {
      const file = linkedFile(href);
      if (file === undefined) return;
      event.preventDefault();
      chat.onOpenFile(file);
    } catch (error) {
      event.preventDefault();
      composer.setError(String(error));
    }
  }
  return (
    <div ref={root} class="chat-conversation" onClick={openLink} onKeyDown={findShortcut}>
      <Show when={!chat.hideToolbar} fallback={search(true)}>
        <div class="chat-toolbar">
          {search(false)}
          <Show when={chat.onReview}>
            <button class="btn-with-icon" onClick={() => chat.onReview?.()}>
              <DiffIcon size={12} />
              Review changes ↗
            </button>
          </Show>
        </div>
      </Show>
      <ChatScroll
        onControls={(controls) => {
          toLatest = controls.toLatest;
          hold = controls.hold;
        }}
      >
        <Transcript
          state={chat.state}
          pending={composer.pendingMessage()}
          onReview={chat.onReview}
          onOpenFile={chat.onOpenFile}
          onOpenTour={chat.onOpenTour}
        />
      </ChatScroll>
      <Composer
        composer={composer}
        agentName={chat.agentName}
        state={chat.state}
        draft={chat.draft}
        disabled={chat.disabled}
        active={chat.active}
        onDraft={chat.onDraft}
        onRespond={chat.onRespond}
        onSelectModel={chat.onSelectModel}
        onReloadModels={chat.onReloadModels}
        onListFiles={chat.onListFiles}
        permissionMode={chat.permissionMode}
        permissionsDisabled={chat.permissionsDisabled}
        onPermissionMode={chat.onPermissionMode}
        onNewChat={chat.onNewChat}
        history={chat.history}
        onSearch={chat.hideToolbar ? () => openSearch?.() : undefined}
        textarea={(element) => (textarea = element)}
        focus={focus}
      />
    </div>
  );
}

/**
 * The built-in chat for Codex and Claude. Each conversation gets a fresh
 * composer; switching threads restores what was left unsent in that one.
 */
export function ChatView(props: ChatProps) {
  let root: HTMLDivElement | undefined;
  onMount(() => {
    if (root) onCleanup(enableCopyOnSelect(root));
  });
  // Keyed on the thread alone, so frames within one conversation never remount it.
  const thread = createMemo(() => ({ id: props.state.threadId ?? '' }), undefined, {
    equals: (a, b) => a.id === b.id,
  });
  return (
    <div ref={root} class="chat-ui">
      <Show when={thread()} keyed>
        {(current) => <Conversation chat={props} threadId={current.id} />}
      </Show>
    </div>
  );
}
