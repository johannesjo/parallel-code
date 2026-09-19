import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentChatView } from './AgentChatView';
import type { ChatProps } from './chat/CopilotChat.react';
import { store, setStore } from '../store/core';
import { IPC } from '../../electron/ipc/channels';
import type { AgentChatState } from '../../electron/shared/agent-chat-types';
import type { Task } from '../store/types';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(channel: unknown, args?: unknown) => Promise<unknown>>(async () => undefined),
  sendPrompt: vi.fn(async () => undefined),
  saveState: vi.fn(),
  chatProps: undefined as ChatProps | undefined,
  disposeView: vi.fn(),
  openFileInEditor: vi.fn(async () => {}),
  openCanvasDocument: vi.fn(),
  channel: undefined as
    | { onmessage: ((state: AgentChatState) => void) | null; dispose: () => void }
    | undefined,
}));
vi.mock('../lib/ipc', () => ({
  invoke: mocks.invoke,
  Channel: class {
    id = 'channel-id';
    onmessage = null;
    dispose = vi.fn();
    constructor() {
      mocks.channel = this;
    }
  },
}));
vi.mock('../store/persistence', () => ({ saveState: mocks.saveState }));
vi.mock('../lib/shell', () => ({ openFileInEditor: mocks.openFileInEditor }));
vi.mock('../store/canvas', () => ({ openCanvasDocument: mocks.openCanvasDocument }));
vi.mock('../store/tasks', () => ({
  sendPrompt: mocks.sendPrompt,
  clearPrefillPrompt: (taskId: string) => setStore('tasks', taskId, 'prefillPrompt', undefined),
  setTaskPromptDraft: (taskId: string, value: string) =>
    setStore('tasks', taskId, 'promptDraft', value),
}));
vi.mock('../store/focus', () => ({ registerAction: vi.fn(), unregisterAction: vi.fn() }));
vi.mock('../store/focused-panel', () => ({ registerFocusFn: vi.fn(), unregisterFocusFn: vi.fn() }));
vi.mock('./chat/CopilotChat.react', () => ({
  mountChat: (shadow: ShadowRoot) => ({
    update: (snapshot: ChatProps) => {
      mocks.chatProps = snapshot;
      const element = document.createElement('div');
      element.textContent =
        snapshot.state.items.map((i) => i.text).join(' ') +
        snapshot.state.requests.map((r) => r.text).join(' ');
      const button = document.createElement('button');
      button.textContent = 'Decline';
      button.onclick = () => {
        const request = snapshot.state.requests[0];
        if (request) void snapshot.onRespond(request, 'decline', {});
      };
      element.append(button);
      shadow.replaceChildren(element);
    },
    dispose: mocks.disposeView,
  }),
}));

let dispose: (() => void) | undefined;
let container: HTMLDivElement;
const task = () => store.tasks['task-1'];
const state = (overrides: Partial<AgentChatState> = {}): AgentChatState => ({
  status: 'ready',
  threadId: 'thread-1',
  items: [],
  requests: [],
  ...overrides,
});
/** Waits for the first render and returns what it was given, so a caller that
 *  cleared `chatProps` can still read the result without re-narrowing it. */
async function tick(): Promise<ChatProps> {
  await vi.waitFor(() => expect(mocks.chatProps).toBeDefined());
  return mocks.chatProps as ChatProps;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chatProps = undefined;
  mocks.invoke.mockResolvedValue({ url: 'parallel-chat://test/runtime', token: 'token' });
  setStore('tasks', {
    'task-1': {
      id: 'task-1',
      agentIds: ['agent-1'],
      worktreePath: '/worktree',
      mainAgentView: 'chat',
      codexChatThreadId: 'saved-thread',
      promptDraft: 'Fix tests',
    } as Task,
  });
  setStore('agents', {
    'agent-1': {
      id: 'agent-1',
      taskId: 'task-1',
      def: {
        id: 'codex',
        name: 'Codex',
        command: 'codex',
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: '',
      },
      status: 'running',
      resumed: false,
      generation: 0,
      exitCode: null,
      signal: null,
      lastOutput: [],
      chatState: state(),
    },
  });
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  dispose?.();
  container.remove();
});

// Exact counts are formatted in the host's locale, so the expected text is too.
const n = (value: number) => value.toLocaleString();

describe('Codex chat view', () => {
  it('shows context capacity, remaining tokens, and over-limit usage independently of session totals', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    const meter = () => container.querySelector<HTMLElement>('[role="meter"]');
    expect(meter()).toBeNull();
    expect(container.querySelector('.codex-chat-context')?.textContent).toContain('Context —');
    mocks.channel?.onmessage?.(state({ contextUsage: { usedTokens: 50000, maxTokens: 200000 } }));
    expect(meter()?.textContent).toContain('Context 25% · 150K left');
    expect(meter()?.title).toContain(`${n(50_000)} of ${n(200_000)}`);
    expect(meter()?.getAttribute('aria-valuenow')).toBe('50000');
    mocks.channel?.onmessage?.(state({ contextUsage: { usedTokens: 190000, maxTokens: 200000 } }));
    expect(meter()?.dataset.level).toBe('high');
    mocks.channel?.onmessage?.(state({ contextUsage: { usedTokens: 210000, maxTokens: 200000 } }));
    expect(meter()?.textContent).toContain('Context 105% · 0 left');
    expect(meter()?.dataset.level).toBe('full');
    expect(meter()?.getAttribute('aria-valuenow')).toBe('200000');
    expect(meter()?.getAttribute('aria-valuetext')).toContain(`${n(210_000)} of ${n(200_000)}`);
    mocks.channel?.onmessage?.(state({ contextUsage: { usedTokens: 0, maxTokens: 200000 } }));
    expect(meter()?.textContent).toContain('Context 0% · 200K left');
    mocks.channel?.onmessage?.(state({ threadId: 'new-session' }));
    expect(meter()).toBeNull();
  });

  it('shows compact session tokens with an exact breakdown and clears them for a new session', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    const counter = () => container.querySelector<HTMLElement>('.codex-chat-tokens');
    expect(counter()?.textContent).toContain('— tokens');
    mocks.channel?.onmessage?.(
      state({
        tokenUsage: {
          totalTokens: 12500,
          inputTokens: 12000,
          outputTokens: 500,
          scope: 'conversation',
        },
      }),
    );
    expect(counter()?.textContent).toContain('12.5K tokens');
    expect(counter()?.title).toContain(`${n(12_500)} tokens`);
    expect(counter()?.title).toContain(`${n(12_000)} input`);
    mocks.channel?.onmessage?.(
      state({
        tokenUsage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, scope: 'connection' },
      }),
    );
    expect(counter()?.textContent).toContain('0 tokens');
    expect(counter()?.title).toContain('Since this chat connected');
    mocks.channel?.onmessage?.(state({ threadId: 'new-session' }));
    expect(counter()?.textContent).toContain('— tokens');
  });

  it('opens the actual file for links containing line and column suffixes', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    const chat = await tick();
    chat.onOpenFile?.('/worktree/src/app.ts:12:3');
    chat.onOpenFile?.('src/app.ts:12');
    chat.onOpenFile?.('README.md:12');
    chat.onOpenFile?.('./README.md:12');
    chat.onOpenFile?.('/worktree/docs/design.md:10:2');
    expect(mocks.openFileInEditor.mock.calls).toEqual([
      ['/worktree', 'src/app.ts'],
      ['/worktree', 'src/app.ts'],
    ]);
    expect(mocks.openCanvasDocument.mock.calls).toEqual([
      ['task-1', 'README.md'],
      ['task-1', 'README.md'],
      ['task-1', 'docs/design.md'],
    ]);
  });

  it('blocks New chat and Reconnect throughout initial startup and replacement', async () => {
    let release = () => {};
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('.codex-chat-action')];
    expect(buttons().every((button) => button.disabled)).toBe(true);
    buttons()[0].click();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    release();
    await tick();
    expect(buttons().every((button) => !button.disabled)).toBe(true);
    mocks.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    buttons()[0].click();
    expect(buttons().every((button) => button.disabled)).toBe(true);
    buttons()[0].click();
    expect(buttons()).toHaveLength(1);
    expect(
      mocks.invoke.mock.calls.filter((call) => (call[1] as { action: string }).action === 'stop'),
    ).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(buttons().every((button) => !button.disabled)).toBe(true));
  });

  it('displays the effective permission mode even when the saved preference differs', async () => {
    setStore('agents', 'agent-1', 'def', 'id', 'claude-code');
    setStore('tasks', 'task-1', 'chatPermissionMode', 'plan');
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    mocks.channel?.onmessage?.(state({ permissionMode: 'acceptEdits' }));
    expect(mocks.chatProps?.permissionMode).toBe('acceptEdits');
  });

  it('reattaches to the saved thread and preserves streamed state and new conversation ids', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    expect(mocks.invoke).toHaveBeenCalledWith(
      IPC.AgentChat,
      expect.objectContaining({
        action: 'start',
        threadId: 'saved-thread',
        cwd: '/worktree',
        channelId: 'channel-id',
      }),
    );
    mocks.channel?.onmessage?.(state({ items: [{ id: 'a', kind: 'assistant', text: 'Done' }] }));
    await tick();
    expect(container.querySelector('.codex-chat-island')?.shadowRoot?.textContent).toContain(
      'Done',
    );
    expect(task().codexChatThreadId).toBe('thread-1');
    expect(mocks.saveState).toHaveBeenCalled();
    dispose();
    dispose = undefined;
    expect(mocks.channel?.dispose).toHaveBeenCalled();
    // Hiding the view must not kill a live conversation.
    expect(mocks.invoke).not.toHaveBeenCalledWith(IPC.KillAgent, expect.anything());
  });

  it('uses Claude labels and its own session id without replacing the Codex conversation', async () => {
    setStore('agents', 'agent-1', 'def', 'id', 'claude-code');
    setStore('agents', 'agent-1', 'def', 'command', 'claude');
    setStore('tasks', 'task-1', 'claudeChatSessionId', 'claude-saved');
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    expect(mocks.invoke).toHaveBeenCalledWith(
      IPC.AgentChat,
      expect.objectContaining({ provider: 'claude', threadId: 'claude-saved' }),
    );
    expect(mocks.chatProps?.agentName).toBe('Claude');
    expect(container.querySelector('[aria-label="Claude conversation"]')).not.toBeNull();
    mocks.channel?.onmessage?.(state({ threadId: 'claude-new', items: [] }));
    expect(task().claudeChatSessionId).toBe('claude-saved');
    mocks.channel?.onmessage?.(
      state({ threadId: 'claude-new', items: [{ id: 'u', kind: 'user', text: 'Accepted' }] }),
    );
    expect(task().claudeChatSessionId).toBe('claude-new');
    expect(task().codexChatThreadId).toBe('saved-thread');
  });

  it('starts a fresh conversation and forgets the session it replaced', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    mocks.channel?.onmessage?.(state({ items: [{ id: 'a', kind: 'assistant', text: 'Old' }] }));
    expect(task().codexChatThreadId).toBe('thread-1');
    const newChat = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'New chat',
    );
    // Losing a conversation is asked about first, and a refusal keeps it.
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    newChat?.click();
    expect(mocks.invoke).not.toHaveBeenCalledWith(IPC.AgentChat, {
      action: 'stop',
      agentId: 'agent-1',
    });
    confirm.mockReturnValue(true);
    newChat?.click();
    vi.unstubAllGlobals();
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(IPC.AgentChat, {
        action: 'stop',
        agentId: 'agent-1',
      }),
    );
    expect(task().codexChatThreadId).toBeUndefined();
    expect(store.agents['agent-1'].chatState?.items).toEqual([]);
    // The replaced transcript leaves the screen right away, without a new frame.
    await vi.waitFor(() => expect(mocks.chatProps?.messages).toEqual([]));
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        IPC.AgentChat,
        expect.objectContaining({ action: 'start', threadId: undefined }),
      ),
    );
  });

  it('applies a permission mode to the running Claude session and remembers it', async () => {
    setStore('agents', 'agent-1', 'def', 'id', 'claude-code');
    setStore('agents', 'agent-1', 'def', 'command', 'claude');
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    mocks.channel?.onmessage?.(
      state({
        permissionMode: 'default',
        permissionNote: 'Your settings use bypassPermissions, which…',
      }),
    );
    expect(container.querySelector('.codex-chat-note')?.textContent).toContain('bypassPermissions');
    expect(mocks.chatProps?.permissionMode).toBe('default');
    await mocks.chatProps?.onPermissionMode?.('auto');
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(IPC.AgentChat, {
        action: 'setPermissionMode',
        agentId: 'agent-1',
        permissionMode: 'auto',
      }),
    );
    expect(task().chatPermissionMode).toBe('auto');
  });

  it('offers no permission mode for Codex, which has no such control', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    expect(mocks.chatProps?.onPermissionMode).toBeUndefined();
  });

  it('shows approvals without granting them and sends only the clicked decision', async () => {
    setStore(
      'agents',
      'agent-1',
      'chatState',
      state({ requests: [{ id: 4, since: 1, kind: 'approval', text: 'Run npm test?' }] }),
    );
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    expect(mocks.chatProps?.state.requests[0].text).toBe('Run npm test?');
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      IPC.AgentChat,
      expect.objectContaining({ action: 'respond' }),
    );
    const decline = container
      .querySelector('.codex-chat-island')
      ?.shadowRoot?.querySelector('button');
    decline?.click();
    await tick();
    expect(mocks.invoke).toHaveBeenCalledWith(
      IPC.AgentChat,
      expect.objectContaining({ action: 'respond', requestId: 4, decision: 'decline' }),
    );
  });

  it('lets only a focused panel with a pending request claim the keyboard', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    // Nothing to answer: stay out of the focus business entirely.
    expect(mocks.chatProps?.active).toBe(false);
    const request = { id: 4, since: 1, kind: 'approval' as const, text: 'Run npm test?' };
    mocks.channel?.onmessage?.(state({ requests: [request] }));
    expect(mocks.chatProps?.active).toBe(true);
  });

  it('never lets a background task’s request pull focus out of the active one', async () => {
    const request = { id: 4, since: 1, kind: 'approval' as const, text: 'Run npm test?' };
    setStore('agents', 'agent-1', 'chatState', state({ requests: [request] }));
    dispose = render(
      () => <AgentChatView task={task()} agentId="agent-1" active={false} />,
      container,
    );
    await tick();
    expect(mocks.chatProps?.state.requests).toHaveLength(1);
    expect(mocks.chatProps?.active).toBe(false);
  });

  it('keeps drafts on failure and clears only the accepted unchanged draft', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    const deliver = vi.fn(async () => undefined);
    mocks.sendPrompt.mockRejectedValueOnce(new Error('Disconnected'));
    await expect(mocks.chatProps?.onSend('Fix tests', deliver)).rejects.toThrow('Disconnected');
    expect(task().promptDraft).toBe('Fix tests');
    await mocks.chatProps?.onSend('Fix tests', deliver);
    expect(mocks.sendPrompt).toHaveBeenCalledWith('task-1', 'agent-1', 'Fix tests', {
      sendChat: deliver,
    });
    expect(task().promptDraft).toBe('');
    setStore('tasks', 'task-1', 'promptDraft', 'Newer typing');
    await mocks.chatProps?.onSend('Older message', deliver);
    expect(task().promptDraft).toBe('Newer typing');
  });

  it('routes model choices and catalog refreshes to the same conversation', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    await mocks.chatProps?.onSelectModel('model-b', 'high');
    expect(mocks.invoke).toHaveBeenCalledWith(IPC.AgentChat, {
      action: 'selectModel',
      agentId: 'agent-1',
      model: 'model-b',
      reasoningEffort: 'high',
    });
    await mocks.chatProps?.onReloadModels();
    expect(mocks.invoke).toHaveBeenCalledWith(IPC.AgentChat, {
      action: 'models',
      agentId: 'agent-1',
    });
    mocks.channel?.onmessage?.(state({ model: 'model-b', reasoningEffort: 'high' }));
    expect(mocks.chatProps?.state.model).toBe('model-b');
    expect(mocks.chatProps?.state.reasoningEffort).toBe('high');
  });

  it('renders the newest frame and reopens on the transcript the store kept', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    mocks.channel?.onmessage?.(
      state({ status: 'working', items: [{ id: 'a', kind: 'assistant', text: 'Thin' }] }),
    );
    // The store adopts each frame and writes the next one over its top level.
    // What the renderer was given has to stay put, or it would drift out of
    // step with the `messages` built from it at the same moment.
    const firstFrame = await tick();
    mocks.channel?.onmessage?.(
      state({
        items: [
          { id: 'a', kind: 'assistant', text: 'Thinking' },
          { id: 'b', kind: 'user', text: 'Go on' },
        ],
      }),
    );
    expect(firstFrame.state.status).toBe('working');
    expect(firstFrame.state.items.map((item) => item.text)).toEqual(['Thin']);
    expect(firstFrame.messages.map((message) => message.content)).toEqual(['Thin']);
    // The newest frame is what is on screen.
    expect(mocks.chatProps?.state.items.map((item) => item.text)).toEqual(['Thinking', 'Go on']);
    expect(mocks.chatProps?.messages.map((message) => message.content)).toEqual([
      'Thinking',
      'Go on',
    ]);
    // Toggling the view away and back must not start from an empty transcript.
    dispose();
    mocks.chatProps = undefined;
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    const remounted = await tick();
    expect(remounted.state.items.map((item) => item.text)).toEqual(['Thinking', 'Go on']);
  });

  it('passes model settings to the composer without duplicating them in the header', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    mocks.channel?.onmessage?.(state({ model: 'model-b', reasoningEffort: 'high' }));
    expect(mocks.chatProps?.state.model).toBe('model-b');
    expect(mocks.chatProps?.state.reasoningEffort).toBe('high');
    expect(container.querySelector('.codex-chat-header')?.textContent).not.toContain('model-b');
  });

  it('retains a provider-scoped history and resumes the selected session', async () => {
    setStore('tasks', 'task-1', 'chatSessions', [
      { provider: 'codex', threadId: 'older-thread', title: 'Older conversation', updatedAt: 1 },
    ]);
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    mocks.channel?.onmessage?.(
      state({ items: [{ id: 'u', kind: 'user', text: 'Current conversation' }] }),
    );
    expect(task().chatSessions).toHaveLength(2);
    const history = container.querySelector<HTMLSelectElement>(
      '[aria-label="Conversation history"]',
    );
    if (!history) throw new Error('Missing history');
    history.value = 'older-thread';
    history.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        IPC.AgentChat,
        expect.objectContaining({ action: 'start', threadId: 'older-thread' }),
      ),
    );
    expect(task().chatSessions).toHaveLength(2);
  });

  it('only exposes reconnect when the connection needs attention', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    expect(container.textContent).not.toContain('Reconnect');
    mocks.channel?.onmessage?.(state({ status: 'closed' }));
    expect(container.textContent).toContain('Reconnect');
  });

  it('updates the isolated view with theme changes and interruption', async () => {
    setStore('agents', 'agent-1', 'chatState', state({ status: 'working' }));
    setStore('themePreset', 'obsidian');
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    expect(mocks.chatProps?.dark).toBe(true);
    setStore('themePreset', 'islands-light');
    expect(mocks.chatProps?.dark).toBe(false);
    await mocks.chatProps?.onStop();
    expect(mocks.invoke).toHaveBeenCalledWith(IPC.AgentChat, {
      action: 'interrupt',
      agentId: 'agent-1',
    });
  });
});
