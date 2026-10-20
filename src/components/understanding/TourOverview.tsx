import { For } from 'solid-js';
import type { TourCard } from '../../lib/understanding-tour';

/**
 * Every card's title in reading order, like a deck's slide sorter. Titles are
 * claims, so the list reads as the tour's whole argument; picking one opens it.
 *
 * @param current zero-based index of the card on screen
 */
export function TourOverview(props: {
  cards: TourCard[];
  current: number;
  onSelect: (index: number) => void;
}) {
  return (
    <nav class="understanding-card understanding-overview" aria-label="Tour overview">
      <ol>
        <For each={props.cards}>
          {(card, index) => (
            <li>
              <button
                type="button"
                aria-current={index() === props.current ? 'step' : undefined}
                onClick={() => props.onSelect(index())}
              >
                <span class="understanding-card-label">{card.label}</span>
                <span class="understanding-overview-title">{card.title}</span>
              </button>
            </li>
          )}
        </For>
      </ol>
    </nav>
  );
}
