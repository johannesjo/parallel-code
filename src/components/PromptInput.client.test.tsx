import { clearStagedNotification, setStagedNotificationUserEdited } from '../store/tasks';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { createSignal, untrack } from 'solid-js';
import { createStore } from 'solid-js/store';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptInput } from './PromptInput';
import {
  getAgentOutputTail,
  onAgentReady,
  registerAction,
  registerFocusFn,
  sendPrompt,
} from '../store/store';

const { storeMock, setTaskPromptDraft, taskUsesAgentChat } = vi.hoisted(() => ({
  storeMock: {
    tasks: {} as Record<string, unknown>,
    agents: {} as Record<string, unknown>,
    mcpOrchestrationEnabled: true,
  },
  setTaskPromptDraft: vi.fn(),
  taskUsesAgentChat: vi.fn(() => false),
}));

vi.mock('../store/agent-chat', () => ({ taskUsesAgentChat }));

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => undefined), fireAndForget: vi.fn() }));
vi.mock('../lib/log', () => ({ debug: vi.fn(), warn: vi.fn() }));

vi.mock('../store/store', () => ({
  store: storeMock,
  setTaskPromptDraft,
  sendPrompt: vi.fn(async () => undefined),
  setInitialPrompt: vi.fn(),
  clearInitialPrompt: vi.fn(),
  registerFocusFn: vi.fn(),
  unregisterFocusFn: vi.fn(),
  registerAction: vi.fn(),
  unregisterAction: vi.fn(),
  getAgentOutputTail: vi.fn(() => ''),
  stripAnsi: (s: string) => s,
  onAgentReady: vi.fn(),
  offAgentReady: vi.fn(),
  normalizeCurrentFrame: (s: string) => s,
  looksLikeQuestion: () => false,
  isAgentTrustQuestionAutoHandled: () => false,
  isAutoTrustSettling: () => false,
  isAgentAskingQuestion: () => false,
  isAgentIdle: () => true,
  setTaskLastInputAt: vi.fn(),
  isPanelFocused: () => false,
  setTaskControl: vi.fn(),
  markTaskUserActivity: vi.fn(),
  setTaskPromptDraftActive: vi.fn(),
  setTaskTerminalInputPending: vi.fn(),
  showNotification: vi.fn(),
}));

vi.mock('../store/tasks', () => ({
  clearStagedNotification: vi.fn(),
  setStagedNotificationUserEdited: vi.fn(),
  setTaskTerminalInputPendingFromQuestion: vi.fn(),
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  storeMock.tasks = {};
  storeMock.agents = {};
  vi.mocked(getAgentOutputTail).mockReturnValue('');
  storeMock.mcpOrchestrationEnabled = true;
  setTaskPromptDraft.mockClear();
  taskUsesAgentChat.mockReturnValue(false);
  vi.mocked(registerFocusFn).mockClear();
  vi.mocked(registerAction).mockClear();
});

async function waitFor(probe: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Condition never became true');
}

function mount(taskId: string): HTMLTextAreaElement {
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(
    render(() => <PromptInput taskId={taskId} taskName="Task" agentId="agent-1" />, container),
  );
  const el = container.querySelector<HTMLTextAreaElement>('textarea.prompt-textarea');
  if (!el) throw new Error('textarea not rendered');
  return el;
}

describe('PromptInput key ownership', () => {
  const promptKeys = () =>
    [
      ...vi.mocked(registerFocusFn).mock.calls.map(([key]) => key),
      ...vi.mocked(registerAction).mock.calls.map(([key]) => key),
    ].filter((key) => key.startsWith('task-1:'));

  it('claims the prompt keys for the terminal composer', () => {
    storeMock.tasks = { 'task-1': { id: 'task-1', agentIds: ['agent-1'] } };
    mount('task-1');
    expect(promptKeys()).toEqual(['task-1:prompt', 'task-1:send-prompt']);
  });

  it('stands aside in chat mode, where AgentChatView owns the visible composer', () => {
    taskUsesAgentChat.mockReturnValue(true);
    storeMock.tasks = { 'task-1': { id: 'task-1', agentIds: ['agent-1'], mainAgentView: 'chat' } };
    mount('task-1');
    // This element is still built in chat mode, just never shown. Registering would let the
    // hidden textarea swallow Enter and the focus key from the composer the user can see.
    expect(promptKeys()).toEqual([]);
  });
});

describe('PromptInput draft persistence', () => {
  it('shows the draft restored from the store on mount', () => {
    storeMock.tasks = {
      'task-1': { id: 'task-1', agentIds: ['agent-1'], promptDraft: 'half-written thought' },
    };
    expect(mount('task-1').value).toBe('half-written thought');
  });

  it('starts empty when the task has no saved draft', () => {
    storeMock.tasks = { 'task-1': { id: 'task-1', agentIds: ['agent-1'] } };
    expect(mount('task-1').value).toBe('');
  });

  it('writes typed text back to the store so autosave persists it', () => {
    storeMock.tasks = { 'task-1': { id: 'task-1', agentIds: ['agent-1'] } };
    const textarea = mount('task-1');

    textarea.value = 'remember the migration';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    expect(setTaskPromptDraft).toHaveBeenCalledWith('task-1', 'remember the migration');
  });

  it('clears the stored draft once the prompt is sent', async () => {
    storeMock.tasks = { 'task-1': { id: 'task-1', agentIds: ['agent-1'], promptDraft: 'send me' } };
    const textarea = mount('task-1');

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => setTaskPromptDraft.mock.calls.some(([, text]) => text === ''));

    expect(textarea.value).toBe('');
  });

  it('clears the stored draft when the prompt box closes while the prompt is sent', async () => {
    let finishSend = (): void => {};
    vi.mocked(sendPrompt).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishSend = resolve)),
    );
    storeMock.tasks = { 'task-1': { id: 'task-1', agentIds: ['agent-1'], promptDraft: 'send me' } };
    const textarea = mount('task-1');

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitFor(() => vi.mocked(sendPrompt).mock.calls.length > 0);
    disposers.pop()?.();
    finishSend();

    await waitFor(() => setTaskPromptDraft.mock.calls.some(([, text]) => text === ''));
  });
});

describe('PromptInput initial prompt after an app restart', () => {
  function mountWithInitialPrompt(): void {
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => (
          <PromptInput taskId="task-1" taskName="Task" agentId="agent-1" initialPrompt="do it" />
        ),
        container,
      ),
    );
  }

  it('does not resend a prompt the resumed session already received', () => {
    vi.mocked(onAgentReady).mockClear();
    storeMock.agents = { 'agent-1': { resumed: true } };
    storeMock.tasks = {
      'task-1': { id: 'task-1', agentIds: ['agent-1'], promptedAgentIds: ['agent-1'] },
    };
    mountWithInitialPrompt();
    expect(onAgentReady).not.toHaveBeenCalled();
  });

  it('still sends a prompt the resumed session never received', () => {
    vi.mocked(onAgentReady).mockClear();
    storeMock.agents = { 'agent-1': { resumed: true } };
    storeMock.tasks = { 'task-1': { id: 'task-1', agentIds: ['agent-1'] } };
    mountWithInitialPrompt();
    expect(onAgentReady).toHaveBeenCalled();
  });

  // Only a separate chat makes "latest" ambiguous enough to open the picker;
  // a saved id or no chat resumes directly, so the prompt can be sent.
  it.each([
    ['claude', undefined, false, true],
    ['codex', undefined, false, true],
    ['claude', undefined, true, false],
    ['codex', undefined, true, false],
    ['claude', 'fb4f2bc6-62d9-4b29-a795-240caf2fc459', true, true],
    ['codex', 'fb4f2bc6-62d9-4b29-a795-240caf2fc459', true, true],
  ])('%s with session %s and chat %s auto-sends: %s', (command, sessionId, chat, sends) => {
    vi.mocked(onAgentReady).mockClear();
    storeMock.agents = {
      'agent-1': {
        id: 'agent-1',
        resumed: true,
        def: {
          command,
          args: [],
          resume_args: command === 'claude' ? ['--continue'] : ['resume', '--last'],
        },
      },
    };
    storeMock.tasks = {
      'task-1': {
        id: 'task-1',
        agentIds: ['agent-1'],
        agentSessionIds: sessionId ? { 'agent-1': sessionId } : undefined,
        claudeChatSessionId: chat ? 'chat' : undefined,
        codexChatThreadId: chat ? 'chat-thread' : undefined,
      },
    };
    mountWithInitialPrompt();
    if (sends) expect(onAgentReady).toHaveBeenCalled();
    else expect(onAgentReady).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLTextAreaElement>('textarea.prompt-textarea')?.value).toBe(
      'do it',
    );
  });

  it('sends the prompt again when a failed resume falls back to a fresh session', () => {
    vi.mocked(onAgentReady).mockClear();
    const [agents, setAgents] = createStore({ 'agent-1': { resumed: true, generation: 0 } });
    // eslint-disable-next-line solid/reactivity -- the component tracks reads through this store mock
    storeMock.agents = agents;
    storeMock.tasks = {
      'task-1': { id: 'task-1', agentIds: ['agent-1'], promptedAgentIds: ['agent-1'] },
    };
    mountWithInitialPrompt();
    expect(onAgentReady).not.toHaveBeenCalled();

    // What restartAgent(id, false) does after the resume args fail.
    setAgents('agent-1', { resumed: false, generation: 1 });
    expect(onAgentReady).toHaveBeenCalled();
  });

  it('clears the stored draft when the box closes during an automatic send', async () => {
    vi.useFakeTimers();
    try {
      let finishSend = (): void => {};
      vi.mocked(sendPrompt).mockClear();
      vi.mocked(sendPrompt).mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishSend = resolve)),
      );
      vi.mocked(getAgentOutputTail).mockReturnValue('Claude Code\n❯ ');
      storeMock.agents = { 'agent-1': {} };
      storeMock.tasks = { 'task-1': { id: 'task-1', agentIds: ['agent-1'] } };
      mountWithInitialPrompt();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(sendPrompt).toHaveBeenCalledWith('task-1', 'agent-1', 'do it');
      disposers.pop()?.();
      finishSend();
      await vi.advanceTimersByTimeAsync(0);

      expect(setTaskPromptDraft).toHaveBeenLastCalledWith('task-1', '');
    } finally {
      vi.useRealTimers();
    }
  });
});

it('never auto-sends an ordinary parent completion summary or replaces its draft', async () => {
  vi.useFakeTimers();
  vi.mocked(sendPrompt).mockClear();
  storeMock.tasks = {
    'task-ordinary': { id: 'task-ordinary', agentIds: ['agent-1'], promptDraft: 'my draft' },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const cleanup = render(
    () => (
      <PromptInput
        taskId="task-ordinary"
        taskName="Ordinary"
        agentId="agent-1"
        autoSendChildUpdates={false}
        controlledBy="coordinator"
        stagedNotification={{
          batchId: 'batch',
          notificationIds: ['n'],
          text: 'Child finished',
          autoFireAt: 0,
          userEdited: false,
        }}
      />
    ),
    container,
  );
  try {
    await vi.advanceTimersByTimeAsync(65_000);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.value).toBe('my draft');
    expect(container.textContent).not.toContain('Staged for auto-send');
    expect(container.textContent).not.toMatch(/Auto-sending|Queued|Sending when coordinator/);
    expect(container.querySelector('textarea')?.style.padding).toBe('6px 36px 6px 10px');
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it('keeps an ordinary parent review summary when the user sends an unrelated prompt', async () => {
  vi.mocked(invoke).mockClear();
  vi.mocked(clearStagedNotification).mockClear();
  storeMock.tasks = {
    'ordinary-send': { id: 'ordinary-send', agentIds: ['agent-1'], promptDraft: 'My follow-up' },
  };
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(
    render(
      () => (
        <PromptInput
          taskId="ordinary-send"
          taskName="Ordinary"
          agentId="agent-1"
          autoSendChildUpdates={false}
          stagedNotification={{
            batchId: 'result',
            notificationIds: ['child'],
            text: 'Child ready for review',
            autoFireAt: 0,
            userEdited: false,
          }}
        />
      ),
      container,
    ),
  );
  container
    .querySelector('textarea')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitFor(() => container.querySelector('textarea')?.value === '');
  expect(clearStagedNotification).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([channel]) =>
          channel === IPC.MCP_CoordinatorNotificationAck ||
          channel === IPC.MCP_CoordinatorRestageAfterUserSend,
      ),
  ).toBe(false);
});

it('preserves staged coordinator results without auto-sending when global orchestration is off', async () => {
  vi.useFakeTimers();
  vi.mocked(sendPrompt).mockClear();
  vi.mocked(clearStagedNotification).mockClear();
  storeMock.mcpOrchestrationEnabled = false;
  storeMock.tasks = { coordinator: { id: 'coordinator', agentIds: ['agent-1'] } };
  const [control, setControl] = createSignal<'human' | 'coordinator'>('human');
  const container = document.createElement('div');
  document.body.append(container);
  const cleanup = render(
    () => (
      <PromptInput
        taskId="coordinator"
        taskName="Coordinator"
        agentId="agent-1"
        autoSendChildUpdates
        controlledBy={control()}
        stagedNotification={{
          batchId: 'result',
          notificationIds: ['child'],
          text: 'Child ready for review',
          autoFireAt: 0,
          userEdited: false,
        }}
      />
    ),
    container,
  );
  try {
    await vi.advanceTimersByTimeAsync(65_000);
    setControl('coordinator');
    await vi.advanceTimersByTimeAsync(65_000);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(clearStagedNotification).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Ready for review');
    expect(container.textContent).not.toMatch(
      /Staged for auto-send|Auto-sending|Sending when coordinator/,
    );
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it('automatically sends opted-in child updates for an ordinary task', async () => {
  vi.useFakeTimers();
  vi.mocked(sendPrompt).mockClear();
  vi.mocked(clearStagedNotification).mockClear();
  storeMock.tasks = { ordinary: { id: 'ordinary', agentIds: ['agent-1'] } };
  const container = document.createElement('div');
  document.body.append(container);
  const cleanup = render(
    () => (
      <PromptInput
        taskId="ordinary"
        taskName="Ordinary"
        agentId="agent-1"
        autoSendChildUpdates
        stagedNotification={{
          batchId: 'batch',
          notificationIds: ['child'],
          text: 'Child complete',
          autoFireAt: 0,
          userEdited: false,
        }}
      />
    ),
    container,
  );
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendPrompt).toHaveBeenCalledWith('ordinary', 'agent-1', 'Child complete', {
      signal: expect.any(AbortSignal),
    });
    expect(invoke).toHaveBeenCalledWith(IPC.MCP_CoordinatorNotificationAck, {
      coordinatorTaskId: 'ordinary',
      batchId: 'batch',
    });
    expect(clearStagedNotification).toHaveBeenCalledWith('ordinary');
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it('cancels an in-flight automatic delivery when MCP is disabled, even if enabled again', async () => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockClear();
  vi.mocked(sendPrompt).mockClear();
  vi.mocked(clearStagedNotification).mockClear();
  const [enabled, setEnabled] = createSignal(true);
  Object.defineProperty(storeMock, 'mcpOrchestrationEnabled', { configurable: true, get: enabled });
  const [staged, setStaged] = createSignal({
    batchId: 'batch',
    notificationIds: ['child'],
    text: 'Child complete',
    autoFireAt: 0,
    userEdited: false,
  });
  vi.mocked(setStagedNotificationUserEdited).mockImplementationOnce(() =>
    setStaged((batch) => ({ ...batch, userEdited: true })),
  );
  let finish: (() => void) | undefined;
  let deliverySignal: AbortSignal | undefined;
  vi.mocked(sendPrompt).mockImplementationOnce((_taskId, _agentId, _text, options) => {
    deliverySignal = options?.signal;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  storeMock.tasks = { ordinary: { id: 'ordinary', agentIds: ['agent-1'] } };
  const container = document.createElement('div');
  document.body.append(container);
  const cleanup = render(
    () => (
      <PromptInput
        taskId="ordinary"
        taskName="Ordinary"
        agentId="agent-1"
        autoSendChildUpdates
        stagedNotification={staged()}
      />
    ),
    container,
  );
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deliverySignal?.aborted).toBe(false);
    setEnabled(false);
    setEnabled(true);
    expect(deliverySignal?.aborted).toBe(true);
    finish?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(untrack(staged).userEdited).toBe(true);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith(IPC.MCP_CoordinatorNotificationAck, expect.anything());
    expect(clearStagedNotification).not.toHaveBeenCalled();
  } finally {
    cleanup();
    Object.defineProperty(storeMock, 'mcpOrchestrationEnabled', {
      configurable: true,
      writable: true,
      value: true,
    });
    vi.useRealTimers();
  }
});
