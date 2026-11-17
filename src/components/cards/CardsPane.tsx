import { For, type JSX } from 'solid-js';
import { shownCards } from '../../lib/card-display';
import { cardTaskState, enabledCards, openSettingsTab } from '../../store/store';
import type { Task } from '../../store/types';
import { sf } from '../../lib/fontScale';
import { IconButton } from '../IconButton';
import { PencilIcon } from '../icons';
import { CardView, inRunOn } from './CardView';
import { UpdateCardsButton, createNow } from './CardsPopover';
import './cards.css';

/** The pane's frame: its heading with the actions, then the cards. The card editor's preview draws the same one. */
export function CardsPaneFrame(props: { actions: JSX.Element; children: JSX.Element }) {
  return (
    <section class="cards-pane" aria-label="Cards">
      {/* Headed like Notes and Changed files beside it; the actions sit in the heading, so they stay in reach while the cards scroll. */}
      <div class="task-pane-heading" style={{ 'font-size': sf(11) }}>
        Cards
        <span class="cards-pane-actions">{props.actions}</span>
      </div>
      <div class="cards-pane-list">{props.children}</div>
    </section>
  );
}

/**
 * The task's cards, edge to edge like the panes below them: the split view's pane above the changed
 * files, where the stacked view has its card line and popover instead.
 */
export function CardsPane(props: { task: Task }) {
  const now = createNow();
  // Display order, not urgency first as in the popover: a pane that stays on
  // screen must not reshuffle as values change.
  const cards = () => enabledCards(props.task.projectId);
  const shown = () => shownCards(cards(), cardTaskState(props.task), inRunOn(props.task));
  return (
    <CardsPaneFrame
      actions={
        <>
          <UpdateCardsButton task={props.task} cards={cards()} iconOnly />
          <IconButton
            icon={<PencilIcon size={12} />}
            title="Edit cards"
            onClick={() => openSettingsTab('cards')}
          />
        </>
      }
    >
      {/* Only an unrated Confidence card or cards set to hide until they have values can leave the list empty. */}
      <For each={shown()} fallback={<p class="cards-pane-empty">Cards fill in as you work</p>}>
        {(card) => <CardView card={card} task={props.task} now={now()} />}
      </For>
    </CardsPaneFrame>
  );
}
