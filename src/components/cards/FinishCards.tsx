import { For, Show, createSignal, onMount } from 'solid-js';
import { BOTTOM_LINE_CARD_ID } from '../../lib/card-gallery';
import { errMessage } from '../../lib/log';
import { requestAgentCard } from '../../store/card-request';
import { showNotification } from '../../store/notification';
import { agentDraftBlocker } from '../../store/pr-draft';
import { enabledCards, runFinishCards, runFinishCheckCards } from '../../store/store';
import type { Task } from '../../store/types';
import { CardView } from './CardView';
import { createNow } from './CardsPopover';

/**
 * The task's cards marked "In the Finish dialog", open. Mounting fills the
 * Finish-triggered ones, model and check cards alike. Confidence keeps its own place in the review.
 */
export function FinishCards(props: { task: Task }) {
  const cards = () =>
    finishCards(props.task.projectId).filter((card) => card.id !== BOTTOM_LINE_CARD_ID);
  const now = createNow();
  onMount(() => {
    runFinishCards(props.task.id);
    void runFinishCheckCards(props.task.id);
  });
  return (
    <Show when={cards().length > 0}>
      <div class="finish-cards">
        <For each={cards()}>{(card) => <CardView card={card} task={props.task} now={now()} />}</For>
      </div>
    </Show>
  );
}

function finishCards(projectId: string) {
  return enabledCards(projectId).filter((card) => card.showAtFinish && !card.builtIn);
}

/**
 * The Bottom line card, when it is on and marked for Finish: the dialog shows it
 * first, so the verdict is read before the merge options. While the agent has not
 * filled it, a one-line offer to ask for it stands in, so empty rows never push
 * the merge options down.
 */
export function FinishBottomLine(props: { task: Task }) {
  const card = () =>
    finishCards(props.task.projectId).find((entry) => entry.id === BOTTOM_LINE_CARD_ID);
  const now = createNow();
  return (
    <Show when={card()}>
      {(card) => (
        <Show
          when={props.task.cards?.[BOTTOM_LINE_CARD_ID]}
          // Only the agent can fill an agent card; a user-edited model or check card fills itself.
          fallback={card().source.kind === 'agent' && <AskBottomLine task={props.task} />}
        >
          <div class="finish-cards finish-bottom-line">
            <CardView card={card()} task={props.task} now={now()} />
          </div>
        </Show>
      )}
    </Show>
  );
}

/** Asks the task's agent to fill the Bottom line; the card replaces this row once it does. */
function AskBottomLine(props: { task: Task }) {
  const [state, setState] = createSignal<'idle' | 'sending' | 'sent'>('idle');
  const blocker = () => agentDraftBlocker(props.task.id);
  const ask = async () => {
    if (blocker() || state() !== 'idle') return;
    setState('sending');
    try {
      await requestAgentCard(props.task.id, BOTTOM_LINE_CARD_ID);
      setState('sent');
    } catch (err) {
      setState('idle');
      showNotification(`Could not ask for the Bottom line: ${errMessage(err)}`);
    }
  };
  return (
    <div class="finish-bottom-line-ask">
      <div class="finish-followup finish-followup-quiet">
        <div class="change-tour-row">
          <button
            type="button"
            class="change-tour-action"
            disabled={!!blocker() || state() !== 'idle'}
            aria-busy={state() === 'sending'}
            title="Asks the agent to sum up what you need to know before finishing"
            onClick={() => void ask()}
          >
            <span class="change-tour-action-label">Ask the agent for the Bottom line</span>
          </button>
        </div>
      </div>
      {/* The line stays reserved so the merge options do not move as the agent goes busy and idle. */}
      <p role="status">
        {state() === 'sent'
          ? 'Asked. It appears here when the agent answers.'
          : blocker()
            ? `Can't ask yet: ${blocker()?.replace(/[.…]+$/, '')}.`
            : ''}
      </p>
    </div>
  );
}
