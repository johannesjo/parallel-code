import { For, Show, createEffect, createSignal, on } from 'solid-js';
import { getDeepActiveElement } from '../../lib/dom-focus';
import type {
  ChatDecision,
  ChatQuestion,
  ChatRequest,
} from '../../../electron/shared/agent-chat-types';
import { CheckIcon, CloseIcon, SendIcon } from '../icons';

export type RespondToRequest = (
  request: ChatRequest,
  decision: ChatDecision,
  answers: Record<string, string>,
) => Promise<void>;

/**
 * Whether the user has words in flight here. Focusing the composer is how the app
 * hands a chat panel the keyboard, so a focused *empty* composer means "waiting",
 * not "typing" — only unsent text is worth protecting the caret for.
 */
const holdsUnsentText = (node: Element | null): boolean => {
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement)
    return node.value.trim() !== '';
  return node instanceof HTMLElement && node.isContentEditable && !!node.textContent?.trim();
};

const modalOpen = () => !!document.querySelector('[aria-modal="true"]');

// Modified keys belong to the app, e.g. Alt+Arrow switches panes.
const modified = (event: KeyboardEvent) =>
  event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;

const NEXT_KEYS = new Set(['ArrowDown', 'ArrowRight']);
const PREVIOUS_KEYS = new Set(['ArrowUp', 'ArrowLeft']);

/**
 * Gives the keyboard to a request card's default choice so Enter alone answers it.
 * Questions have nothing safe to preselect, so they start on their first control.
 * Returns whether the card now holds focus.
 */
export function focusRequestCard(card: Element | null | undefined): boolean {
  if (!card) return false;
  (
    card.querySelector<HTMLElement>('.chat-request-default') ??
    card.querySelector<HTMLElement>('button, input')
  )?.focus();
  return card.contains(getDeepActiveElement());
}

/**
 * One pending approval or question from the agent, answerable from the keyboard:
 * the card opens on its default choice so Enter alone resolves it.
 */
export function RequestCard(props: {
  agentName: string;
  request: ChatRequest;
  respond: RespondToRequest;
  /** The user is looking at this chat and this is the request they should answer first. */
  autoFocus: boolean;
  onResolved: () => void;
}) {
  // Options and typed text are kept apart, so a click never writes into the text field.
  const [selected, setSelected] = createSignal<Record<string, string[]>>({});
  const [typed, setTyped] = createSignal<Record<string, string>>({});
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal('');
  let card: HTMLElement | undefined;
  const allowIsDefault = () => props.request.kind === 'approval' && !props.request.defaultToNo;
  // Only an approval can be remembered; an answer to a question is not a permission.
  const canRemember = () =>
    props.request.kind === 'approval' && props.request.canAlwaysAllow === true;
  // Open the card on the choice the user most likely wants so Enter alone answers it.
  createEffect(
    on(
      () => props.autoFocus,
      (autoFocus) => {
        if (!autoFocus || modalOpen()) return;
        const active = getDeepActiveElement();
        // Focus elsewhere in the app (a dialog, another panel) belongs to that place.
        if (active && active !== document.body && !card?.closest('.chat-ui')?.contains(active))
          return;
        // Never pull the caret out of a half-written message — Enter there means "send
        // my message" — and never re-grab focus this card already holds.
        if (card?.contains(active) || holdsUnsentText(active)) return;
        focusRequestCard(card);
      },
    ),
  );
  async function submit(decision: ChatDecision) {
    if (pending()) return;
    const element = card;
    const heldFocus = !!element?.contains(getDeepActiveElement());
    setPending(true);
    setError('');
    try {
      await props.respond(props.request, decision, answers());
      // The state notification may remove the card before the IPC response arrives,
      // which leaves focus on the body rather than on anything the user chose.
      const active = getDeepActiveElement();
      if (
        heldFocus &&
        !modalOpen() &&
        (element?.contains(active) || active === document.body || active === null)
      )
        props.onResolved();
    } catch (error) {
      setError(String(error));
    } finally {
      setPending(false);
    }
  }
  /** A single choice is an option or typed text, never both; a multi-select adds any
   *  typed text to the options it ticks. Typed text goes out as entered: a secret's
   *  spaces may be part of it. */
  const answerTo = (q: ChatQuestion) =>
    [...(selected()[q.id] ?? []), typed()[q.id] ?? ''].filter((part) => part.trim()).join(', ');
  const answers = () =>
    Object.fromEntries((props.request.questions ?? []).map((q) => [q.id, answerTo(q)]));
  const isPicked = (q: ChatQuestion, label: string) => (selected()[q.id] ?? []).includes(label);
  const pick = (q: ChatQuestion, label: string) => {
    const previous = selected()[q.id] ?? [];
    const next = !q.multiSelect
      ? [label]
      : previous.includes(label)
        ? previous.filter((entry) => entry !== label)
        : [...previous, label];
    setSelected({ ...selected(), [q.id]: next });
    if (!q.multiSelect) setTyped({ ...typed(), [q.id]: '' });
  };
  const type = (q: ChatQuestion, text: string) => {
    setTyped({ ...typed(), [q.id]: text });
    if (!q.multiSelect) setSelected({ ...selected(), [q.id]: [] });
  };
  const hint = () => {
    const choices = props.request.questions?.filter((q) => q.options.length) ?? [];
    if (choices.some((q) => !q.multiSelect)) return 'Arrow keys move, Enter chooses';
    if (choices.length) return 'Arrow keys move, Enter toggles';
    if (props.request.kind === 'question') return '';
    return allowIsDefault() ? 'Enter allows once' : 'Enter declines';
  };
  /** Arrow keys walk the card's choices like a menu; text inputs keep them for the caret. */
  const moveFocus = (event: KeyboardEvent) => {
    const step = NEXT_KEYS.has(event.key) ? 1 : PREVIOUS_KEYS.has(event.key) ? -1 : 0;
    if (!step || modified(event) || !(event.target instanceof HTMLButtonElement) || !card) return;
    const choices = [
      ...card.querySelectorAll<HTMLButtonElement>('.chat-options button:not(:disabled)'),
    ];
    const at = choices.indexOf(event.target);
    if (at < 0) return;
    event.preventDefault();
    choices[(at + step + choices.length) % choices.length]?.focus();
  };
  /** Enter on a single choice answers its question, then moves on to the next open
   *  question, or sends the answers once none is left — one keystroke per question. */
  const choose = (q: ChatQuestion, label: string) => {
    pick(q, label);
    const open = (props.request.questions ?? []).findIndex((other) => !answerTo(other));
    if (open < 0) return void submit('accept');
    card
      ?.querySelectorAll('.chat-request-question')
      [open]?.querySelector<HTMLElement>('button, input')
      ?.focus();
  };
  return (
    <section
      class="chat-request"
      data-default={props.request.defaultToNo ? 'decline' : 'allow'}
      aria-label={`${props.agentName} request`}
      ref={card}
      onKeyDown={moveFocus}
    >
      <strong>
        {props.request.kind === 'question'
          ? `${props.agentName} needs your input`
          : // Naming the action still has to read as a gate, not as a status line.
            `Approval needed${props.request.action ? `: ${props.request.action}` : ''}`}
      </strong>
      <Show when={props.request.kind === 'approval'}>
        <p class="chat-request-text">{props.request.text}</p>
        <Show when={props.request.details}>
          <details class="chat-request-details">
            <summary>Details</summary>
            <pre>{props.request.details}</pre>
          </details>
        </Show>
      </Show>
      <For each={props.request.questions}>
        {(q) => (
          // Not a <label>: a label forwards a click on its text to the first option.
          <div class="chat-request-question" role="group" aria-label={q.question}>
            {q.question}
            <div class="chat-options">
              <For each={q.options}>
                {(option) => (
                  <button
                    disabled={pending()}
                    aria-pressed={isPicked(q, option.label)}
                    // A click only marks the choice, so a stray click or tap never sends.
                    onClick={() => pick(q, option.label)}
                    // A multi-select keeps native Enter: it toggles and waits for more.
                    onKeyDown={(event) => {
                      if (q.multiSelect || event.key !== 'Enter' || modified(event)) return;
                      event.preventDefault();
                      // A held Enter would otherwise answer every question with its first option.
                      if (!event.repeat) choose(q, option.label);
                    }}
                  >
                    {option.label}
                    <Show when={option.description}>
                      <span class="chat-option-description">{option.description}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
            <input
              aria-label={q.question}
              placeholder={
                !q.options.length
                  ? 'Your answer'
                  : q.multiSelect
                    ? 'Add your own answer'
                    : 'Or type your own answer'
              }
              type={q.isSecret ? 'password' : 'text'}
              value={typed()[q.id] ?? ''}
              onInput={(event) => type(q, event.currentTarget.value)}
            />
          </div>
        )}
      </For>
      <div class="chat-options">
        <button
          class={allowIsDefault() ? 'chat-request-default btn-with-icon' : 'btn-with-icon'}
          disabled={pending() || props.request.questions?.some((q) => !answerTo(q))}
          onClick={() => void submit('accept')}
        >
          <Show when={props.request.kind === 'question'} fallback={<CheckIcon size={14} />}>
            <SendIcon size={14} />
          </Show>
          {props.request.kind === 'question' ? 'Submit answers' : 'Allow once'}
        </button>
        <Show when={canRemember()}>
          <button
            class="btn-with-icon"
            disabled={pending()}
            title={props.request.alwaysAllowNote}
            onClick={() => void submit('accept-always')}
          >
            <CheckIcon size={14} />
            Always allow
          </button>
        </Show>
        <Show when={props.request.kind === 'approval'}>
          <button
            class={
              props.request.defaultToNo ? 'chat-request-default btn-with-icon' : 'btn-with-icon'
            }
            disabled={pending()}
            onClick={() => void submit('decline')}
          >
            <CloseIcon size={14} />
            Decline
          </button>
        </Show>
      </div>
      <Show when={canRemember() && props.request.alwaysAllowNote}>
        {/* Said out loud, not hidden in a tooltip: remembering can outlive the session. */}
        <p class="chat-request-note">Always allow will {props.request.alwaysAllowNote}.</p>
      </Show>
      <Show when={hint()}>
        <p class="chat-request-hint">{hint()}</p>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </section>
  );
}
