import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentChatView } from './AgentChatView';
import type { ChatProps } from './chat/ChatView';
import { store, setStore } from '../store/core';
import { IPC } from '../../electron/ipc/channels';
import type { AgentChatState } from '../../electron/shared/agent-chat-types';
import type { Task } from '../store/types';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(channel: unknown, args?: unknown) => Promise<unknown>>(async () => undefined),
  sendPrompt: vi.fn(async () => undefined),
  saveState: vi.fn(),
  chatProps: undefined as ChatProps | undefined,
  openFileInEditor: vi.fn(async () => {}),
  revealItemInDir: vi.fn(async () => {}),
  openCanvasDocument: vi.fn(),
  setTaskFocusedPanel: vi.fn(),
  registerFocusFn: vi.fn<(key: string, fn: () => void) => void>(),
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
vi.mock('../lib/shell', () => ({
  openFileInEditor: mocks.openFileInEditor,
  revealItemInDir: mocks.revealItemInDir,
}));
vi.mock('../store/canvas', () => ({ openCanvasDocument: mocks.openCanvasDocument }));
vi.mock('../store/tasks', () => ({
  sendPrompt: mocks.sendPrompt,
  clearPrefillPrompt: (taskId: string) => setStore('tasks', taskId, 'prefillPrompt', undefined),
  clearInitialPrompt: (taskId: string) => setStore('tasks', taskId, 'initialPrompt', undefined),
  setTaskPromptDraft: (taskId: string, value: string) =>
    setStore('tasks', taskId, 'promptDraft', value),
}));
vi.mock('../store/focus', () => ({ registerAction: vi.fn(), unregisterAction: vi.fn() }));
vi.mock('../store/focused-panel', () => ({
  registerFocusFn: mocks.registerFocusFn,
  unregisterFocusFn: vi.fn(),
  setTaskFocusedPanel: mocks.setTaskFocusedPanel,
}));
// Stands in for the chat itself: it keeps the live props and shows the transcript
// and a Decline button, which is all these tests look at.
vi.mock('./chat/ChatView', async () => {
  const { createEffect } = await import('solid-js');
  return {
    ChatView: (props: ChatProps) => {
      // eslint-disable-next-line solid/reactivity -- tests read the live props later
      mocks.chatProps = props;
      const element = document.createElement('div');
      element.className = 'mock-chat';
      const text = document.createElement('p');
      const button = document.createElement('button');
      button.textContent = 'Decline';
      button.onclick = () => {
        const request = props.state.requests[0];
        if (request) void props.onRespond(request, 'decline', {});
      };
      createEffect(() => {
        text.textContent =
          props.state.items.map((i) => i.text).join(' ') +
          props.state.requests.map((r) => r.text).join(' ');
      });
      element.append(text, button);
      return element;
    },
  };
});

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
/** Waits for the first render and returns its live props, so a caller that
 *  cleared `chatProps` can still read the result without re-narrowing it. */
async function tick(): Promise<ChatProps> {
  await vi.waitFor(() => expect(mocks.chatProps).toBeDefined());
  return mocks.chatProps as ChatProps;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendPrompt.mockReset();
  mocks.sendPrompt.mockResolvedValue(undefined);
  mocks.chatProps = undefined;
  mocks.invoke.mockResolvedValue(undefined);
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

describe('Codex chat view', () => {
  it('sends a queued first prompt once the chat has started', async () => {
    let finishStart = () => {};
    mocks.invoke.mockImplementation((channel, args) =>
      channel === IPC.AgentChat && (args as { action?: string })?.action === 'start'
        ? new Promise((resolve) => (finishStart = () => resolve(undefined)))
        : Promise.resolve(undefined),
    );
    setStore('tasks', 'task-1', 'initialPrompt', 'Fix the tests');
    setStore('tasks', 'task-1', 'promptDraft', 'Fix the tests');
    mocks.sendPrompt.mockImplementationOnce(async () => {
      setStore('tasks', 'task-1', 'initialPrompt', undefined);
    });

    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        IPC.AgentChat,
        expect.objectContaining({ action: 'start' }),
      ),
    );
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
    finishStart();
    await vi.waitFor(() =>
      expect(mocks.sendPrompt).toHaveBeenCalledExactlyOnceWith(
        'task-1',
        'agent-1',
        'Fix the tests',
      ),
    );
    mocks.channel?.onmessage?.(state());
    mocks.channel?.onmessage?.(state());
    expect(mocks.sendPrompt).toHaveBeenCalledTimes(1);
    expect(task().initialPrompt).toBeUndefined();
    expect(task().promptDraft).toBe('');
  });

  it('keeps a failed first prompt available for a manual retry', async () => {
    setStore('tasks', 'task-1', 'initialPrompt', 'Original request');
    setStore('tasks', 'task-1', 'promptDraft', '');
    mocks.sendPrompt.mockRejectedValueOnce(new Error('Send failed'));

    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await vi.waitFor(() =>
      expect(container.querySelector('.codex-chat-error')?.textContent ?? '').toContain(
        'Send failed',
      ),
    );
    expect(task().initialPrompt).toBe('Original request');
    expect(task().promptDraft).toBe('Original request');
    mocks.channel?.onmessage?.(state());
    expect(mocks.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('leaves a user edited draft alone while the chat starts', async () => {
    setStore('tasks', 'task-1', 'initialPrompt', 'Original request');
    setStore('tasks', 'task-1', 'promptDraft', 'User edited draft');
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await vi.waitFor(() => expect(mocks.chatProps?.disabled).toBe(false));
    expect(mocks.sendPrompt).not.toHaveBeenCalled();
    expect(task().initialPrompt).toBe('Original request');
    expect(task().promptDraft).toBe('User edited draft');
    await mocks.chatProps?.onSend('User edited draft', []);
    expect(task().initialPrompt).toBeUndefined();
  });

  it('offers the published tour only while one is held', async () => {
    const onOpenTour = vi.fn();
    dispose = render(
      () => <AgentChatView task={task()} agentId="agent-1" active onOpenTour={onOpenTour} />,
      container,
    );
    const props = await tick();
    expect(props.onOpenTour).toBeUndefined();
    setStore('tasks', 'task-1', 'agentTour', {
      revision: 1,
      payload: { subject: 'Auth', gist: {}, cards: [] },
    });
    props.onOpenTour?.();
    expect(onOpenTour).toHaveBeenCalledOnce();
  });

  it('opens the actual file for links containing line and column suffixes', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    const chat = await tick();
    chat.onOpenFile?.('/worktree/src/app.ts:12:3');
    chat.onOpenFile?.('src/app.ts:12');
    chat.onOpenFile?.('README.md:12');
    chat.onOpenFile?.('./README.md:12');
    chat.onOpenFile?.('/worktree/docs/design.md:10:2');
    chat.onOpenFile?.('/home/me/Downloads/report.csv:4');
    expect(mocks.revealItemInDir.mock.calls).toEqual([['/home/me/Downloads/report.csv']]);
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

  it('focuses a linked document after the enclosing pane handles the click', async () => {
    setStore('activeTaskId', null);
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    const chat = await tick();
    chat.onOpenFile?.('/worktree/project-plan.md');
    expect(mocks.setTaskFocusedPanel).not.toHaveBeenCalled();
    // The pointer selects this task as the original link click bubbles up.
    setStore('activeTaskId', 'task-1');
    await Promise.resolve();
    expect(mocks.openCanvasDocument).toHaveBeenCalledWith('task-1', 'project-plan.md');
    expect(mocks.setTaskFocusedPanel).toHaveBeenCalledWith('task-1', 'canvas');
  });

  it('does not move focus after leaving the linked document task', async () => {
    setStore('activeTaskId', 'task-1');
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    const chat = await tick();
    chat.onOpenFile?.('project-plan.md');
    setStore('activeTaskId', 'other-task');
    await Promise.resolve();
    expect(mocks.setTaskFocusedPanel).not.toHaveBeenCalled();
  });

  it('references dropped files inside the worktree relatively and others absolutely', async () => {
    const paths = new Map<File, string>();
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { getPathForFile: (file: File) => paths.get(file) ?? '' },
    });
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    const chat = await tick();
    const inside = new File(['x'], 'app.ts');
    const outside = new File(['x'], 'report.pdf');
    paths.set(inside, '/worktree/src/app.ts');
    paths.set(outside, '/home/me/Downloads/report.pdf');
    expect(chat.dropPathFor?.(inside)).toBe('src/app.ts');
    expect(chat.dropPathFor?.(outside)).toBe('/home/me/Downloads/report.pdf');
    expect(chat.dropPathFor?.(new File(['x'], 'from-browser.png'))).toBeUndefined();
  });

  it('ignores New chat while a connection is starting or being replaced', async () => {
    let release = () => {};
    const pending = () =>
      new Promise((resolve) => {
        release = () => resolve(undefined);
      });
    mocks.invoke.mockImplementationOnce(pending);
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    const chat = await tick();
    expect(chat.disabled).toBe(true);
    chat.onNewChat?.();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(mocks.chatProps?.disabled).toBe(false));
    mocks.invoke.mockImplementationOnce(pending);
    chat.onNewChat?.();
    expect(mocks.chatProps?.disabled).toBe(true);
    chat.onNewChat?.();
    expect(
      mocks.invoke.mock.calls.filter((call) => (call[1] as { action: string }).action === 'stop'),
    ).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(mocks.chatProps?.disabled).toBe(false));
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
    expect(container.querySelector('.mock-chat')?.textContent).toContain('Done');
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

  it('remembers a Claude conversation that so far holds only ! commands', async () => {
    setStore('agents', 'agent-1', 'def', 'id', 'claude-code');
    setStore('agents', 'agent-1', 'def', 'command', 'claude');
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    mocks.channel?.onmessage?.(
      state({
        threadId: 'claude-shell',
        items: [
          {
            id: 's',
            kind: 'shell',
            text: 'On branch main',
            activity: {
              type: 'command',
              label: 'git status',
              command: 'git status',
              status: 'completed',
            },
          },
        ],
      }),
    );
    expect(task().claudeChatSessionId).toBe('claude-shell');
    expect(task().chatSessions).toContainEqual(
      expect.objectContaining({ threadId: 'claude-shell', title: '!git status' }),
    );
  });

  it('starts a fresh conversation and forgets the session it replaced', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    mocks.channel?.onmessage?.(state({ items: [{ id: 'a', kind: 'assistant', text: 'Old' }] }));
    expect(task().codexChatThreadId).toBe('thread-1');
    setStore('agents', 'agent-1', 'canvasGuidanceGeneration', 0);
    // Losing a conversation is asked about first, and a refusal keeps it.
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    mocks.chatProps?.onNewChat?.();
    expect(mocks.invoke).not.toHaveBeenCalledWith(IPC.AgentChat, {
      action: 'stop',
      agentId: 'agent-1',
    });
    confirm.mockReturnValue(true);
    mocks.chatProps?.onNewChat?.();
    vi.unstubAllGlobals();
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(IPC.AgentChat, {
        action: 'stop',
        agentId: 'agent-1',
      }),
    );
    expect(task().codexChatThreadId).toBeUndefined();
    expect(store.agents['agent-1'].chatState?.items).toEqual([]);
    // The new conversation never saw the canvas guidance the old one received.
    expect(store.agents['agent-1'].canvasGuidanceGeneration).toBeUndefined();
    // The replaced transcript leaves the screen right away, without a new frame.
    await vi.waitFor(() => expect(mocks.chatProps?.state.items).toEqual([]));
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
    const decline = container.querySelector<HTMLButtonElement>('.mock-chat button');
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
    const images = [{ name: 'shot.png', mediaType: 'image/png' as const, data: 'AAAA' }];
    mocks.sendPrompt.mockRejectedValueOnce(new Error('Disconnected'));
    await expect(mocks.chatProps?.onSend('Fix tests', images)).rejects.toThrow('Disconnected');
    expect(task().promptDraft).toBe('Fix tests');
    await mocks.chatProps?.onSend('Fix tests', images);
    expect(mocks.sendPrompt).toHaveBeenCalledWith('task-1', 'agent-1', 'Fix tests', { images });
    expect(task().promptDraft).toBe('');
    setStore('tasks', 'task-1', 'promptDraft', 'Newer typing');
    await mocks.chatProps?.onSend('Older message', []);
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
    const first = mocks.chatProps?.state.items[0];
    mocks.channel?.onmessage?.(
      state({
        items: [
          { id: 'a', kind: 'assistant', text: 'Thinking' },
          { id: 'b', kind: 'user', text: 'Go on' },
        ],
      }),
    );
    // The newest frame is what is on screen.
    expect(mocks.chatProps?.state.status).toBe('ready');
    expect(mocks.chatProps?.state.items.map((item) => item.text)).toEqual(['Thinking', 'Go on']);
    expect(container.querySelector('.mock-chat')?.textContent).toContain('Thinking Go on');
    // A growing message stays the same item, so its rendering updates in place.
    expect(mocks.chatProps?.state.items[0]).toBe(first);
    // Toggling the view away and back must not start from an empty transcript.
    dispose();
    mocks.chatProps = undefined;
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    const remounted = await tick();
    expect(remounted.state.items.map((item) => item.text)).toEqual(['Thinking', 'Go on']);
  });

  it('passes model settings to the composer', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    mocks.channel?.onmessage?.(state({ model: 'model-b', reasoningEffort: 'high' }));
    expect(mocks.chatProps?.state.model).toBe('model-b');
    expect(mocks.chatProps?.state.reasoningEffort).toBe('high');
  });

  it('retains a provider-scoped history and resumes the selected session', async () => {
    setStore('tasks', 'task-1', 'chatSessions', [
      { provider: 'codex', threadId: 'older-thread', title: 'Older conversation', updatedAt: 1 },
      { provider: 'claude', threadId: 'claude-thread', title: 'Claude conversation', updatedAt: 2 },
    ]);
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    mocks.channel?.onmessage?.(
      state({ items: [{ id: 'u', kind: 'user', text: 'Current conversation' }] }),
    );
    expect(task().chatSessions).toHaveLength(3);
    mocks.channel?.onmessage?.(
      state({ items: [{ id: 'u', kind: 'user', text: 'Current conversation' }] }),
    );
    expect(task().chatSessions).toHaveLength(3);
    // The open conversation and other providers' sessions are not offered.
    const history = mocks.chatProps?.history ?? [];
    expect(history.map((entry) => entry.title)).toEqual(['Older conversation']);
    // Switching loses nothing, so it is not confirmed.
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    history[0].open();
    vi.unstubAllGlobals();
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        IPC.AgentChat,
        expect.objectContaining({ action: 'start', threadId: 'older-thread' }),
      ),
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it('hides the chat toolbar and leaves focus and selections the user made in the chat', async () => {
    let focusPane: (() => void) | undefined;
    dispose = render(
      () => (
        <AgentChatView task={task()} agentId="agent-1" active onReady={(fn) => (focusPane = fn)} />
      ),
      container,
    );
    const chat = await tick();
    expect(chat.hideToolbar).toBe(true);
    const focusComposer = vi.fn();
    chat.onActions({ focus: focusComposer, focusRequest: () => false, send: async () => {} });
    mocks.channel?.onmessage?.(state({ items: [{ id: 'a', kind: 'assistant', text: 'Copy me' }] }));
    // A click anywhere in the pane re-focuses it, which must not move a focused control
    container.querySelector<HTMLButtonElement>('.mock-chat button')?.focus();
    focusPane?.();
    expect(focusComposer).not.toHaveBeenCalled();
    // or drop the text the user is selecting to copy.
    (document.activeElement as HTMLElement | null)?.blur();
    const text = container.querySelector('.mock-chat p');
    if (!text) throw new Error('Missing transcript');
    window.getSelection()?.selectAllChildren(text);
    focusPane?.();
    expect(focusComposer).not.toHaveBeenCalled();
    window.getSelection()?.removeAllRanges();
    focusPane?.();
    expect(focusComposer).toHaveBeenCalledTimes(1);
  });

  it('enters the pane on a pending request, even over a selection', async () => {
    let focusPane: (() => void) | undefined;
    dispose = render(
      () => (
        <AgentChatView task={task()} agentId="agent-1" active onReady={(fn) => (focusPane = fn)} />
      ),
      container,
    );
    const chat = await tick();
    const focusComposer = vi.fn();
    const focusRequest = vi.fn(() => true);
    chat.onActions({ focus: focusComposer, focusRequest, send: async () => {} });
    mocks.channel?.onmessage?.(state({ items: [{ id: 'a', kind: 'assistant', text: 'Copy me' }] }));
    const text = container.querySelector('.mock-chat p');
    if (!text) throw new Error('Missing transcript');
    window.getSelection()?.selectAllChildren(text);
    try {
      focusPane?.();
      expect(focusRequest).toHaveBeenCalledTimes(1);
      expect(focusComposer).not.toHaveBeenCalled();
    } finally {
      window.getSelection()?.removeAllRanges();
    }
  });

  it('lets the hidden prompt panel answer a pending request before the composer', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    const chat = await tick();
    const focusComposer = vi.fn();
    const focusRequest = vi.fn(() => true);
    chat.onActions({ focus: focusComposer, focusRequest, send: async () => {} });
    const focusPrompt = mocks.registerFocusFn.mock.calls.find(
      ([key]) => key === 'task-1:prompt',
    )?.[1];
    // Alt+Down reaches the prompt row, which in chat mode is this pane.
    focusPrompt?.();
    expect(focusRequest).toHaveBeenCalledTimes(1);
    expect(focusComposer).not.toHaveBeenCalled();
    focusRequest.mockReturnValue(false);
    focusPrompt?.();
    expect(focusComposer).toHaveBeenCalledTimes(1);
  });

  it('only exposes reconnect when the connection needs attention', async () => {
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    expect(container.textContent).not.toContain('Reconnect');
    mocks.channel?.onmessage?.(state({ status: 'closed' }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Disconnected.');
    const reconnect = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Reconnect',
    );
    reconnect?.click();
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenLastCalledWith(
        IPC.AgentChat,
        expect.objectContaining({ action: 'start' }),
      ),
    );
    expect(mocks.invoke).not.toHaveBeenCalledWith(IPC.AgentChat, {
      action: 'stop',
      agentId: 'agent-1',
    });
  });

  it('interrupts the running turn', async () => {
    setStore('agents', 'agent-1', 'chatState', state({ status: 'working' }));
    dispose = render(() => <AgentChatView task={task()} agentId="agent-1" active />, container);
    await tick();
    await mocks.chatProps?.onStop();
    expect(mocks.invoke).toHaveBeenCalledWith(IPC.AgentChat, {
      action: 'interrupt',
      agentId: 'agent-1',
    });
  });
});
