import { For, Show } from 'solid-js';
import { pinnableSlots, type CardDefinition } from '../../../lib/cards';

interface CardBarPinsProps {
  card: CardDefinition;
  onSummary: (on: boolean) => void;
  onSlot: (slotId: string, on: boolean) => void;
}

/**
 * What a card shows in the bar below the task title: its summary, single
 * values, or both. One set of checkboxes, the same in the card list and the
 * editor, so the bar is set in one way wherever it is set.
 */
export function CardBarPins(props: CardBarPinsProps) {
  return (
    <>
      {/* Confidence pins its scores only; it has no summary of its own in the bar. */}
      <Show when={!props.card.builtIn}>
        <label title="The card's name and the one-line summary its closed card shows">
          <input
            type="checkbox"
            checked={props.card.mini ?? false}
            onChange={(e) => props.onSummary(e.currentTarget.checked)}
          />
          Card summary
        </label>
      </Show>
      <For each={pinnableSlots(props.card)}>
        {(slot) => (
          <label>
            <input
              type="checkbox"
              checked={props.card.pinned?.includes(slot.id) ?? false}
              onChange={(e) => props.onSlot(slot.id, e.currentTarget.checked)}
            />
            {slot.label}
          </label>
        )}
      </For>
    </>
  );
}
