import { Show, onMount } from 'solid-js';
import { readCard } from '../../lib/card-display';
import { cardTaskState, enabledCards, store } from '../../store/store';
import type { Task } from '../../store/types';
import { createPopover } from '../create-popover';
import { DisclosureChevronIcon } from '../icons';
import { CardsPopover } from './CardsPopover';
import { revealCard } from './flash';
import './cards.css';

/** Lets the pin row open the popover on one card. */
export interface CardLineHandle {
  openCard: (cardId: string) => void;
}

interface CardLineProps {
  task: Task;
  onHandle?: (handle: CardLineHandle) => void;
  onWalkThrough?: () => void;
  walkThroughDisabled?: boolean;
}

/** What the line names: the card needing attention, else the first one with values. */
export function lineCard(task: Task): { name: string; text: string; urgent: boolean } | undefined {
  const state = cardTaskState(task);
  const entries = enabledCards(task.projectId)
    .map((card) => ({ card, reading: readCard(card, state, store.briefModel) }))
    .filter((entry) => entry.reading.at !== undefined);
  const pick = entries.find((entry) => entry.reading.urgent) ?? entries[0];
  if (!pick) return undefined;
  return { name: pick.card.name, text: pick.reading.summary, urgent: pick.reading.urgent };
}

function useCardsPopover() {
  let anchor: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  const popover = createPopover(
    () => anchor,
    () => panel,
  );
  return {
    popover,
    setAnchor: (el: HTMLButtonElement) => (anchor = el),
    anchor: () => anchor,
    panel: () => panel,
    setPanel: (el: HTMLDivElement) => (panel = el),
  };
}

/**
 * The line under the title while cards are on: one card's summary at a fixed height, opening every card in a popover.
 */
export function CardLine(props: CardLineProps) {
  const { popover, setAnchor, anchor, panel, setPanel } = useCardsPopover();
  const line = () => lineCard(props.task);
  onMount(() =>
    props.onHandle?.({
      openCard: (cardId) => {
        popover.setShown(true);
        // Once the popover has placed itself and focused its first button.
        requestAnimationFrame(() => revealCard(panel(), cardId));
      },
    }),
  );
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        class="card-line"
        aria-haspopup="dialog"
        aria-expanded={popover.open()}
        onClick={(e) => {
          e.stopPropagation();
          popover.setShown(!popover.open());
        }}
      >
        <Show
          when={line()}
          fallback={<span class="card-line-text card-line-empty">Cards fill in as you work</span>}
        >
          {(l) => (
            <>
              <span class="card-line-label" data-urgent={l().urgent ? '' : undefined}>
                {l().name}
              </span>
              <span class="card-line-text">{l().text}</span>
            </>
          )}
        </Show>
        <DisclosureChevronIcon size={14} class="card-line-chevron" />
      </button>
      <CardsPopover
        task={props.task}
        open={popover.open()}
        anchor={anchor}
        panelRef={setPanel}
        onClose={() => popover.setShown(false)}
        onWalkThrough={props.onWalkThrough}
        walkThroughDisabled={props.walkThroughDisabled}
      />
    </>
  );
}
