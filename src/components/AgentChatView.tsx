import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from 'solid-js';
import { reconcile, unwrap } from 'solid-js/store';
import { Channel, invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import {
  type AgentChatState,
  type ChatPermissionMode,
} from '../../electron/shared/agent-chat-types';
import { chatMessages, type ChatConnection } from '../../electron/shared/chat-messages';
import { store, setStore } from '../store/core';
import { agentChatProvider } from '../store/agent-chat';
import { saveState } from '../store/persistence';
import { sendPrompt, setTaskPromptDraft, clearPrefillPrompt } from '../store/tasks';
import { registerAction, unregisterAction } from '../store/focus';
import { registerFocusFn, unregisterFocusFn } from '../store/focused-panel';
import type { Task } from '../store/types';
import { isLandedTaskState } from '../store/landing';
import { detectThemeTone } from '../lib/custom-theme';
import { openFileInEditor } from '../lib/shell';
import { openCanvasDocument } from '../store/canvas';
import { isMarkdownPath } from '../lib/canvas-tabs';
import { LOOK_PRESETS } from '../lib/look';
import type { ChatActions, ChatProps, mountChat } from './chat/CopilotChat.react';
import './AgentChatView.css';

/** Detach a frame from the store, which mutates the object it adopted whenever
 *  the next one arrives — including item objects, in place, when their ids
 *  match. A shallow copy is therefore not enough: what the renderer holds has
 *  to stay in step with the `messages` built from it at the same moment.
 *  This runs once per frame, not once per render, which is what matters — the
 *  render effect also reruns on every keystroke. */
function detach(state: AgentChatState): AgentChatState {
  return structuredClone(state);
}

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
  // This view renders from its own mirror of the conversation rather than from
  // the store. The store still gets every frame for the status readers outside
  // this view, and is where a remount picks the conversation back up.
  const [state, setState] = createSignal(
    untrack(() => {
      const stored = store.agents[props.agentId]?.chatState;
      return stored && detach(unwrap(stored));
    }),
  );
  const [error, setError] = createSignal('');
  const [connection, setConnection] = createSignal<ChatConnection>();
  const [view, setView] = createSignal<ReturnType<typeof mountChat>>();
  let host: HTMLDivElement | undefined;
  let actions: ChatActions | undefined;
  let disposed = false;
  const [connecting, setConnecting] = createSignal(false);
  const channel = new Channel<AgentChatState>();
  channel.onmessage = (next) => {
    if (disposed || !store.agents[props.agentId]) return;
    batch(() => {
      setState(detach(next));
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
        `Start a new ${agentName()} chat? You can reopen this conversation from History.`,
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
        batch(() => {
          setState(detach(cleared));
          setStore('agents', props.agentId, 'chatState', reconcile(cleared));
        });
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
      const next = await invoke<ChatConnection>(IPC.AgentChat, {
        action: 'connection',
        agentId: props.agentId,
      });
      if (!disposed) setConnection(next);
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
  > = {
    onListFiles: () =>
      invoke<string[]>(IPC.ListDocumentFiles, { projectRoot: props.task.worktreePath }),
    onOpenFile: (path) => {
      // The shell opens files, so remove agent citation locations before routing.
      const relative = relativePath(path.replace(/:\d+(?::\d+)?$/, '')).replace(/^\.\//, '');
      if (
        isMarkdownPath(relative) &&
        !relative.startsWith('/') &&
        !relative.split('/').includes('..')
      )
        openCanvasDocument(props.task.id, relative);
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
    onSend: async (text, deliver) => {
      await sendPrompt(props.task.id, props.agentId, text, { sendChat: deliver });
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
    props.onReady?.(() => actions?.focus());
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
    void import('./chat/CopilotChat.react')
      .then((module) => {
        if (disposed || !host) return;
        setView(
          module.mountChat(
            host.attachShadow({ mode: 'open' }),
            untrack(() => props.task),
          ),
        );
      })
      .catch((error) => {
        if (!disposed) setError(String(error));
      });
    void connect();
  });
  onCleanup(() => {
    disposed = true;
    channel.dispose();
    view()?.dispose();
  });
  createEffect(() => {
    const prefill = props.task.prefillPrompt;
    if (prefill !== undefined) {
      setTaskPromptDraft(props.task.id, prefill);
      clearPrefillPrompt(props.task.id);
    }
  });
  // Rebuilt only when the conversation itself changes — not when the draft,
  // the theme or the landing state re-runs the render effect below.
  const messages = createMemo(() => {
    const current = state();
    return current ? chatMessages(current) : [];
  });
  createEffect(() => {
    const renderer = view();
    const connected = connection();
    const current = state();
    if (!renderer || !connected || !current) return;
    const custom = store.activeCustomThemeId
      ? store.customThemes[store.activeCustomThemeId]
      : undefined;
    const dark = custom
      ? detectThemeTone(custom.vars) === 'dark'
      : LOOK_PRESETS.find((p) => p.id === store.themePreset)?.tone !== 'light';
    renderer.update({
      ...callbacks,
      onReview: props.onReview ? reviewFile : undefined,
      permissionMode: state()?.permissionMode ?? props.task.chatPermissionMode,
      // The session's own mode, not the task flag: the flag can now change while a
      // chat runs, and the session keeps the permissions it was started with.
      permissionsDisabled: state()?.permissionMode === 'bypassPermissions',
      onPermissionMode: provider() === 'claude' ? selectPermissionMode : undefined,
      agentName: agentName(),
      connection: connected,
      state: current,
      messages: messages(),
      draft: props.task.promptDraft ?? '',
      dark,
      disabled: connecting() || isLandedTaskState(props.task.landingState),
      // Read the focus state only while a request is pending. Every tiled task keeps
      // its chat mounted, so subscribing unconditionally would re-render each one on
      // any focus change elsewhere in the app.
      active: current.requests.length > 0 && props.active,
    });
  });
  const status = () =>
    state()?.status === 'closed'
      ? 'Disconnected'
      : state()?.requests.length
        ? 'Waiting for you'
        : state()?.status === 'working'
          ? 'Working'
          : state()?.status === 'ready'
            ? 'Ready'
            : 'Connecting…';
  const compactTokens = new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const tokenTitle = () => {
    const usage = state()?.tokenUsage;
    if (!usage) return 'Session token usage has not been reported yet.';
    return `${usage.totalTokens.toLocaleString()} tokens · ${usage.inputTokens.toLocaleString()} input (including cache) · ${usage.outputTokens.toLocaleString()} output. ${usage.scope === 'connection' ? 'Since this chat connected; updates after each turn.' : 'Total for this conversation.'}`;
  };
  const contextTitle = () => {
    const usage = state()?.contextUsage;
    if (!usage) return 'Context window usage is not available yet.';
    const remaining = Math.max(0, usage.maxTokens - usage.usedTokens);
    return `${usage.usedTokens.toLocaleString()} of ${usage.maxTokens.toLocaleString()} context tokens used · ${remaining.toLocaleString()} remaining. Latest provider-reported estimate; the window may reflect an automatic compaction limit.`;
  };
  return (
    <div class="codex-chat" role="region" aria-label={`${agentName()} conversation`}>
      <div class="codex-chat-header">
        <strong
          title={
            [props.task.branchName, props.task.worktreePath].filter(Boolean).join(' · ') ||
            undefined
          }
        >
          {agentName()}
        </strong>
        <span class="codex-chat-status" role="status">
          {status()}
        </span>
        <span class="codex-chat-tokens" title={tokenTitle()} aria-label={tokenTitle()}>
          {state()?.tokenUsage ? compactTokens.format(state()?.tokenUsage?.totalTokens ?? 0) : '—'}{' '}
          tokens
        </span>
        <Show
          when={state()?.contextUsage}
          fallback={
            <span class="codex-chat-context" title={contextTitle()}>
              Context —
            </span>
          }
        >
          {(usage) => (
            <span
              class="codex-chat-context"
              role="meter"
              aria-label="Context window usage"
              aria-valuemin={0}
              aria-valuemax={usage().maxTokens}
              aria-valuenow={Math.min(usage().usedTokens, usage().maxTokens)}
              aria-valuetext={contextTitle()}
              title={contextTitle()}
              data-level={
                usage().usedTokens >= usage().maxTokens
                  ? 'full'
                  : usage().usedTokens / usage().maxTokens >= 0.9
                    ? 'high'
                    : 'normal'
              }
            >
              <span class="codex-chat-context-track" aria-hidden="true">
                <span
                  style={{
                    width: `${Math.min(100, (usage().usedTokens / usage().maxTokens) * 100)}%`,
                  }}
                />
              </span>
              Context {Math.round((usage().usedTokens / usage().maxTokens) * 100)}% ·{' '}
              {compactTokens.format(Math.max(0, usage().maxTokens - usage().usedTokens))} left
            </span>
          )}
        </Show>
        <Show when={props.task.chatSessions?.some((session) => session.provider === provider())}>
          <select
            class="codex-chat-action"
            aria-label="Conversation history"
            value={state()?.threadId ?? ''}
            disabled={connecting() || state()?.status === 'working'}
            onChange={(event) => void connect(true, event.currentTarget.value)}
          >
            <option value="" disabled>
              History
            </option>
            <For
              each={[...(props.task.chatSessions ?? [])]
                .filter((session) => session.provider === provider())
                .reverse()}
            >
              {(session) => <option value={session.threadId}>{session.title}</option>}
            </For>
          </select>
        </Show>
        <button
          class="codex-chat-action"
          disabled={connecting() || state()?.status === 'working'}
          onClick={() => void connect(true)}
        >
          New chat
        </button>
        <Show when={error() || state()?.status === 'closed'}>
          <button class="codex-chat-action" disabled={connecting()} onClick={() => void connect()}>
            Reconnect
          </button>
        </Show>
      </div>
      <Show when={store.remoteAccess.enabled}>
        <p class="codex-chat-note">
          Phone access supports Terminal only; this chat is available on desktop.
        </p>
      </Show>
      <Show when={state()?.permissionNote}>
        <p class="codex-chat-note">{state()?.permissionNote}</p>
      </Show>
      <div class="codex-chat-island" ref={host} />
      <Show when={error() || state()?.error}>
        <div role="alert" class="codex-chat-error">
          {error() || state()?.error}
          {/* Reconnect lives in the header now, where it is reachable before an error too. */}
          <Show when={error() || state()?.status === 'closed'}>
            <p>If sign-in is needed, use {agentName()}’s login flow in Terminal, then reconnect.</p>
          </Show>
        </div>
      </Show>
    </div>
  );
}
