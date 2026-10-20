import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { AgentChatState } from '../../electron/shared/agent-chat-types';
import { ChatDetail } from './ChatDetail';
import { sendChatAction, watchChat } from './ws';

const control = vi.hoisted(() => ({ canControl: true }));
vi.mock('./ws', () => ({
  agents: () => [
    {
      agentId: 'a1',
      taskId: 't1',
      taskName: 'Chat task',
      status: 'running',
      attention: 'active',
      agentName: 'Claude Code',
      kind: 'chat',
    },
    {
      agentId: 'a2',
      taskId: 't2',
      taskName: 'Other chat',
      status: 'running',
      attention: 'active',
      agentName: 'Claude Code',
      kind: 'chat',
    },
  ],
  status: () => 'connected',
  canControl: () => control.canControl,
  watchChat: vi.fn(() => vi.fn()),
  sendChatAction: vi.fn(async () => {}),
}));

let container: HTMLDivElement;
let dispose: () => void;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const frame: AgentChatState = {
  status: 'ready',
  threadId: 'thread',
  items: [
    { id: 'u', kind: 'user', text: 'Fix the flaky test' },
    { id: 'a', kind: 'assistant', text: 'Fixed it. See [the test](src/app.test.ts).' },
  ],
  requests: [],
};

async function mount(agentId = 'a1', initial = frame) {
  dispose = render(
    () => (
      <ChatDetail agentId={agentId} taskName="Chat" onBack={() => {}} onNeedsPairing={() => {}} />
    ),
    container,
  );
  const push = vi.mocked(watchChat).mock.calls.at(-1)?.[1];
  if (!push) throw new Error('The chat was not watched');
  push(initial);
  await settle();
  return push;
}
const composer = () => {
  const input = container.querySelector('textarea');
  if (!input) throw new Error('Chat composer is missing');
  return input;
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  control.canControl = true;
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  dispose();
  container.remove();
});

it('shows the desktop conversation and follows its updates', async () => {
  const push = await mount();
  expect(watchChat).toHaveBeenCalledWith('a1', expect.any(Function));
  expect(container.textContent).toContain('Fix the flaky test');
  expect(container.textContent).toContain('Fixed it.');

  push({
    ...frame,
    items: [...frame.items, { id: 'b', kind: 'assistant', text: 'All green now.' }],
  });
  await settle();
  expect(container.textContent).toContain('All green now.');
});

it('sends a reply to the desktop chat and clears the draft', async () => {
  await mount();
  const input = composer();
  input.value = 'Now update the docs';
  input.dispatchEvent(new InputEvent('input', { data: 's', bubbles: true }));
  await settle();
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await settle();
  expect(sendChatAction).toHaveBeenCalledWith('a1', 'send', { text: 'Now update the docs' });
  expect(composer().value).toBe('');
});

it('keeps the composer disabled until the phone is paired', async () => {
  control.canControl = false;
  await mount();
  expect(composer().disabled).toBe(true);
});

it('keeps file links from replacing the phone route', async () => {
  await mount();
  const link = container.querySelector<HTMLAnchorElement>('a[href^="#parallel-code-file="]');
  expect(link).not.toBeNull();
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  link?.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
});

it('keeps in-page links in agent output from changing the phone route', async () => {
  await mount('a1', {
    ...frame,
    items: [{ id: 'a', kind: 'assistant', text: 'See [the other task](#/task/t2).' }],
  });
  const link = container.querySelector<HTMLAnchorElement>('a[href="#/task/t2"]');
  expect(link).not.toBeNull();
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  link?.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
});

it('keeps a follow-up queued in one chat out of every other chat', async () => {
  // Both conversations are new, so neither has a thread id to tell them apart yet.
  const busy: AgentChatState = { status: 'working', items: [], requests: [] };
  await mount('a1', busy);
  const input = composer();
  input.value = 'Meant for the first task';
  input.dispatchEvent(new InputEvent('input', { data: 'k', bubbles: true }));
  await settle();
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await settle();
  expect(container.querySelector('[aria-label="Queued messages"]')).not.toBeNull();
  dispose();

  await mount('a2', busy);
  expect(container.querySelector('[aria-label="Queued messages"]')).toBeNull();
  expect(container.textContent).not.toContain('Meant for the first task');
});

it("shows the agent's error and says when the chat has stopped", async () => {
  const push = await mount();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  push({ ...frame, status: 'closed', error: 'Claude exited unexpectedly.' });
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'Claude exited unexpectedly.',
  );
  expect(container.textContent).toContain('This chat has stopped');
  expect(container.textContent).toContain('Fixed it.');
});
