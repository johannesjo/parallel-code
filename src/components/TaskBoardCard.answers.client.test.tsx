import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { IPC } from '../../electron/ipc/channels';
import { parsePromptMenu } from '../../electron/shared/prompt-menu';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';
import type { Task } from '../store/types';
import { openPromptPeek } from './PromptPeek';
import { TaskBoardCard } from './TaskBoardCard';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));
vi.mock('./PromptPeek', () => ({ openPromptPeek: vi.fn() }));
// The agent's question state comes from terminal output and hooks, too far
// removed from the card to drive; the card only needs "this agent asks".
vi.mock('../store/taskStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/taskStatus')>()),
  getTaskOpenQuestion: () => ({ agentId: 'agent', since: Date.now() }),
  getTaskAttentionState: () => 'needs_input',
}));

const SCREEN = [
  '─'.repeat(40),
  ' Bash command',
  '',
  '   npm test',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for npm test commands",
  '   3. No, and tell Claude what to do differently (esc)',
].join('\n');
const menu = parsePromptMenu(SCREEN);

const task: Task = {
  id: 'one',
  name: 'one',
  projectId: 'project',
  branchName: 'feature/one',
  worktreePath: '/tmp/one',
  agentIds: ['agent'],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
  baseBranch: 'main',
};

let container: HTMLDivElement;
let dispose: () => void;

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (channel) => {
    // A fresh copy per read, as IPC delivers it.
    if (channel === IPC.PeekAgentPrompt) return structuredClone({ menu, tail: [] });
    if (channel === IPC.AnswerAgentPrompt) return true;
    return undefined;
  });
  setStore('tasks', reconcile({ one: { ...task } }));
  setStore('taskOrder', ['one']);
  container = document.createElement('div');
  document.body.append(container);
  dispose = render(() => <TaskBoardCard task={store.tasks.one} lane="needs" />, container);
});

afterEach(() => {
  dispose();
  container.remove();
  vi.clearAllMocks();
});

const answerButtons = () =>
  [...container.querySelectorAll<HTMLButtonElement>('[data-answer]')].map((b) =>
    b.textContent?.trim(),
  );
const answerCalls = () =>
  vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.AnswerAgentPrompt);

it("shows the agent's question and its choices instead of the branch and Answer", async () => {
  await vi.waitFor(() =>
    expect(answerButtons()).toEqual([
      '1Yes',
      "2Yes, and don't ask again for npm test commands",
      '3No…',
    ]),
  );
  // Line by line, not run together; blank dialog rows add nothing on a card.
  const line = container.querySelector('.task-board-activity');
  expect(line?.textContent).toBe('Bash command\nnpm test\nDo you want to proceed?');
  expect(line?.classList.contains('question')).toBe(true);
  expect(container.textContent).not.toContain('Answer');
});

it('answers with the choice clicked, naming the dialog it was read from', async () => {
  await vi.waitFor(() => expect(answerButtons()).toHaveLength(3));
  container.querySelector<HTMLButtonElement>('[data-answer="2"]')?.click();
  expect(answerCalls()).toEqual([
    [
      IPC.AnswerAgentPrompt,
      {
        taskId: 'one',
        agentId: 'agent',
        n: 2,
        body: ['Bash command', '', 'npm test', '', 'Do you want to proceed?'],
        labels: [
          'Yes',
          "Yes, and don't ask again for npm test commands",
          'No, and tell Claude what to do differently',
        ],
      },
    ],
  ]);
});

it('answers with a number key pressed on the focused card', async () => {
  await vi.waitFor(() => expect(answerButtons()).toHaveLength(3));
  const title = container.querySelector<HTMLButtonElement>('.task-board-title');
  title?.focus();
  title?.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
  expect(answerCalls()[0]?.[1]).toMatchObject({ n: 1 });
});

it('answers once when the key is held or the button double-clicked', async () => {
  vi.mocked(invoke).mockImplementation(async (channel) => {
    if (channel === IPC.PeekAgentPrompt) return { menu, tail: [] };
    // The agent takes a moment to redraw; until then the dialog still matches.
    return new Promise((resolve) => setTimeout(() => resolve(true), 50));
  });
  await vi.waitFor(() => expect(answerButtons()).toHaveLength(3));
  const title = container.querySelector<HTMLButtonElement>('.task-board-title');
  title?.focus();
  title?.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
  title?.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, repeat: true }));
  container.querySelector<HTMLButtonElement>('[data-answer="1"]')?.click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  container.querySelector<HTMLButtonElement>('[data-answer="2"]')?.click();
  expect(answerCalls().map(([, args]) => args?.n)).toEqual([1]);
});

it('answers once while the same dialog stays on screen', async () => {
  await vi.waitFor(() => expect(answerButtons()).toHaveLength(3));
  container.querySelector<HTMLButtonElement>('[data-answer="1"]')?.click();
  // A slow agent: the next read still shows the dialog just answered.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  container.querySelector<HTMLButtonElement>('[data-answer="1"]')?.click();
  expect(answerCalls()).toHaveLength(1);
});

it('opens the peek for a choice that needs a typed answer, typing nothing', async () => {
  await vi.waitFor(() => expect(answerButtons()).toHaveLength(3));
  const no = container.querySelector<HTMLButtonElement>('[data-answer="3"]');
  no?.click();
  expect(openPromptPeek).toHaveBeenCalledWith('one', no, true);
  expect(answerCalls()).toEqual([]);
});

it('keeps the plain Answer button while no dialog can be read', async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  dispose();
  dispose = render(() => <TaskBoardCard task={store.tasks.one} lane="needs" />, container);
  await vi.waitFor(() =>
    expect(vi.mocked(invoke).mock.calls.some(([c]) => c === IPC.PeekAgentPrompt)).toBe(true),
  );
  expect(answerButtons()).toEqual([]);
  expect(container.querySelector('.task-board-act')?.textContent).toBe('Answer');
});
