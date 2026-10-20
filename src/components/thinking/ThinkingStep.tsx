import { For, Show, onMount } from 'solid-js';
import type { CardProposal } from '../../lib/create-card-writer';
import type { TourNode } from '../../lib/tour-tree';
import type { TourCard as TourCardData } from '../../lib/understanding-tour';
import { TourCard } from '../understanding/TourCard';
import { ThinkingCard, type ThinkingAction } from './ThinkingCard';
import './thinking.css';

/**
 * The card on screen in a tour the reader writes, between two lines that are
 * always laid out so the card never moves: above, what it follows up on;
 * below, how many follow-ups it has. The agent's proposal for it takes the
 * card's place until it is taken or left.
 */
export function ThinkingStep(props: {
  node: TourNode;
  parent?: TourNode;
  editing: boolean;
  focus: 'title' | 'body';
  writing: boolean;
  proposal?: CardProposal;
  error: string;
  onChange: (card: TourCardData) => void;
  onAction: (action: ThinkingAction) => void;
  onEdit: () => void;
  onLeave: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const position = () => {
    const siblings = props.parent?.children ?? [];
    const index = siblings.findIndex((child) => child.id === props.node.id);
    return index < 0 ? '' : `${index + 1} of ${siblings.length}`;
  };
  const followUps = () => props.node.children.length;

  return (
    <div class="thinking-step">
      <p class="understanding-crumb">
        <Show when={props.parent}>
          {(above) => (
            <button type="button" title="Back to it · ↑" onClick={() => props.onLeave()}>
              ↑ Follow-up to {above().card.title || 'an untitled card'} · {position()}
            </button>
          )}
        </Show>
      </p>
      <Show
        when={props.proposal}
        fallback={
          <ThinkingCard
            card={props.node.card}
            editing={props.editing}
            focus={props.focus}
            onChange={props.onChange}
            onAction={props.onAction}
            onEdit={props.onEdit}
          />
        }
      >
        {(proposal) => (
          <Proposal cards={proposal().cards} onAccept={props.onAccept} onReject={props.onReject} />
        )}
      </Show>
      <p class="thinking-branch">
        <span style={{ visibility: followUps() > 0 ? 'visible' : 'hidden' }}>
          ↳ {followUps()} follow-up{followUps() === 1 ? '' : 's'} to this card · ↓ to read them
        </span>
        <Show when={props.writing}>
          <span role="status" class="thinking-status">
            <span class="inline-spinner" aria-hidden="true" /> Writing card…
          </span>
        </Show>
        <Show when={props.error}>
          <span role="alert" class="understanding-alert">
            {props.error}
          </span>
        </Show>
      </p>
    </div>
  );
}

/**
 * The agent's card in a dashed frame, so it never reads as the reader's own
 * yet. Enter takes it and Escape keeps the notes; focus sits on the frame so
 * the keys reach it straight away.
 */
function Proposal(props: { cards: TourCardData[]; onAccept: () => void; onReject: () => void }) {
  let frame: HTMLDivElement | undefined;
  const first = () => props.cards[0];
  const rest = () => props.cards.slice(1);
  onMount(() => frame?.focus());
  return (
    <div
      ref={frame}
      class="thinking-proposal"
      tabIndex={-1}
      role="group"
      aria-label="Proposed card"
      on:keydown={(event) => {
        // Enter on a button inside presses that button instead.
        const onFrame = event.target === event.currentTarget;
        if (event.key !== 'Escape' && !(event.key === 'Enter' && onFrame)) return;
        // Escape here keeps the notes; it must not close the dialog.
        event.stopPropagation();
        event.preventDefault();
        if (event.key === 'Enter') props.onAccept();
        else props.onReject();
      }}
    >
      <Show when={first()}>{(card) => <TourCard card={card()} />}</Show>
      <Show when={rest().length > 0}>
        <ul class="thinking-proposal-rest" aria-label="Proposed follow-ups">
          <For each={rest()}>{(card) => <li>↳ {card.title}</li>}</For>
        </ul>
      </Show>
      <div class="thinking-proposal-actions">
        <button type="button" class="thinking-proposal-use" onClick={() => props.onAccept()}>
          Use card <kbd>Enter</kbd>
        </button>
        <button type="button" onClick={() => props.onReject()}>
          Keep my notes <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
}
