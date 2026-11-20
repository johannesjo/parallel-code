import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import {
  ESC,
  samePromptMenu,
  seenPromptMenu,
  type AgentPromptPeek,
  type PromptMenu,
  type PromptMenuOption,
} from '../../electron/shared/prompt-menu';
import { invoke } from '../lib/ipc';
import { warn as logWarn } from '../lib/log';
import { noteAgentTerminalInput } from './agentHookStatus';
import { sendPrompt } from './tasks';

// shortcut: polls while someone watches — push from the mirror on screen change
// if many agents wait at once and the IPC traffic shows up.
const PEEK_POLL_MS = 1000;
const LEAVE_POLL_MS = 100;
const LEAVE_TIMEOUT_MS = 2000;
// The pause between picking "type something" and typing, so the agent shows its text field first.
const TYPED_FIELD_DELAY_MS = 150;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The agent's screen right now: its choice dialog and last rows; null without a terminal mirror. */
export function fetchPromptPeek(agentId: string): Promise<AgentPromptPeek | null> {
  return invoke<AgentPromptPeek | null>(IPC.PeekAgentPrompt, { agentId });
}

/**
 * What the agent's screen asks, kept fresh while `agentId` names an agent:
 * undefined until the first read, null when the agent has no terminal mirror.
 * The hook that marks an agent waiting can fire before its dialog is drawn,
 * so one read is not enough.
 */
export function createPromptPeek(
  agentId: () => string | undefined,
): () => AgentPromptPeek | null | undefined {
  // Each read is a new object; an unchanged dialog must not rebuild the buttons,
  // which would drop focus and clicks and re-arm a choice already answered.
  // With a dialog up only the dialog counts: a status-line clock below it ticks.
  const shown = (p: AgentPromptPeek | null | undefined) => JSON.stringify(p?.menu ?? p);
  const [peek, setPeek] = createSignal<AgentPromptPeek | null | undefined>(undefined, {
    equals: (a, b) => shown(a) === shown(b),
  });
  // Callers derive the id from busy task and hook state; only a different id may
  // reset the read, or every unrelated update blanks the card until the next poll.
  const currentId = createMemo(agentId);
  createEffect(() => {
    const id = currentId();
    setPeek(undefined);
    if (!id) return;
    let alive = true;
    const read = () =>
      fetchPromptPeek(id).then(
        (next) => alive && setPeek(next),
        (err: unknown) => {
          logWarn('prompt-peek', 'read failed', { err });
          // A first read that fails counts as nothing to read, so the peek gives way to the task.
          if (alive) setPeek((last) => (last === undefined ? null : last));
        },
      );
    void read();
    const timer = setInterval(() => void read(), PEEK_POLL_MS);
    onCleanup(() => {
      alive = false;
      clearInterval(timer);
    });
  });
  return peek;
}

/**
 * Picks `option` if the agent still shows `menu`; false when the dialog changed
 * or went away, so nothing was typed.
 */
export async function pickPromptOption(
  target: { taskId: string; agentId: string },
  menu: PromptMenu,
  option: PromptMenuOption,
): Promise<boolean> {
  const sent = await invoke<boolean>(IPC.AnswerAgentPrompt, {
    taskId: target.taskId,
    agentId: target.agentId,
    n: option.n,
    ...seenPromptMenu(menu),
  });
  // The key bypassed the terminal, which would otherwise move the card out of Needs you.
  if (sent) noteAgentTerminalInput(target.agentId, option.key, () => '');
  return sent;
}

async function waitForDialogToLeave(agentId: string, menu: PromptMenu): Promise<boolean> {
  const deadline = Date.now() + LEAVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(LEAVE_POLL_MS);
    const now = (await fetchPromptPeek(agentId))?.menu;
    if (!now || !samePromptMenu(now, seenPromptMenu(menu))) return true;
  }
  return false;
}

/**
 * Sends a typed answer. With a dialog on screen, first picks its option that
 * asks for typing (Claude's "No, and tell Claude…", a question's "Type
 * something"); without one, the agent's prompt takes the text directly.
 * Throws, with a message for the user, when nothing could be sent.
 */
export async function replyToPrompt(opts: {
  target: { taskId: string; agentId: string };
  menu: PromptMenu | null;
  text: string;
}): Promise<true> {
  const { target, menu } = opts;
  const typed = menu?.options.find((o) => o.typed);
  if (menu && !typed) throw new Error('This dialog takes a choice only.');
  // Read up to a second ago: a dialog drawn since would take the reply's Enter as a pick.
  if (!menu && (await fetchPromptPeek(target.agentId))?.menu)
    throw new Error('The agent is showing a dialog now. Look again before replying.');
  if (menu && typed) {
    if (!(await pickPromptOption(target, menu, typed)))
      throw new Error('The question changed. Look again before replying.');
    // Escape closes the dialog; until it has, typed digits would pick its options.
    if (typed.key === ESC) {
      if (!(await waitForDialogToLeave(target.agentId, menu)))
        throw new Error('The agent did not close its dialog. Open the task to reply.');
    } else await sleep(TYPED_FIELD_DELAY_MS);
  }
  await sendPrompt(target.taskId, target.agentId, opts.text);
  return true;
}
