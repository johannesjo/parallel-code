import { beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { parsePromptMenu } from '../../electron/shared/prompt-menu';
import { invoke } from '../lib/ipc';
import { replyToPrompt } from './promptPeek';
import { sendPrompt } from './tasks';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('./tasks', () => ({ sendPrompt: vi.fn(async () => undefined) }));
vi.mock('./agentHookStatus', () => ({ noteAgentTerminalInput: vi.fn() }));

const CLAUDE = parsePromptMenu(
  [
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No, and tell Claude what to do differently (esc)',
  ].join('\n'),
);
const QUESTION = parsePromptMenu(
  [' Which theme?', ' ❯ 1. App theme', '   2. Own toggle', '   3. Type something.'].join('\n'),
);
const CHOICE_ONLY = parsePromptMenu([' Trust this folder?', ' ❯ 1. Yes', '   2. No'].join('\n'));
const target = { taskId: 'one', agentId: 'agent' };

// What the agent's screen shows after each peek: the dialog until `closesAfter` reads.
function screen(menu: typeof CLAUDE, closesAfter: number) {
  let reads = 0;
  vi.mocked(invoke).mockImplementation(async (channel) => {
    if (channel === IPC.AnswerAgentPrompt) return true;
    reads++;
    return { menu: reads > closesAfter ? null : menu, tail: [] };
  });
}

const sentKeys = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([channel]) => channel === IPC.AnswerAgentPrompt)
    .map(([, args]) => args?.n);

beforeEach(() => vi.clearAllMocks());

it('declines with Escape, then types the reply once the dialog has closed', async () => {
  screen(CLAUDE, 2);
  await replyToPrompt({ target, menu: CLAUDE, text: 'Use the cached build' });
  expect(sentKeys()).toEqual([2]);
  expect(sendPrompt).toHaveBeenCalledWith('one', 'agent', 'Use the cached build');
});

it('types nothing when the dialog stays open after Escape', async () => {
  vi.useFakeTimers();
  screen(CLAUDE, Infinity);
  const reply = replyToPrompt({ target, menu: CLAUDE, text: '1 more thing' });
  const failed = expect(reply).rejects.toThrow('Open the task to reply');
  await vi.advanceTimersByTimeAsync(2500);
  await failed;
  expect(sendPrompt).not.toHaveBeenCalled();
  vi.useRealTimers();
});

it('picks "Type something" and types into its field, which keeps the options on screen', async () => {
  screen(QUESTION, Infinity);
  await replyToPrompt({ target, menu: QUESTION, text: 'Follow the OS' });
  expect(sentKeys()).toEqual([3]);
  expect(sendPrompt).toHaveBeenCalledWith('one', 'agent', 'Follow the OS');
});

it('types straight into the prompt when no dialog is on screen', async () => {
  vi.mocked(invoke).mockResolvedValue({ menu: null, tail: [] });
  await replyToPrompt({ target, menu: null, text: 'yes' });
  expect(sentKeys()).toEqual([]);
  expect(sendPrompt).toHaveBeenCalledWith('one', 'agent', 'yes');
});

it('types nothing when a dialog appeared since the user last looked', async () => {
  // Enter would pick the dialog's highlighted option.
  screen(CLAUDE, Infinity);
  await expect(replyToPrompt({ target, menu: null, text: 'stop' })).rejects.toThrow('Look again');
  expect(sendPrompt).not.toHaveBeenCalled();
});

it('refuses a typed reply to a dialog that only takes a choice', async () => {
  await expect(replyToPrompt({ target, menu: CHOICE_ONLY, text: 'maybe' })).rejects.toThrow(
    'choice only',
  );
  expect(sendPrompt).not.toHaveBeenCalled();
});

it('types nothing when the question changed before the reply', async () => {
  vi.mocked(invoke).mockResolvedValue(false);
  await expect(replyToPrompt({ target, menu: CLAUDE, text: 'no' })).rejects.toThrow('changed');
  expect(sendPrompt).not.toHaveBeenCalled();
});
