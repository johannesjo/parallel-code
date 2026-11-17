import { For, Show, createSignal, onCleanup } from 'solid-js';
import { pinGroups, type PinGroup } from '../../lib/card-display';
import { cardTaskState, enabledCards } from '../../store/store';
import type { Task } from '../../store/types';
import './cards.css';

/**
 * The pin row: mini views and pinned slots of the task's cards, as neutral text. Its height
 * is fixed and it shows by settings, except that Confidence waits for a rating; otherwise a
 * value only changes its text.
 */
export function PinRow(props: { task: Task; onOpenCard?: (cardId: string) => void }) {
  // Keeps relative times ("Last prompt 3 min ago") current, as the popover does.
  const [now, setNow] = createSignal(Date.now());
  const ticker = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(ticker));
  const groups = () =>
    pinGroups(enabledCards(props.task.projectId), cardTaskState(props.task, now()));
  return <PinGroups groups={groups()} label="Pinned card values" onOpen={props.onOpenCard} />;
}

/** One card's pins as neutral text. */
function Pins(props: { group: PinGroup }) {
  return (
    <For each={props.group.pins}>
      {(pin) => (
        <span
          class="pin"
          data-warn={pin.warn ? '' : undefined}
          data-faded={pin.faded ? '' : undefined}
          data-empty={pin.text === '–' ? '' : undefined}
          data-mini={pin.mini ? '' : undefined}
          // A mini view truncates; the tooltip reads the whole summary.
          title={pin.mini ? pin.text : undefined}
        >
          {pin.label ? `${pin.label} ` : ''}
          <b>{pin.text}</b>
        </span>
      )}
    </For>
  );
}

/**
 * Pin groups as the pin row draws them; the card editor's preview reuses it without `onOpen`,
 * since its buttons are drawn, not wired. With `onOpen`, each card's pins open that card.
 */
export function PinGroups(props: {
  groups: PinGroup[];
  label: string;
  onOpen?: (cardId: string) => void;
}) {
  return (
    <div class="pin-row" role="group" aria-label={props.label}>
      <For each={props.groups}>
        {(group, index) => (
          <>
            <Show when={index() > 0}>
              <span class="pin-sep" aria-hidden="true" />
            </Show>
            <Show
              when={props.onOpen}
              fallback={
                <span class="pin-group" title={group.card.name}>
                  <Pins group={group} />
                </span>
              }
            >
              {(open) => (
                <button
                  type="button"
                  class="pin-group"
                  title={`${group.card.name}: open the card`}
                  onClick={(event) => {
                    // As the card line does: activating the task would run its focus effects and pull focus off the card.
                    event.stopPropagation();
                    open()(group.card.id);
                  }}
                >
                  <Pins group={group} />
                </button>
              )}
            </Show>
          </>
        )}
      </For>
    </div>
  );
}
