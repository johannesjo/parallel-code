import { Show } from 'solid-js';
import { answerCardChange, waitingCardChanges } from '../../store/store';
import './cards.css';

/**
 * The one click a card change from an agent waits for when it switches on an
 * AI card, gives a running one another model or more to send, or deletes
 * values tasks hold. One at a time, the oldest first.
 */
export function CardChangeRequest() {
  const more = () => waitingCardChanges().length - 1;
  return (
    <Show when={waitingCardChanges()[0]}>
      {(waiting) => (
        <div class="cards-offer" role="region" aria-label="An agent asks to change a card">
          <strong>An agent asks to change a card</strong>
          <span>
            "{waiting().asker}" wants to {waiting().change}.
          </span>
          <Show when={more() > 0}>
            <span>{more()} more waiting.</span>
          </Show>
          <div class="cards-offer-actions">
            <button
              type="button"
              class="btn-secondary"
              onClick={() => answerCardChange(waiting().cardId, false)}
            >
              Dismiss
            </button>
            <button
              type="button"
              class="btn-primary"
              onClick={() => answerCardChange(waiting().cardId, true)}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </Show>
  );
}
