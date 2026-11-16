import { For, Show, onMount } from 'solid-js';
import { enabledCards, runFinishCards } from '../../store/store';
import type { Task } from '../../store/types';
import { CardView } from './CardView';
import { createNow } from './CardsPopover';

/**
 * The task's cards marked "In the Finish dialog", open. Mounting fills the
 * Finish-triggered ones. Confidence keeps its own place in the review.
 */
export function FinishCards(props: { task: Task }) {
  const cards = () =>
    enabledCards(props.task.projectId).filter((card) => card.showAtFinish && !card.builtIn);
  const now = createNow();
  onMount(() => runFinishCards(props.task.id));
  return (
    <Show when={cards().length > 0}>
      <div class="finish-cards">
        <For each={cards()}>
          {(card) => <CardView card={card} task={props.task} expanded now={now()} />}
        </For>
      </div>
    </Show>
  );
}
