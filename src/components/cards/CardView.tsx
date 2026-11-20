import { For, Show, type JSX } from 'solid-js';
import {
  readCard,
  shownSlots,
  showsSlotLabel,
  valueFor,
  type CardReading,
} from '../../lib/card-display';
import type { CardDefinition } from '../../lib/cards';
import { formatRelativeAge } from '../../lib/relativeAge';
import { cardTaskState, getCheckCardRun, getModelCardRun, store } from '../../store/store';
import type { Task } from '../../store/types';
import { CardSlot } from './CardSlot';
import { CheckCardActions } from './CheckCardActions';
import { ModelCardActions } from './ModelCardActions';

interface CardViewProps {
  card: CardDefinition;
  task: Task;
  /** Keeps the age current while the card is shown. */
  now: number;
}

/**
 * The right end of a card's top line: "Sonnet · 4m". Who fills the card rarely
 * changes, so with a pointer it waits in a popover beside the age (see cards.css);
 * on touch screens it stays inline. Still part of the text, so it is read aloud.
 */
export function CardMetaText(props: { source?: string; state: string }) {
  return (
    <span class="card-meta-text">
      <Show when={props.source}>
        <span class="card-meta-source">
          {props.source}
          <span class="card-meta-dot"> · </span>
        </span>
      </Show>
      <span class="card-meta-state">{props.state}</span>
    </span>
  );
}

/** "Sonnet · 4m", "Sonnet · outdated · 2h" or what fills it: the right end of the top line. */
function MetaText(props: { card: CardDefinition; reading: CardReading; now: number }) {
  const state = () => {
    if (props.reading.at === undefined) return props.reading.pending;
    const age = formatRelativeAge(props.reading.at, props.now);
    return props.reading.outdated ? `outdated · ${age}` : age;
  };
  // The app fills its own cards from what it already knows; naming it says nothing.
  const source = () => (props.card.source.kind === 'app' ? undefined : props.reading.source);
  return <CardMetaText source={source()} state={state()} />;
}

interface RunState {
  running?: boolean;
  error?: string;
  changed?: boolean;
}

/** A check or model card's run, while it is going or after it failed; else nothing. */
function cardRun(card: CardDefinition, task: Task): { state: RunState; label: string } | undefined {
  if (card.source.kind === 'check')
    return { state: getCheckCardRun(task.id, card.id), label: 'running' };
  if (card.source.kind === 'model')
    return { state: getModelCardRun(task.id, card.id), label: 'updating' };
  return undefined;
}

/** Whether a card's run on `task` is going or failed, which the card shows even before it has values. */
export function inRunOn(task: Task): (card: CardDefinition) => boolean {
  return (card) => {
    const state = cardRun(card, task)?.state;
    return !!state && (!!state.running || !!state.error);
  };
}

/** A run's state, which replaces the age while it matters. */
function RunMeta(props: { run: RunState; label: string; fallback: JSX.Element }) {
  const run = () => props.run;
  return (
    <Show
      when={!run().running}
      fallback={
        <span>
          <span class="status-glyph-spinner card-spinner" aria-hidden="true" /> {props.label}
        </span>
      }
    >
      {/* The message itself waits in the body (`RunError`): cut off here it could not be read. */}
      <Show
        when={run().error}
        fallback={run().changed ? 'code changed during the run' : props.fallback}
      >
        <span class="card-error">failed</span>
      </Show>
    </Show>
  );
}

/**
 * A failed run's message in full, wrapping, so keyboard and touch users can read it too. Last in
 * the card, so it coming and going moves nothing above it; gone while a re-run is going.
 */
function RunError(props: { card: CardDefinition; task: Task }) {
  const error = () => {
    const state = cardRun(props.card, props.task)?.state;
    return state && !state.running ? state.error : undefined;
  };
  return (
    <Show when={error()}>{(error) => <p class="card-error card-error-detail">{error()}</p>}</Show>
  );
}

/**
 * One card in the popover, the cards pane or Finish: a quiet top line, then each slot in its final
 * layout. Always open: the pin row already is the compact view, so folding cards only hid what the
 * user came to read.
 */
export function CardView(props: CardViewProps) {
  const state = () => cardTaskState(props.task, props.now);
  const reading = () => readCard(props.card, state(), store.briefModel);
  const confidence = () => props.card.builtIn === 'confidence';
  // Plan's own labels (Goal, Steps) already head it; a "Plan" title above them only repeats.
  // With one slot shown, its label hides (`showsSlotLabel`), so the name stays as the heading.
  const plan = () => props.card.source.kind === 'app' && props.card.source.fact === 'plan';
  const unnamed = () => confidence() || (plan() && shownSlots(props.card).length > 1);
  return (
    <section
      class="card"
      classList={{ 'card-confidence': confidence(), 'card-unnamed': unnamed() && !confidence() }}
      aria-label={props.card.name}
      data-card-id={props.card.id}
      // Focusable by script only: a pinned value opens its card here (`revealCard`).
      tabindex="-1"
      data-outdated={reading().outdated ? '' : undefined}
    >
      <div class="card-head">
        {/* Confidence goes unnamed too: its scores already say what it is. */}
        <Show when={!unnamed()}>
          <span class="card-name">{props.card.name}</span>
        </Show>
        <span class="card-meta">
          <Show
            when={cardRun(props.card, props.task)}
            fallback={<MetaText card={props.card} reading={reading()} now={props.now} />}
          >
            {(run) => (
              <RunMeta
                run={run().state}
                label={run().label}
                fallback={<MetaText card={props.card} reading={reading()} now={props.now} />}
              />
            )}
          </Show>
        </span>
      </div>
      <div class="card-body">
        <Show
          when={!confidence() || state().cards?.[props.card.id]}
          fallback={
            <p class="card-empty">Ask the agent to rate its confidence, or review at Finish.</p>
          }
        >
          <For each={shownSlots(props.card)}>
            {(slot) => (
              <CardSlot
                slot={slot}
                value={valueFor(slot, state().cards?.[props.card.id])}
                showLabel={showsSlotLabel(props.card, slot)}
              />
            )}
          </For>
        </Show>
        <Show when={props.card.source.kind === 'check'}>
          <CheckCardActions card={props.card} task={props.task} />
        </Show>
        <Show when={props.card.source.kind === 'model'}>
          <ModelCardActions card={props.card} task={props.task} />
        </Show>
        <RunError card={props.card} task={props.task} />
      </div>
    </section>
  );
}
