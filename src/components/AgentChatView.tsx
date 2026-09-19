import { Show, batch, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { reconcile } from 'solid-js/store';
import { Channel, invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import {
  type AgentChatState,
  type ChatPermissionMode,
} from '../../electron/shared/agent-chat-types';
import { store, setStore } from '../store/core';
import { agentChatProvider } from '../store/agent-chat';
import { saveState } from '../store/persistence';
import {
  sendPrompt,
  setTaskPromptDraft,
  clearPrefillPrompt,
  clearInitialPrompt,
} from '../store/tasks';
import { registerAction, unregisterAction } from '../store/focus';
import { registerFocusFn, unregisterFocusFn } from '../store/focused-panel';
import type { Task } from '../store/types';
import { isLandedTaskState } from '../store/landing';
import { openFileInEditor, revealItemInDir } from '../lib/shell';
import { openCanvasDocument } from '../store/canvas';
import { isMarkdownPath } from '../lib/canvas-tabs';
import { ChatView, type ChatActions, type ChatProps } from './chat/ChatView';
import './AgentChatView.css';

export function AgentChatView(props: {
  task: Task;
  agentId: string;
  /** Every tiled task keeps its chat mounted, so only the focused pane may take focus. */
  active: boolean;
  onReady?: (focus: () => void) => void;
  onReview?: (path?: string) => void;
}) {
  const provider = () => agentChatProvider(props.agentId);
  const agentName = () => (provider() === 'claude' ? 'Claude' : 'Codex');
  const sessionKey = () =>
    provider() === 'claude' ? ('claudeChatSessionId' as const) : ('codexChatThreadId' as const);
  // Each frame is reconciled into the store by item id, so the view keeps its DOM
  // (and every open disclosure) while only the changed items re-render. The store
  // is also where a remount picks the conversation back up.
  const state = () => store.agents[props.agentId]?.chatState;
  const [error, setError] = createSignal('');
  let actions: ChatActions | undefined;
  let root: HTMLDivElement | undefined;
  let disposed = false;
  const [connecting, setConnecting] = createSignal(false);
  const channel = new Channel<AgentChatState>();
  channel.onmessage = (next) => {
    if (disposed || !store.agents[props.agentId]) return;
    batch(() => {
      const firstPrompt = next.items.find((item) => item.kind === 'user');
      if (
        next.threadId &&
        firstPrompt &&
        !props.task.chatSessions?.some(
          (session) => session.threadId === next.threadId && session.provider === provider(),
        )
      ) {
        setStore('tasks', props.task.id, 'chatSessions', [
          ...(props.task.chatSessions ?? []),
          {
            threadId: next.threadId,
            provider: provider() ?? 'codex',
            title: firstPrompt.text.slice(0, 100) || 'Image conversation',
            updatedAt: Date.now(),
          },
        ]);
        void saveState();
      }
      setStore('agents', props.agentId, 'chatState', reconcile(next));
      if (
        next.threadId &&
        next.threadId !== props.task[sessionKey()] &&
        (provider() === 'codex' || next.items.some((item) => item.kind === 'user'))
      ) {
        setStore('tasks', props.task.id, sessionKey(), next.threadId);
        void saveState();
      }
    });
  };
  async function connect(fresh = false, threadId?: string) {
    if (connecting()) return;
    if (
      fresh &&
      state()?.items.length &&
      !threadId &&
      !window.confirm(
        `Start a new ${agentName()} chat? You can reopen this conversation from the ⋯ menu.`,
      )
    )
      return;
    setConnecting(true);
    setError('');
    try {
      if (fresh) {
        await invoke(IPC.AgentChat, { action: 'stop', agentId: props.agentId });
        if (disposed) return;
        setStore('tasks', props.task.id, sessionKey(), threadId);
        const cleared = { status: 'starting', items: [], requests: [] } satisfies AgentChatState;
        setStore('agents', props.agentId, 'chatState', reconcile(cleared));
        // A new chat keeps the agent's generation, so forget the guidance the old one received.
        setStore('agents', props.agentId, 'canvasGuidanceGeneration', undefined);
        void saveState();
      }
      const agent = store.agents[props.agentId];
      if (!agent) return;
      const result = await invoke<{ canvasTools?: boolean } | undefined>(IPC.AgentChat, {
        action: 'start',
        provider: provider(),
        agentId: props.agentId,
        taskId: props.task.id,
        stepsEnabled: props.task.stepsEnabled,
        command: agent.def.command,
        cwd: props.task.worktreePath,
        envFile: store.agentEnvFiles[agent.def.id],
        threadId: props.task[sessionKey()],
        skipPermissions: props.task.skipPermissions,
        permissionMode: props.task.chatPermissionMode,
        channelId: channel.id,
      });
      if (disposed || !store.agents[props.agentId]) return;
      setStore('agents', props.agentId, 'canvasTools', result?.canvasTools === true);
      // Chat tasks have no terminal composer to deliver the queued first prompt.
      // Start the chat before sending so the backend has a session to receive it.
      const initialPrompt = !fresh ? props.task.initialPrompt : undefined;
      const draft = props.task.promptDraft?.trim();
      if (initialPrompt && (!draft || draft === initialPrompt.trim())) {
        try {
          await sendPrompt(props.task.id, props.agentId, initialPrompt);
          if (!disposed && props.task.promptDraft?.trim() === initialPrompt.trim())
            setTaskPromptDraft(props.task.id, '');
        } catch (error) {
          // Keep the queue for a manual reconnect, and surface the text in an
          // empty composer so a failed first send can also be retried by hand.
          if (!disposed && store.tasks[props.task.id] && !props.task.promptDraft?.trim())
            setTaskPromptDraft(props.task.id, initialPrompt);
          throw error;
        }
      }
    } catch (error) {
      if (!disposed) setError(String(error));
    } finally {
      setConnecting(false);
    }
  }
  async function selectPermissionMode(mode: ChatPermissionMode) {
    setError('');
    try {
      await invoke(IPC.AgentChat, {
        action: 'setPermissionMode',
        agentId: props.agentId,
        permissionMode: mode,
      });
      // Remember it for this task, so the next session starts the way it ended.
      setStore('tasks', props.task.id, 'chatPermissionMode', mode);
      void saveState();
    } catch (error) {
      setError(String(error));
      throw error;
    }
  }
  const relativePath = (path: string) =>
    path.startsWith(`${props.task.worktreePath}/`)
      ? path.slice(props.task.worktreePath.length + 1)
      : path;
  function reviewFile(path?: string) {
    props.onReview?.(path ? relativePath(path) : undefined);
  }
  const callbacks: Pick<
    ChatProps,
    | 'onDraft'
    | 'onSend'
    | 'onStop'
    | 'onRespond'
    | 'onActions'
    | 'onSelectModel'
    | 'onReloadModels'
    | 'onOpenFile'
    | 'onListFiles'
    | 'dropPathFor'
  > = {
    onListFiles: () =>
      invoke<string[]>(IPC.ListDocumentFiles, { projectRoot: props.task.worktreePath }),
    dropPathFor: (file) => {
      const path = window.electron.getPathForFile?.(file) ?? '';
      return path ? relativePath(path) : undefined;
    },
    onOpenFile: (path) => {
      // The shell opens files, so remove agent citation locations before routing.
      const relative = relativePath(path.replace(/:\d+(?::\d+)?$/, '')).replace(/^\.\//, '');
      if (
        isMarkdownPath(relative) &&
        !relative.startsWith('/') &&
        !relative.split('/').includes('..')
      )
        openCanvasDocument(props.task.id, relative);
      // Outside the worktree (a dropped download, say) the editor channel refuses the
      // path, and opening it with its default app would run whatever an agent cites.
      else if (relative.startsWith('/'))
        void revealItemInDir(relative).catch((error) => setError(String(error)));
      else
        void openFileInEditor(props.task.worktreePath, relative).catch((error) =>
          setError(String(error)),
        );
    },
    onSelectModel: (model, reasoningEffort) =>
      invoke(IPC.AgentChat, {
        action: 'selectModel',
        agentId: props.agentId,
        model,
        reasoningEffort,
      }),
    onReloadModels: () => invoke(IPC.AgentChat, { action: 'models', agentId: props.agentId }),
    onDraft: (text) => setTaskPromptDraft(props.task.id, text),
    onSend: async (text, images) => {
      await sendPrompt(props.task.id, props.agentId, text, { images });
      if (props.task.initialPrompt) clearInitialPrompt(props.task.id);
      if (props.task.promptDraft?.trim() === text) setTaskPromptDraft(props.task.id, '');
    },
    onStop: () => invoke(IPC.AgentChat, { action: 'interrupt', agentId: props.agentId }),
    onRespond: (request, decision, answers) =>
      invoke(IPC.AgentChat, {
        action: 'respond',
        agentId: props.agentId,
        requestId: request.id,
        decision,
        answers,
      }),
    onActions: (next) => {
      actions = next;
    },
  };
  onMount(() => {
    props.onReady?.(focusUnlessBusy);
    const focusKey = `${props.task.id}:prompt`;
    const actionKey = `${props.task.id}:send-prompt`;
    const focus = () => actions?.focus();
    const send = () => actions?.send();
    registerFocusFn(focusKey, focus);
    registerAction(actionKey, send);
    onCleanup(() => {
      unregisterFocusFn(focusKey, focus);
      unregisterAction(actionKey, send);
    });
    void connect();
  });
  onCleanup(() => {
    disposed = true;
    channel.dispose();
  });
  const history = () =>
    [...(props.task.chatSessions ?? [])]
      .filter(
        (session) => session.provider === provider() && session.threadId !== state()?.threadId,
      )
      .reverse()
      .map((session) => ({
        title: session.title,
        open: () => void connect(true, session.threadId),
      }));
  /** Any click in the pane re-focuses it, which lands on the composer. Leave focus
   *  where the user put it inside the chat (the search, a button) and leave a
   *  text selection alone, since moving focus would drop it before it is copied. */
  function focusUnlessBusy() {
    const focused = document.activeElement;
    const selection = window.getSelection();
    if (focused && focused !== document.body && root?.contains(focused)) return;
    if (selection && !selection.isCollapsed && root?.contains(selection.anchorNode)) return;
    actions?.focus();
  }
  createEffect(() => {
    const prefill = props.task.prefillPrompt;
    if (prefill !== undefined) {
      setTaskPromptDraft(props.task.id, prefill);
      clearPrefillPrompt(props.task.id);
    }
  });
  return (
    <div ref={root} class="codex-chat" role="region" aria-label={`${agentName()} conversation`}>
      <Show when={state()?.permissionNote}>
        <p class="codex-chat-note">{state()?.permissionNote}</p>
      </Show>
      <div class="codex-chat-island">
        <Show when={state()}>
          {(current) => (
            <ChatView
              {...callbacks}
              hideToolbar
              onNewChat={() => void connect(true)}
              history={history()}
              onReview={props.onReview ? reviewFile : undefined}
              permissionMode={current().permissionMode ?? props.task.chatPermissionMode}
              // The session's own mode, not the task flag: the flag can now change while a
              // chat runs, and the session keeps the permissions it was started with.
              permissionsDisabled={state()?.permissionMode === 'bypassPermissions'}
              onPermissionMode={provider() === 'claude' ? selectPermissionMode : undefined}
              agentName={agentName()}
              state={current()}
              memoryScope={props.task}
              draft={props.task.promptDraft ?? ''}
              disabled={connecting() || isLandedTaskState(props.task.landingState)}
              // Only a focused panel with something to answer may take the keyboard;
              // every tiled task keeps its chat mounted.
              active={current().requests.length > 0 && props.active}
            />
          )}
        </Show>
      </div>
      <Show when={error() || state()?.error || state()?.status === 'closed'}>
        <div role="alert" class="codex-chat-error">
          {error() || state()?.error || 'Disconnected.'}
          <Show when={error() || state()?.status === 'closed'}>
            <button disabled={connecting()} onClick={() => void connect()}>
              Reconnect
            </button>
            <p>If sign-in is needed, use {agentName()}’s login flow in Terminal, then reconnect.</p>
          </Show>
        </div>
      </Show>
    </div>
  );
}
