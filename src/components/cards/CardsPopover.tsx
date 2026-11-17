import { For, Show, createSignal, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { readCard, shownCards, type CardTaskState } from '../../lib/card-display';
import { createAnchorEffect, placeBelow } from '../../lib/floating';
import { theme } from '../../lib/theme';
import { sf } from '../../lib/fontScale';
import {
  cardTaskState,
  enabledCards,
  getModelCardRun,
  openSettingsTab,
  store,
  updateModelCards,
} from '../../store/store';
import type { CardDefinition } from '../../lib/cards';
import type { Task } from '../../store/types';
import { IconButton } from '../IconButton';
import { SyncIcon } from '../icons';
import { CardView, inRunOn } from './CardView';
import './cards.css';

const POPOVER_WIDTH = 480;

export interface CardsPanelProps {
  task: Task;
  onWalkThrough?: () => void;
  walkThroughDisabled?: boolean;
}

function needsAttention(state: CardTaskState, card: CardDefinition): boolean {
  return readCard(card, state, store.briefModel).urgent;
}

/**
 * The enabled cards the task shows, the ones needing attention first. Returns the store's
 * own card objects, so <For> keeps each CardView as values change.
 */
function orderedCards(task: Task): CardDefinition[] {
  const state = cardTaskState(task);
  const cards = shownCards(enabledCards(task.projectId), state, inRunOn(task));
  const urgent = cards.filter((card) => needsAttention(state, card));
  return [...urgent, ...cards.filter((card) => !urgent.includes(card))];
}

/** The current time, ticking every 30s, so the cards' ages stay current while shown. */
export function createNow(): () => number {
  const [now, setNow] = createSignal(Date.now());
  const ticker = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(ticker));
  return now;
}

interface UpdateCardsButtonProps {
  task: Task;
  cards: CardDefinition[];
  /** An icon alone, for the pane's heading, where it sits beside the Edit cards pencil. */
  iconOnly?: boolean;
}

/** Runs every model card of the task now; nothing without one. */
export function UpdateCardsButton(props: UpdateCardsButtonProps) {
  const models = () => props.cards.filter((card) => card.source.kind === 'model');
  const updating = () => models().some((card) => getModelCardRun(props.task.id, card.id).running);
  const update = () => updateModelCards(props.task.id);
  return (
    <Show when={models().length}>
      <Show
        when={props.iconOnly}
        fallback={
          <button
            type="button"
            class="cards-btn btn-secondary"
            disabled={updating()}
            onClick={update}
          >
            Update now
          </button>
        }
      >
        <IconButton
          icon={<SyncIcon size={12} />}
          title="Update now"
          disabled={updating()}
          onClick={update}
        />
      </Show>
    </Show>
  );
}

/** Everything the task's cards say, then routine actions. */
function CardsPanel(props: CardsPanelProps & { onClose: () => void }) {
  const now = createNow();
  const cards = () => orderedCards(props.task);
  const models = () => cards().filter((card) => card.source.kind === 'model');
  const footNote = () => {
    if (cards().length < 2) return '';
    const count = models().length;
    return count ? `${cards().length} cards · ${count} use a model` : `${cards().length} cards`;
  };

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column' }}>
      <div
        style={{
          padding: '14px 16px 12px',
          display: 'flex',
          'flex-direction': 'column',
          gap: '8px',
        }}
      >
        <span style={{ 'font-size': sf(14), 'font-weight': '600' }}>{props.task.name}</span>
      </div>
      <Show
        when={cards().length > 0}
        fallback={<p class="cards-pane-empty">Cards fill in as you work</p>}
      >
        <div style={{ 'border-top': `1px solid ${theme.borderSubtle}` }}>
          <For each={cards()}>
            {(card) => <CardView card={card} task={props.task} now={now()} />}
          </For>
        </div>
      </Show>
      <div class="cards-foot">
        <span class="cards-foot-note">{footNote()}</span>
        {/* Stays open, so the cards can be watched updating. */}
        {/* Every enabled card, as in the pane: a model card hidden until it has values still updates. */}
        <UpdateCardsButton task={props.task} cards={enabledCards(props.task.projectId)} />
        <Show when={props.onWalkThrough}>
          {(walk) => (
            <button
              type="button"
              class="cards-btn btn-secondary"
              disabled={props.walkThroughDisabled}
              onClick={() => {
                props.onClose();
                walk()();
              }}
            >
              Walk me through
            </button>
          )}
        </Show>
        <button
          type="button"
          class="cards-btn btn-secondary"
          onClick={() => {
            props.onClose();
            openSettingsTab('cards');
          }}
        >
          Edit cards
        </button>
      </div>
    </div>
  );
}

interface CardsPopoverProps extends CardsPanelProps {
  open: boolean;
  anchor: () => HTMLElement | undefined;
  panelRef: (el: HTMLDivElement) => void;
  onClose: () => void;
}

/** The task's cards below the line or control that opened them, right-aligned with it. */
export function CardsPopover(props: CardsPopoverProps) {
  const [place, setPlace] = createSignal({ top: 0, right: 0, maxHeight: 400 });
  const width = () => Math.min(POPOVER_WIDTH, window.innerWidth - 24);
  createAnchorEffect(
    () => props.open,
    () => {
      const rect = props.anchor()?.getBoundingClientRect();
      if (!rect) return;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      setPlace(placeBelow(rect, width(), viewport));
    },
  );
  return (
    <Show when={props.open}>
      <Portal>
        <div
          ref={props.panelRef}
          role="dialog"
          aria-label="Task cards"
          class="cards-popover"
          onClick={(e) => e.stopPropagation()}
          style={{
            top: `${place().top}px`,
            right: `${place().right}px`,
            width: `${width()}px`,
            'max-height': `${place().maxHeight}px`,
            color: theme.fg,
          }}
        >
          <CardsPanel {...props} />
        </div>
      </Portal>
    </Show>
  );
}
