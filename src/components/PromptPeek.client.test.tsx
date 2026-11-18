import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { IPC } from '../../electron/ipc/channels';
import { parsePromptMenu } from '../../electron/shared/prompt-menu';
import { invoke } from '../lib/ipc';
import { setStore } from '../store/core';
import { jumpToWaitingTask, type AttentionEntry } from '../store/sidebar-attention';
import type { Task } from '../store/types';
import { openPromptPeek, PromptPeek } from './PromptPeek';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));
vi.mock('../store/tasks', () => ({ sendPrompt: vi.fn(async () => undefined) }));
// Which tasks wait comes from terminal output and hooks, too far removed to drive here.
const waiting = vi.hoisted(() => ({ taskIds: [] as string[] }));
vi.mock('../store/taskStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/taskStatus')>()),
  getTaskOpenQuestion: (taskId: string) =>
    waiting.taskIds.includes(taskId) ? { agentId: `${taskId}-agent`, since: 0 } : null,
}));
// Which agents answer in a chat view depends on agent definitions; only the outcome matters here.
const chat = vi.hoisted(() => ({ agentIds: [] as string[] }));
vi.mock('../store/agent-chat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/agent-chat')>()),
  isAgentChat: (_task: unknown, agentId: string) => chat.agentIds.includes(agentId),
}));
vi.mock('../store/sidebar-attention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/sidebar-attention')>()),
  jumpToWaitingTask: vi.fn(),
  computeAttentionEntries: (): AttentionEntry[] =>
    waiting.taskIds.map((taskId) => ({
      key: taskId,
      kind: 'question',
      taskId,
      label: 'Approve request',
      panel: null,
      changes: [],
    })),
}));

const MENU = parsePromptMenu(
  [
    ' Bash command',
    '   rm -rf dist && npm run build',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No, and tell Claude what to do differently (esc)',
  ].join('\n'),
);

function task(id: string): Task {
  return {
    id,
    name: `Task ${id}`,
    projectId: 'p',
    branchName: id,
    worktreePath: `/tmp/${id}`,
    agentIds: [`${id}-agent`],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
    baseBranch: 'main',
  };
}

let dispose: () => void;
let anchor: HTMLButtonElement;

beforeEach(() => {
  waiting.taskIds = ['a', 'b'];
  chat.agentIds = [];
  setStore('tasks', reconcile({ a: task('a'), b: task('b'), c: task('c') }));
  vi.mocked(invoke).mockImplementation(async (channel) => {
    // A fresh copy per read, as IPC delivers it.
    if (channel === IPC.PeekAgentPrompt) return structuredClone({ menu: MENU, tail: [] });
    if (channel === IPC.AnswerAgentPrompt) return true;
    return undefined;
  });
  anchor = document.createElement('button');
  anchor.dataset.attentionTask = 'a';
  document.body.append(anchor);
  const root = document.createElement('div');
  document.body.append(root);
  const stop = render(() => <PromptPeek />, root);
  dispose = () => {
    stop();
    root.remove();
  };
});

afterEach(() => {
  dispose();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const peek = () => document.querySelector<HTMLElement>('.prompt-peek');
const press = (key: string) =>
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

async function openOn(taskId: string) {
  openPromptPeek(taskId, anchor);
  await vi.waitFor(() => expect(peek()?.querySelector('.prompt-peek-text')).not.toBeNull());
}

it('shows the whole question, the plain choices and a reply box', async () => {
  await openOn('a');
  expect(peek()?.querySelector('.prompt-peek-text')?.textContent).toContain(
    'rm -rf dist && npm run build',
  );
  expect(
    [...(peek()?.querySelectorAll('.prompt-peek-choices button') ?? [])].map((b) => b.textContent),
  ).toEqual(['1Yes']);
  expect(peek()?.querySelector('textarea')).not.toBeNull();
});

it('answers with a number key and closes', async () => {
  await openOn('a');
  await vi.waitFor(() => expect(peek()?.contains(document.activeElement)).toBe(true));
  press('1');
  await vi.waitFor(() => expect(peek()).toBeNull());
  expect(vi.mocked(invoke)).toHaveBeenCalledWith(
    IPC.AnswerAgentPrompt,
    expect.objectContaining({ agentId: 'a-agent', n: 1 }),
  );
});

it('moves to the next waiting task with Tab', async () => {
  const next = document.createElement('button');
  next.dataset.attentionTask = 'b';
  document.body.append(next);
  await openOn('a');
  await vi.waitFor(() => expect(peek()?.contains(document.activeElement)).toBe(true));
  press('Tab');
  await vi.waitFor(() => expect(peek()?.getAttribute('aria-label')).toBe('Question from Task b'));
  expect(vi.mocked(invoke)).toHaveBeenCalledWith(IPC.PeekAgentPrompt, { agentId: 'b-agent' });
});

it('skips tasks whose agent answers in its chat view', async () => {
  waiting.taskIds = ['a', 'b', 'c'];
  chat.agentIds = ['b-agent'];
  await openOn('a');
  await vi.waitFor(() => expect(peek()?.contains(document.activeElement)).toBe(true));
  press('Tab');
  await vi.waitFor(() => expect(peek()?.getAttribute('aria-label')).toBe('Question from Task c'));
});

it('keeps focus on its choices while it re-reads the screen', async () => {
  await openOn('a');
  await vi.waitFor(() => expect(peek()?.contains(document.activeElement)).toBe(true));
  const focused = document.activeElement;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(document.activeElement).toBe(focused);
});

it('keeps focus while only rows outside the dialog change, like a status clock', async () => {
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.PeekAgentPrompt
      ? { menu: structuredClone(MENU), tail: [String(Date.now())] }
      : true,
  );
  await openOn('a');
  await vi.waitFor(() => expect(peek()?.contains(document.activeElement)).toBe(true));
  const focused = document.activeElement;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(document.activeElement).toBe(focused);
});

it('shows no reply box while it reads a dialog that may take a choice only', () => {
  openPromptPeek('a', anchor);
  expect(peek()?.querySelector('textarea')).toBeNull();
});

it('leaves Shift+Tab to move focus inside the popup', async () => {
  await openOn('a');
  await vi.waitFor(() => expect(peek()?.contains(document.activeElement)).toBe(true));
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.activeElement?.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(peek()?.getAttribute('aria-label')).toBe('Question from Task a');
});

it('opens the task with O', async () => {
  await openOn('a');
  await vi.waitFor(() => expect(peek()?.contains(document.activeElement)).toBe(true));
  press('o');
  expect(jumpToWaitingTask).toHaveBeenCalledWith('a', null);
  await vi.waitFor(() => expect(peek()).toBeNull());
});

it('closes with Escape, back on the row it opened from', async () => {
  await openOn('a');
  press('Escape');
  await vi.waitFor(() => expect(peek()).toBeNull());
  expect(document.activeElement).toBe(anchor);
});

it('opens the task instead when the agent has no screen to read', async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  openPromptPeek('a', anchor);
  await vi.waitFor(() => expect(jumpToWaitingTask).toHaveBeenCalledWith('a', null));
  expect(peek()).toBeNull();
});

it('sits beside the whole card, not over its neighbours, when opened from a card button', async () => {
  const card = document.createElement('li');
  card.dataset.boardCard = 'a';
  const button = document.createElement('button');
  card.append(button);
  document.body.append(card);
  card.getBoundingClientRect = () => DOMRect.fromRect({ x: 20, y: 100, width: 260, height: 180 });
  button.getBoundingClientRect = () => DOMRect.fromRect({ x: 30, y: 250, width: 60, height: 20 });
  openPromptPeek('a', button, true);
  await vi.waitFor(() => expect(peek()).not.toBeNull());
  expect(peek()?.style.left).toBe('288px');
  expect(peek()?.style.top).toBe('100px');
});

it('offers Send only once there is something to send', async () => {
  openPromptPeek('a', anchor, true);
  await vi.waitFor(() => expect(peek()?.querySelector('textarea')).not.toBeNull());
  const send = peek()?.querySelector<HTMLButtonElement>('.prompt-peek-send');
  expect(send?.disabled).toBe(true);
  const box = peek()?.querySelector('textarea');
  if (box) box.value = '  ';
  box?.dispatchEvent(new InputEvent('input', { bubbles: true }));
  expect(send?.disabled).toBe(true);
  if (box) box.value = 'Use the cache';
  box?.dispatchEvent(new InputEvent('input', { bubbles: true }));
  expect(send?.disabled).toBe(false);
});
