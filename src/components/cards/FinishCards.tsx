import { For, Show, onMount } from 'solid-js';
import { BOTTOM_LINE_CARD_ID } from '../../lib/card-gallery';
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
 * The Bottom line card, when it is on, marked for Finish and filled: the dialog
 * shows it first, so the verdict is read before the merge options. Unfilled it
 * stays out, so six empty rows never push the merge options down.
 */
export function FinishBottomLine(props: { task: Task }) {
  const card = () =>
    props.task.cards?.[BOTTOM_LINE_CARD_ID]
      ? finishCards(props.task.projectId).find((entry) => entry.id === BOTTOM_LINE_CARD_ID)
      : undefined;
  const now = createNow();
  return (
    <Show when={card()}>
      {(card) => (
        <div class="finish-cards finish-bottom-line">
          <CardView card={card()} task={props.task} now={now()} />
        </div>
      )}
    </Show>
  );
}
