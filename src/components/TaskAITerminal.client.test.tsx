import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskAITerminal } from './TaskAITerminal';
import { store, setStore } from '../store/core';
import { clearAgentActivity, markAgentSpawned, markAgentOutput } from '../store/taskStatus';
import { applyAgentHookEvent } from '../store/agentHookStatus';
import { nextTerminalInputPending } from '../lib/terminalInputPending';
import { IPC } from '../../electron/ipc/channels';
import { closeAgentInTask } from '../store/agents';
import { resumeAgentSession } from '../store/sessions';
import { sendPrompt } from '../store/tasks';
import { triggerAction } from '../store/focus';
import { setTaskFocusedPanel } from '../store/focused-panel';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(channel: unknown, args?: unknown) => Promise<unknown>>(async () => undefined),
  terminalMounts: vi.fn(),
  editAsDocument: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({
  invoke: mocks.invoke,
  fireAndForget: vi.fn(),
  Channel: class {
    id = 'chat-channel';
    onmessage = null;
    dispose() {}
  },
}));
vi.mock('../store/persistence', async (original) => ({
  ...(await original<typeof import('../store/persistence')>()),
  saveState: vi.fn(async () => undefined),
}));
vi.mock('../documents/store', async (original) => ({
  ...(await original<typeof import('../documents/store')>()),
  editAsDocument: mocks.editAsDocument,
}));
vi.mock('./TerminalView', () => ({
  TerminalView: (props: unknown) => {
    mocks.terminalMounts(props);
    return <div data-testid="terminal">Terminal conversation</div>;
  },
}));

let host: HTMLDivElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.invoke.mockImplementation(async (_channel?: unknown, _args?: unknown) => ({
    threadId: 'exact-thread',
  }));
  setStore('tasks', {
    task: {
      id: 'task',
      name: 'Task',
      projectId: 'project',
      branchName: 'task/chat',
      worktreePath: '/worktree',
      agentIds: ['agent'],
      shellAgentIds: [],
      notes: '',
      lastPrompt: '',
      gitIsolation: 'worktree',
    },
  });
  setStore('agents', {
    agent: {
      id: 'agent',
      taskId: 'task',
      def: {
        id: 'codex',
        name: 'Codex',
        command: 'codex',
        args: [],
        resume_args: [],
        skip_permissions_args: [],
        description: '',
      },
      resumed: false,
      status: 'running',
      exitCode: null,
      signal: null,
      lastOutput: [],
      generation: 0,
    },
  });
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  dispose?.();
  host.remove();
  clearAgentActivity('agent');
});

function mount() {
  dispose = render(
    () => (
      <TaskAITerminal
        task={store.tasks.task}
        selectedAgentId="agent"
        isActive
        promptHandle={undefined}
      />
    ),
    host,
  );
}

/** The confirmation that a view switch quits the CLI on the other side. */
function switchConfirm() {
  return document.querySelector<HTMLElement>('[role="dialog"] h2')?.textContent ?? '';
}

function confirmSwitch() {
  document.querySelector<HTMLButtonElement>('[role="dialog"] button.btn-primary')?.click();
}

function cancelSwitch() {
  document.querySelector<HTMLButtonElement>('[role="dialog"] button.btn-secondary')?.click();
}

function clickChat() {
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]');
  expect(button).not.toBeNull();
  button?.click();
  confirmSwitch();
}

function clickTerminal() {
  host.querySelector<HTMLButtonElement>('[aria-label="Show main agent terminal"]')?.click();
  confirmSwitch();
}

it('keeps the remaining agent in its own terminal when the main chat agent is closed', async () => {
  setStore('agents', 'second', { ...store.agents.agent, id: 'second' });
  setStore('tasks', 'task', 'agentIds', ['agent', 'second']);
  setStore('tasks', 'task', 'mainAgentView', 'chat');
  setStore('tasks', 'task', 'codexChatThreadId', 'old-thread');
  setStore('tasks', 'task', 'claudeChatSessionId', 'old-claude');
  setStore('tasks', 'task', 'chatPermissionMode', 'plan');
  mount();
  mocks.invoke.mockClear();
  await closeAgentInTask('task', 'agent');
  expect(store.tasks.task.agentIds).toEqual(['second']);
  expect(store.tasks.task.mainAgentView).toBeUndefined();
  expect(store.tasks.task.codexChatThreadId).toBeUndefined();
  expect(store.tasks.task.claudeChatSessionId).toBeUndefined();
  expect(store.tasks.task.chatPermissionMode).toBeUndefined();
  expect(mocks.invoke).not.toHaveBeenCalledWith(
    IPC.AgentChat,
    expect.objectContaining({ action: 'start', agentId: 'second' }),
  );
});

it('shows both modes and hands off the exact terminal conversation before mounting Chat', async () => {
  mount();
  const chatButton = host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]');
  const terminalButton = host.querySelector<HTMLButtonElement>(
    '[aria-label="Show main agent terminal"]',
  );
  expect(chatButton?.getAttribute('aria-pressed')).toBe('false');
  expect(terminalButton?.getAttribute('aria-pressed')).toBe('true');
  clickChat();
  expect(store.tasks.task.mainAgentView).not.toBe('chat');
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
  expect(mocks.invoke).toHaveBeenCalledWith(IPC.AgentChat, {
    action: 'handoffToChat',
    agentId: 'agent',
  });
  expect(mocks.invoke).toHaveBeenCalledWith(
    IPC.AgentChat,
    expect.objectContaining({ action: 'start', threadId: 'exact-thread' }),
  );
  expect(chatButton?.getAttribute('aria-pressed')).toBe('true');
  expect(terminalButton?.getAttribute('aria-pressed')).toBe('false');
});

it.each(['working', 'draft', 'queued prompt'] as const)(
  'blocks terminal handoff with %s pending',
  (reason) => {
    if (reason === 'working') markAgentSpawned('agent');
    else if (reason === 'draft') setStore('tasks', 'task', 'terminalInputPending', true);
    else setStore('tasks', 'task', 'initialPrompt', 'Queued instruction');
    mount();
    clickChat();
    // The reason must be announced, not only offered as a tooltip on a button
    // that cannot be reached by keyboard or screen reader.
    const chat = host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]');
    expect(chat?.getAttribute('aria-disabled')).toBe('true');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(chat?.title);
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/before switching views/);
    expect(
      host
        .querySelector<HTMLButtonElement>('[aria-label="Show main agent terminal"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('false');
    expect(store.tasks.task.mainAgentView).not.toBe('chat');
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      IPC.AgentChat,
      expect.objectContaining({ action: 'handoffToChat' }),
    );
  },
);

it('hands a fresh Codex terminal with its idle placeholder over to Chat', async () => {
  mocks.invoke.mockResolvedValueOnce({});
  setStore('tasks', 'task', 'codexChatThreadId', 'stale-thread');
  markAgentSpawned('agent');
  mount();
  clickChat();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Wait for Codex');

  markAgentOutput(
    'agent',
    new TextEncoder().encode('› Ask Codex to do anything\r\n? for shortcuts  100% context left'),
  );
  expect(host.querySelector('[role="alert"]')).toBeNull();
  clickChat();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
  expect(mocks.invoke).toHaveBeenCalledWith(IPC.AgentChat, {
    action: 'handoffToChat',
    agentId: 'agent',
  });
  expect(store.tasks.task.codexChatThreadId).toBeUndefined();
  expect(mocks.invoke).toHaveBeenCalledWith(
    IPC.AgentChat,
    expect.objectContaining({ action: 'start', threadId: undefined }),
  );
});

it('reports the reason that holds now, not the one that was clicked on', () => {
  setStore('tasks', 'task', 'initialPrompt', 'Queued instruction');
  mount();
  clickChat();
  const alert = () => host.querySelector('[role="alert"]')?.textContent;
  expect(alert()).toMatch(/queued prompt/);
  // The queued prompt goes out, but the user starts typing in the terminal
  // before retrying. The alert must not still be citing the prompt.
  setStore('tasks', 'task', 'initialPrompt', undefined);
  setStore('tasks', 'task', 'terminalInputPending', true);
  expect(alert()).toMatch(/terminal draft/);
  setStore('tasks', 'task', 'terminalInputPending', false);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('explains itself while a handoff is in flight', async () => {
  let release: ((value: unknown) => void) | undefined;
  mocks.invoke.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  mount();
  clickChat();
  const chat = host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]');
  // Marked unavailable, so it owes the user a reason — and must keep focus.
  expect(chat?.getAttribute('aria-disabled')).toBe('true');
  expect(chat?.title).toBe('Switching conversation…');
  expect(chat?.disabled).toBe(false);
  release?.({ threadId: 'exact-thread' });
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
});

it('stops Chat before restarting Terminal with the same session and settings', async () => {
  setStore('tasks', 'task', 'agentSessionIds', {
    agent: 'fb4f2bc6-62d9-4b29-a795-240caf2fc459',
  });
  mount();
  clickChat();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
  mocks.invoke.mockResolvedValue({
    threadId: 'exact-thread',
    model: 'model-a',
    reasoningEffort: 'high',
  });
  clickTerminal();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('terminal'));
  expect(mocks.invoke).toHaveBeenCalledWith(IPC.AgentChat, {
    action: 'handoffToTerminal',
    agentId: 'agent',
  });
  expect(store.tasks.task.codexChatHandoff).toEqual({
    threadId: 'exact-thread',
    model: 'model-a',
    reasoningEffort: 'high',
  });
  expect(store.agents.agent.resumed).toBe(true);
  expect(mocks.terminalMounts).toHaveBeenCalledTimes(2);
  expect(mocks.terminalMounts).toHaveBeenLastCalledWith(
    expect.objectContaining({
      args: ['resume', 'exact-thread', '--model', 'model-a', '-c', 'model_reasoning_effort="high"'],
    }),
  );

  const pickedSession = 'fb4f2bc6-62d9-4b29-a795-240caf2fc460';
  resumeAgentSession('task', 'agent', pickedSession);
  expect(mocks.terminalMounts).toHaveBeenLastCalledWith(
    expect.objectContaining({
      args: ['resume', pickedSession],
    }),
  );
});

it('keeps the terminal visible when handoff fails and allows retry', async () => {
  mocks.invoke.mockRejectedValueOnce(new Error('Codex has not exited'));
  mount();
  clickChat();
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('has not exited'),
  );
  expect(store.tasks.task.mainAgentView).not.toBe('chat');
  clickChat();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
});

it('does not start a second handoff after rapid clicks', async () => {
  let release: ((value: unknown) => void) | undefined;
  mocks.invoke.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  mount();
  clickChat();
  clickChat();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  release?.({ threadId: 'exact-thread' });
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
});

const claudeSession = 'fb4f2bc6-62d9-4b29-a795-240caf2fc461';

function useClaudeCode() {
  setStore('agents', 'agent', 'def', {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    args: [],
    resume_args: [],
    skip_permissions_args: [],
    description: '',
  });
}

it('opens the Claude chat from a Claude Code terminal', async () => {
  useClaudeCode();
  mount();
  clickChat();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
  expect(host.querySelector('[aria-label="Claude conversation"]')).not.toBeNull();
  expect(mocks.invoke).toHaveBeenCalledWith(
    IPC.AgentChat,
    expect.objectContaining({ action: 'start', provider: 'claude', command: 'claude' }),
  );
  clickTerminal();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('terminal'));
  clickChat();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
});

it('carries the Claude conversation from the terminal into the chat and back', async () => {
  useClaudeCode();
  setStore('tasks', 'task', 'agentSessionIds', { agent: claudeSession });
  mount();
  clickChat();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
  expect(mocks.invoke).toHaveBeenCalledWith(
    IPC.AgentChat,
    expect.objectContaining({ action: 'handoffToChat', provider: 'claude', agentId: 'agent' }),
  );
  // The chat resumes the very session the terminal was running.
  expect(store.tasks.task.claudeChatSessionId).toBe(claudeSession);
  expect(mocks.invoke).toHaveBeenCalledWith(
    IPC.AgentChat,
    expect.objectContaining({ action: 'start', provider: 'claude', threadId: claudeSession }),
  );

  clickTerminal();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('terminal'));
  expect(mocks.invoke).toHaveBeenCalledWith(
    IPC.AgentChat,
    expect.objectContaining({ action: 'handoffToTerminal', provider: 'claude' }),
  );
  expect(mocks.terminalMounts).toHaveBeenLastCalledWith(
    expect.objectContaining({ args: ['--resume', claudeSession] }),
  );
});

it('opens a separate Claude chat when the pane has no session id to hand over', async () => {
  useClaudeCode();
  mount();
  clickChat();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
  expect(mocks.invoke).not.toHaveBeenCalledWith(
    IPC.AgentChat,
    expect.objectContaining({ action: 'handoffToChat' }),
  );
  expect(store.tasks.task.claudeChatSessionId).toBeUndefined();
});

it('asks before quitting a live terminal, and does nothing until the user agrees', async () => {
  useClaudeCode();
  setStore('tasks', 'task', 'agentSessionIds', { agent: claudeSession });
  mount();
  host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]')?.click();
  expect(switchConfirm()).toBe('Quit the Claude terminal?');
  expect(mocks.invoke).not.toHaveBeenCalled();

  cancelSwitch();
  expect(switchConfirm()).toBe('');
  expect(store.tasks.task.mainAgentView).not.toBe('chat');
  expect(mocks.invoke).not.toHaveBeenCalled();

  clickChat();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
  expect(mocks.invoke).toHaveBeenCalledWith(
    IPC.AgentChat,
    expect.objectContaining({ action: 'handoffToChat', provider: 'claude' }),
  );
});

it('hands off once Claude reports its turn over, though the screen is still redrawing', async () => {
  useClaudeCode();
  setStore('tasks', 'task', 'agentSessionIds', { agent: claudeSession });
  // The TUI keeps repainting its footer after `Stop`; the output heuristic
  // alone reads that as work for another 15 seconds.
  markAgentOutput('agent', new TextEncoder().encode('Worked for 12s\r\n? for shortcuts\r\n'));
  applyAgentHookEvent({
    agentId: 'agent',
    taskId: 'task',
    state: 'done',
    event: 'Stop',
    at: Date.now(),
  });
  mount();
  clickChat();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
});

it('keeps the terminal while Claude reports a turn in flight, though the screen looks idle', () => {
  useClaudeCode();
  setStore('tasks', 'task', 'agentSessionIds', { agent: claudeSession });
  applyAgentHookEvent({
    agentId: 'agent',
    taskId: 'task',
    state: 'working',
    event: 'UserPromptSubmit',
    at: Date.now(),
  });
  mount();
  clickChat();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Wait for Claude to finish');
  expect(store.tasks.task.mainAgentView).not.toBe('chat');
});

it('asks before closing a live chat to return to the terminal', async () => {
  useClaudeCode();
  setStore('tasks', 'task', 'agentSessionIds', { agent: claudeSession });
  setStore('tasks', 'task', 'mainAgentView', 'chat');
  setStore('tasks', 'task', 'claudeChatSessionId', claudeSession);
  setStore('agents', 'agent', 'chatState', { status: 'ready', items: [], requests: [] });
  mount();
  host.querySelector<HTMLButtonElement>('[aria-label="Show main agent terminal"]')?.click();
  expect(switchConfirm()).toBe('Close the Claude chat?');
  expect(store.tasks.task.mainAgentView).toBe('chat');
  confirmSwitch();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('terminal'));
});

it('closes the confirmation and explains itself when the agent got busy meanwhile', () => {
  useClaudeCode();
  setStore('tasks', 'task', 'agentSessionIds', { agent: claudeSession });
  mount();
  host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]')?.click();
  expect(switchConfirm()).toBe('Quit the Claude terminal?');
  markAgentSpawned('agent');
  confirmSwitch();
  expect(switchConfirm()).toBe('');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Wait for Claude to finish');
  expect(store.tasks.task.mainAgentView).not.toBe('chat');
});

it('takes the question away when the terminal exits while the dialog is open', () => {
  useClaudeCode();
  setStore('tasks', 'task', 'agentSessionIds', { agent: claudeSession });
  mount();
  host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]')?.click();
  expect(switchConfirm()).toBe('Quit the Claude terminal?');
  // Nothing left to quit, so nothing left to confirm.
  setStore('agents', 'agent', 'status', 'exited');
  expect(switchConfirm()).toBe('');
  expect(store.tasks.task.mainAgentView).not.toBe('chat');
});

it('switches straight away when neither side has a CLI left to quit', async () => {
  useClaudeCode();
  setStore('tasks', 'task', 'agentSessionIds', { agent: claudeSession });
  setStore('agents', 'agent', 'status', 'exited');
  mount();
  host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]')?.click();
  expect(switchConfirm()).toBe('');
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
});

it('waits for a busy Claude terminal before handing its conversation over', async () => {
  useClaudeCode();
  setStore('tasks', 'task', 'agentSessionIds', { agent: claudeSession });
  markAgentSpawned('agent');
  mount();
  clickChat();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Wait for Claude to finish');
  expect(mocks.invoke).not.toHaveBeenCalledWith(
    IPC.AgentChat,
    expect.objectContaining({ action: 'handoffToChat' }),
  );
  expect(store.tasks.task.mainAgentView).not.toBe('chat');
});

it.each(['dockerMode', 'coordinatorMode', 'coordinatedBy'] as const)(
  'keeps the Claude switcher visible and explains the %s restriction',
  (mode) => {
    setStore('agents', 'agent', 'def', { id: 'claude-code', command: 'claude' });
    if (mode === 'coordinatedBy') setStore('tasks', 'task', mode, 'coordinator');
    else setStore('tasks', 'task', mode, true);
    mount();
    const chat = host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]');
    expect(chat).not.toBeNull();
    expect(chat?.getAttribute('aria-disabled')).toBe('true');
    expect(chat?.title).toContain(mode === 'dockerMode' ? 'Docker' : 'coordinator');
    clickChat();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(chat?.title);
    expect(store.tasks.task.mainAgentView).not.toBe('chat');
    expect(mocks.invoke).not.toHaveBeenCalled();
  },
);

it('can return to Chat after the resumed terminal sends automatic replies and becomes idle', async () => {
  mount();
  clickChat();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
  clickTerminal();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('terminal'));
  markAgentSpawned('agent');
  setStore(
    'tasks',
    'task',
    'terminalInputPending',
    nextTerminalInputPending(false, '\x1b]11;rgb:0000/0000/0000\x1b\\'),
  );
  markAgentOutput('agent', new TextEncoder().encode('\r\n› '));
  clickChat();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
  expect(
    mocks.invoke.mock.calls.filter(
      (call) => (call[1] as { action?: string })?.action === 'handoffToChat',
    ),
  ).toHaveLength(2);
});

it('allows Chat after an app-submitted prompt clears stale terminal input', async () => {
  setStore('tasks', 'task', 'terminalInputPending', true);
  mount();
  clickChat();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('terminal draft');

  await sendPrompt('task', 'agent', 'Continue');
  markAgentOutput('agent', new TextEncoder().encode('\r\n› '));
  clickChat();
  await vi.waitFor(() => expect(store.tasks.task.mainAgentView).toBe('chat'));
});

it('shows a startup failure after clicking Chat', async () => {
  mocks.invoke.mockRejectedValueOnce(new Error('No handler registered for codex_chat'));
  mount();
  clickChat();
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('No handler registered'),
  );
});

it.each(['working', 'starting', 'approval'] as const)(
  'keeps Chat selected while %s blocks handoff',
  (reason) => {
    setStore('tasks', 'task', 'mainAgentView', 'chat');
    setStore('agents', 'agent', 'chatState', {
      status: reason === 'approval' ? 'ready' : reason,
      items: [],
      requests:
        reason === 'approval' ? [{ id: 1, kind: 'approval', text: 'Run command?', since: 1 }] : [],
    });
    mount();
    const terminal = host.querySelector<HTMLButtonElement>(
      '[aria-label="Show main agent terminal"]',
    );
    const chat = host.querySelector<HTMLButtonElement>('[aria-label="Show main agent chat"]');
    expect(terminal?.getAttribute('aria-disabled')).toBe('true');
    expect(chat?.getAttribute('aria-disabled')).toBe('false');
    expect(chat?.getAttribute('aria-pressed')).toBe('true');
    terminal?.click();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(terminal?.title);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      IPC.AgentChat,
      expect.objectContaining({ action: 'handoffToTerminal' }),
    );
    // Once the agent is done, the alert must stop demanding that it be stopped.
    setStore('agents', 'agent', 'chatState', { status: 'ready', items: [], requests: [] });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(terminal?.getAttribute('aria-disabled')).toBe('false');
  },
);

it('refreshes the linked session after the user changes conversations in Terminal', () => {
  const id = '01999999-1234-4321-9876-0123456789ab';
  setStore('tasks', 'task', 'codexChatHandoff', {
    threadId: 'previous',
    model: 'old-model',
    reasoningEffort: 'low',
  });
  mount();
  const props = mocks.terminalMounts.mock.calls[0][0] as {
    onExit: (info: { exit_code: number; signal: null; last_output: string[] }) => void;
  };
  props.onExit({
    exit_code: 0,
    signal: null,
    last_output: ['To continue this session, run:', `  codex resume ${id}`],
  });
  expect(store.tasks.task.codexChatHandoff).toEqual({ threadId: id });
});

it('copies the raw Markdown of a file opened in the viewer', async () => {
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  mocks.invoke.mockImplementation(async (channel?: unknown) =>
    channel === IPC.ReadFileText ? '# Notes\n\n- one' : undefined,
  );
  mount();
  const terminalProps = mocks.terminalMounts.mock.calls[0]?.[0] as {
    onFileLink?: (filePath: string) => void;
  };
  terminalProps.onFileLink?.('/worktree/NOTES.md');

  await vi.waitFor(() => {
    expect(document.querySelector('[role="dialog"] [title="Copy Markdown"]')).not.toBeNull();
  });
  document.querySelector<HTMLButtonElement>('[role="dialog"] [title="Copy Markdown"]')?.click();

  expect(writeText).toHaveBeenCalledWith('# Notes\n\n- one');
  await vi.waitFor(() => {
    expect(document.querySelector('[role="dialog"] [title="Copied"]')).not.toBeNull();
  });
});

it('offers to edit a file opened in the viewer as a document', async () => {
  setStore('documentWorkspacesEnabled', true);
  mocks.invoke.mockImplementation(async (channel?: unknown) =>
    channel === IPC.ReadFileText ? '# Notes' : undefined,
  );
  mount();
  const terminalProps = mocks.terminalMounts.mock.calls[0]?.[0] as {
    onFileLink?: (filePath: string) => void;
  };
  terminalProps.onFileLink?.('/worktree/NOTES.md');

  const button = await vi.waitFor(() => {
    const el = document.querySelector<HTMLButtonElement>(
      '[role="dialog"] [aria-label="Edit as document"]',
    );
    expect(el).not.toBeNull();
    return el;
  });
  button?.click();

  expect(mocks.editAsDocument).toHaveBeenCalledWith('/worktree/NOTES.md');
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  setStore('documentWorkspacesEnabled', false);
});

it('logs why copying the Markdown failed', async () => {
  const writeText = vi.fn(async (_text: string) => {
    throw new DOMException('Document is not focused.', 'NotAllowedError');
  });
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  mocks.invoke.mockImplementation(async (channel?: unknown) =>
    channel === IPC.ReadFileText ? '# Notes' : undefined,
  );
  try {
    mount();
    const terminalProps = mocks.terminalMounts.mock.calls[0]?.[0] as {
      onFileLink?: (filePath: string) => void;
    };
    terminalProps.onFileLink?.('/worktree/NOTES.md');
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"] [title="Copy Markdown"]')).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>('[role="dialog"] [title="Copy Markdown"]')?.click();
    await vi.waitFor(() => {
      expect(JSON.stringify(consoleWarn.mock.calls)).toContain('Document is not focused.');
    });
  } finally {
    consoleWarn.mockRestore();
  }
});

it('starts a task in Chat without mounting a terminal and still allows switching', async () => {
  setStore('tasks', 'task', 'mainAgentView', 'chat');
  mount();
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      IPC.AgentChat,
      expect.objectContaining({ action: 'start', agentId: 'agent' }),
    ),
  );
  expect(mocks.terminalMounts).not.toHaveBeenCalled();
  clickTerminal();
  await vi.waitFor(() => expect(mocks.terminalMounts).toHaveBeenCalled());
  expect(store.tasks.task.mainAgentView).toBe('terminal');
});

it('offers second opinion with one live agent and dismisses it per task without removing menu access', () => {
  setStore('mcpOrchestrationEnabled', true);
  setStore('agents', 'agent', 'sessionInstanceId', 'live-session');
  mount();
  const props = mocks.terminalMounts.mock.calls.at(-1)?.[0] as {
    onSecondOpinion?: () => void;
  };
  expect(document.querySelector('.agent-header-controls .terminal-second-opinion')).not.toBeNull();
  expect(props.onSecondOpinion).toBeTypeOf('function');
  document
    .querySelector<HTMLButtonElement>('[aria-label="Dismiss second opinion button for this task"]')
    ?.click();
  expect(store.tasks.task.secondOpinionDismissed).toBe(true);
  expect(document.querySelector('.terminal-second-opinion')).toBeNull();
  expect(props.onSecondOpinion).toBeTypeOf('function');
});

it('opens second opinion by action after dismissing the button and preserves an open draft', () => {
  mocks.invoke.mockResolvedValue([]);
  setStore('mcpOrchestrationEnabled', true);
  setStore('agents', 'agent', 'sessionInstanceId', 'live-session');
  setStore('tasks', 'task', 'secondOpinionDismissed', true);
  mount();
  triggerAction('task:second-opinion');
  const instructions = document.querySelector<HTMLTextAreaElement>('.agent-handoff textarea');
  expect(instructions).not.toBeNull();
  if (!instructions) throw new Error('Missing message');
  instructions.value = 'Keep my draft';
  instructions.dispatchEvent(new Event('input', { bubbles: true }));
  triggerAction('task:second-opinion');
  expect(document.querySelector('.agent-handoff textarea')).toBe(instructions);
  expect(instructions.value).toBe('Keep my draft');
});

it('does not open a second opinion for an unavailable source', () => {
  setStore('mcpOrchestrationEnabled', false);
  mount();
  triggerAction('task:second-opinion');
  expect(document.querySelector('.agent-handoff textarea')).toBeNull();
});

it('hands a pending question the keyboard however focus reaches the chat', async () => {
  const question = {
    id: 1,
    kind: 'question' as const,
    text: 'Claude needs your input',
    since: 1,
    questions: [
      {
        id: 'scope',
        question: 'Which scope?',
        isSecret: false,
        options: [{ label: 'Narrow', description: '' }],
      },
    ],
  };
  const optionFocused = () => document.activeElement?.firstChild?.textContent === 'Narrow';
  const outside = document.createElement('button');
  document.body.append(outside);
  try {
    setStore('tasks', 'task', { mainAgentView: 'chat', promptDraft: '' });
    setStore('agents', 'agent', 'chatState', { status: 'working', items: [], requests: [] });
    setStore({ activeTaskId: 'task', sidebarFocused: false, placeholderFocused: false });
    // Alt+Down reaches the prompt row, which chat mode hides: its key focuses the composer.
    setStore('focusedPanel', 'task', 'prompt');
    mount();
    await vi.waitFor(() => expect(host.querySelector('textarea')).not.toBeNull());
    host.querySelector('textarea')?.focus();
    setStore('agents', 'agent', 'chatState', 'requests', [question]);
    await vi.waitFor(() => expect(optionFocused()).toBe(true));

    // Arriving from elsewhere, e.g. Alt+Left from another task, runs the panel's focus on
    // either cell. Unsent text keeps the composer, so a stray Space never approves.
    const composer = () => host.querySelector('textarea');
    for (const panel of ['ai-terminal:agent', 'prompt']) {
      setStore('tasks', 'task', 'promptDraft', 'Half written');
      outside.focus();
      setTaskFocusedPanel('task', panel);
      await vi.waitFor(() => expect(document.activeElement).toBe(composer()));
      setStore('tasks', 'task', 'promptDraft', '');
      outside.focus();
      setTaskFocusedPanel('task', panel);
      await vi.waitFor(() => expect(optionFocused()).toBe(true));
    }
  } finally {
    outside.remove();
  }
});
