import { createEffect, createSignal, For, on, Show, untrack } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { PromptMenuOption } from '../../electron/shared/prompt-menu';
import { isAgentChat } from '../store/agent-chat';
import { store } from '../store/core';
import { createPromptPeek, pickPromptOption, replyToPrompt } from '../store/promptPeek';
import { computeAttentionEntries, jumpToWaitingTask } from '../store/sidebar-attention';
import { getTaskOpenQuestion } from '../store/taskStatus';
import { createPopover } from './create-popover';
import './prompt-peek.css';
import { answerLabel } from './board/CardAnswers';
import { askingPanel } from './board/task-state';

interface PeekTarget {
  taskId: string;
  agentId: string;
  anchor: HTMLElement;
  /** Opened to type an answer: the reply box gets focus. */
  reply: boolean;
}

const [target, setTarget] = createSignal<PeekTarget | null>(null);
// The panel's CSS width, so it can be placed before it renders.
const PANEL_WIDTH = 384;
const GAP = 8;

/** Opens the peek beside `anchor` for the task's waiting agent; nothing when none waits. */
export function openPromptPeek(taskId: string, anchor: HTMLElement, reply = false): void {
  const agentId = getTaskOpenQuestion(taskId)?.agentId;
  if (agentId) setTarget({ taskId, agentId, anchor, reply });
}

/** A terminal agent's question can be read and answered here; a chat agent's opens its chat. */
export function canPeekTask(taskId: string): boolean {
  const agentId = getTaskOpenQuestion(taskId)?.agentId;
  return !!agentId && !isAgentChat(store.tasks[taskId], agentId);
}

/** The next task the peek can answer, in the sidebar's Needs-you order, wrapping around. */
export function nextWaitingTaskId(taskId: string): string | null {
  const ids = [
    ...new Set(
      computeAttentionEntries()
        .filter((entry) => entry.kind === 'question' && canPeekTask(entry.taskId))
        .map((entry) => entry.taskId),
    ),
  ];
  const next = ids[(ids.indexOf(taskId) + 1) % ids.length];
  return next && next !== taskId ? next : null;
}

// The next task's card or sidebar row, matching where the peek was opened from.
function anchorFor(taskId: string, previous: HTMLElement): HTMLElement {
  const selector = previous.closest('[data-board-card]')
    ? `[data-board-card="${CSS.escape(taskId)}"]`
    : `[data-attention-task="${CSS.escape(taskId)}"]`;
  return document.querySelector<HTMLElement>(selector) ?? previous;
}

// Beside the anchor's card (or the anchor itself, like a sidebar row), on the side
// with room, kept inside the window: beside a card's button it would cover the cards below.
function placement(anchor: HTMLElement): { left: string; top: string } {
  const rect = (anchor.closest<HTMLElement>('[data-board-card]') ?? anchor).getBoundingClientRect();
  const right = rect.right + GAP;
  const left =
    right + PANEL_WIDTH <= window.innerWidth ? right : Math.max(GAP, rect.left - GAP - PANEL_WIDTH);
  const top = Math.min(Math.max(GAP, rect.top), Math.max(GAP, window.innerHeight - 320));
  return { left: `${left}px`, top: `${top}px` };
}

/**
 * The agent's full question beside its card or sidebar row, answerable without
 * opening the task: a number picks a choice, the reply box sends a typed answer,
 * Tab moves to the next waiting question, O opens this one and Esc closes.
 */
export function PromptPeek() {
  let panel: HTMLDivElement | undefined;
  // Kept past closing: Escape hands focus back to it after the target is cleared.
  let anchor: HTMLElement | undefined;
  const popover = createPopover(
    () => target()?.anchor ?? anchor,
    () => panel,
  );
  createEffect(() => {
    anchor = target()?.anchor ?? anchor;
  });
  // After an answer the keyboard goes back where it was, unless the task opened.
  const close = (refocus: boolean) => {
    popover.setShown(false);
    if (refocus && anchor?.isConnected) anchor.focus();
  };
  createEffect(() => popover.setShown(target() !== null));
  createEffect(() => {
    if (!popover.open()) setTarget(null);
  });
  return (
    // Keyed: each task gets a fresh body, so a half-typed reply never follows Tab.
    // Portalled: the app shell's layout would otherwise pin the fixed panel to itself.
    <Show when={target()} keyed>
      {(t) => (
        <Portal>
          <div
            ref={panel}
            class="prompt-peek"
            role="dialog"
            tabIndex={-1}
            aria-label={`Question from ${store.tasks[t.taskId]?.name ?? 'task'}`}
            style={placement(t.anchor)}
          >
            <PeekBody target={t} onDone={close} />
          </div>
        </Portal>
      )}
    </Show>
  );
}

function PeekBody(props: { target: PeekTarget; onDone: (refocus: boolean) => void }) {
  let body: HTMLDivElement | undefined;
  // The parent is keyed on the target, so this body never sees another one.
  const target = untrack(() => props.target);
  const peek = createPromptPeek(() => target.agentId);
  const menu = () => peek()?.menu ?? null;
  const choices = () => menu()?.options.filter((o) => !o.typed) ?? [];
  const canReply = () => !!peek() && (!menu() || menu()?.options.some((o) => o.typed));
  const [text, setText] = createSignal('');
  const [error, setError] = createSignal('');
  // Focus lands once the first read shows what there is to focus.
  createEffect(
    on(
      () => peek() !== undefined,
      (loaded) => {
        if (!loaded) return;
        // Nothing to read (no terminal mirror): the task itself is the only place to answer.
        if (peek() === null) return openTask();
        queueMicrotask(() => {
          const reply = body?.querySelector<HTMLElement>('textarea');
          const first = body?.querySelector<HTMLElement>('button');
          ((target.reply && reply) || first || reply || body)?.focus();
        });
      },
    ),
  );
  const openTask = () => {
    props.onDone(false);
    jumpToWaitingTask(target.taskId, askingPanel(target.taskId));
  };
  // One action at a time: a second key before the agent redraws would still match.
  let busy = false;
  const run = async (action: () => Promise<boolean>) => {
    if (busy) return;
    busy = true;
    setError('');
    try {
      if ((await action()) === false) setError('The question changed. Look again.');
      else props.onDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
    }
  };
  const pick = (option: PromptMenuOption) => {
    const shown = menu();
    if (option.typed) body?.querySelector<HTMLElement>('textarea')?.focus();
    else if (shown) void run(() => pickPromptOption(target, shown, option));
  };
  const send = () => {
    const reply = text();
    const shown = menu();
    if (reply.trim()) void run(() => replyToPrompt({ target, menu: shown, text: reply }));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLTextAreaElement) return;
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    const option = menu()?.options.find((o) => String(o.n) === event.key);
    if (option) pick(option);
    // Shift+Tab stays the browser's, so focus can still move back inside the popup.
    else if (event.key === 'Tab' && !event.shiftKey) goNext(target);
    else if (event.key.toLowerCase() === 'o') openTask();
    else return;
    event.preventDefault();
  };
  return (
    <div ref={body} class="prompt-peek-body" tabIndex={-1} onKeyDown={onKeyDown}>
      <p class="prompt-peek-head">{store.tasks[target.taskId]?.name}</p>
      <Show when={peek()} fallback={<p class="prompt-peek-note">Reading…</p>}>
        <pre class="prompt-peek-text">{(menu()?.body ?? peek()?.tail ?? []).join('\n')}</pre>
      </Show>
      <Show when={choices().length > 0}>
        <ul class="prompt-peek-choices">
          <For each={choices()}>
            {(option) => (
              <li>
                <button type="button" title={option.detail} onClick={() => pick(option)}>
                  <kbd>{option.n}</kbd>
                  {answerLabel(option)}
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={canReply()}>
        <ReplyBox text={text()} setText={setText} onSend={send} />
      </Show>
      <p class="prompt-peek-error" role="alert">
        {error()}
      </p>
      <PeekKeys />
    </div>
  );
}

function goNext(current: PeekTarget): void {
  const next = nextWaitingTaskId(current.taskId);
  if (next) openPromptPeek(next, anchorFor(next, current.anchor));
}

function PeekKeys() {
  return (
    <p class="prompt-peek-foot">
      <span>
        <kbd>Tab</kbd> next question
      </span>
      <span>
        <kbd>O</kbd> open task
      </span>
      <span>
        <kbd>Esc</kbd> close
      </span>
    </p>
  );
}

function ReplyBox(props: { text: string; setText: (v: string) => void; onSend: () => void }) {
  return (
    <div class="prompt-peek-reply">
      <textarea
        class="prompt-peek-input"
        rows={2}
        placeholder="Type a reply, Enter sends"
        aria-label="Reply"
        value={props.text}
        onInput={(event) => props.setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
          event.preventDefault();
          props.onSend();
        }}
      />
      <button
        type="button"
        class="prompt-peek-send"
        disabled={!props.text.trim()}
        onClick={() => props.onSend()}
      >
        Send
      </button>
    </div>
  );
}
