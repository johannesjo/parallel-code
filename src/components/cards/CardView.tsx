import { For, Show, createSignal, type JSX } from 'solid-js';
import { readCard, showsSlotLabel, valueFor, type CardReading } from '../../lib/card-display';
import type { CardDefinition } from '../../lib/cards';
import { formatRelativeAge } from '../../lib/relativeAge';
import { buildReviewSummary } from '../../lib/review-summary';
import { cardTaskState, getCheckCardRun, getModelCardRun, store } from '../../store/store';
import type { Task } from '../../store/types';
import { DisclosureChevronIcon } from '../icons';
import { CardSlot } from './CardSlot';
import { CheckCardActions } from './CheckCardActions';
import { ConfidenceScores } from './ConfidenceScores';
import { ModelCardActions } from './ModelCardActions';

interface CardViewProps {
  card: CardDefinition;
  task: Task;
  /** Open until the user toggles it; a quiet card among several shows its one-line summary. */
  expanded: boolean;
  /** Keeps the age current while the card is shown. */
  now: number;
}

/**
 * The right end of a card's top line: "Sonnet · 4m". Who fills the card rarely
 * changes, so it waits for the pointer or the keyboard and is the first to give up
 * its room on a short line. Still part of the text, so it is read aloud as before.
 */
export function CardMetaText(props: { source?: string; state: string }) {
  return (
    <span class="card-meta-text">
      <Show when={props.source}>
        <span class="card-meta-source">{`${props.source} · `}</span>
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
      <Show
        when={run().error}
        fallback={run().changed ? 'code changed during the run' : props.fallback}
      >
        {(error) => (
          <span class="card-error" title={error()}>
            failed: {error()}
          </span>
        )}
      </Show>
    </Show>
  );
}

/** The rating at a glance, or what will fill it. */
function ConfidenceBody(props: { task: Task }) {
  const scores = () =>
    buildReviewSummary({
      confidence: props.task.confidence,
      codeFingerprint: props.task.codeFingerprint,
    }).scores;
  return (
    <Show
      when={scores()}
      fallback={
        <p class="card-empty">Ask the agent to rate its confidence, or review at Finish.</p>
      }
    >
      {(rated) => <ConfidenceScores scores={rated()} />}
    </Show>
  );
}

/** The open or closed mark ending a card's top line; the editor's preview draws the same one. */
export function CardChevron(props: { open: boolean }) {
  return (
    <DisclosureChevronIcon
      size={14}
      class={props.open ? 'card-chevron' : 'card-chevron card-chevron-closed'}
    />
  );
}

/** One card in the popover or the cards pane: its top line, then each slot in its final layout. */
export function CardView(props: CardViewProps) {
  // Follows `expanded` until the user toggles it, so a card the user opened stays open as values change.
  const [chosen, setChosen] = createSignal<boolean>();
  const open = () => chosen() ?? props.expanded;
  const state = () => cardTaskState(props.task, props.now);
  const reading = () => readCard(props.card, state(), store.briefModel);
  return (
    <section
      class="card"
      aria-label={props.card.name}
      data-outdated={reading().outdated ? '' : undefined}
    >
      <button
        type="button"
        class="card-toggle"
        aria-expanded={open()}
        onClick={() => setChosen(!open())}
      >
        <span class="card-name">{props.card.name}</span>
        <span class="card-summary">{open() ? '' : reading().summary}</span>
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
        <CardChevron open={open()} />
      </button>
      <Show when={open()}>
        <div class="card-body">
          <Show
            when={props.card.builtIn !== 'confidence'}
            fallback={<ConfidenceBody task={props.task} />}
          >
            <For each={props.card.slots}>
              {(slot) => (
                <CardSlot
                  slot={slot}
                  value={valueFor(slot, state().cards?.[props.card.id])}
                  showLabel={showsSlotLabel(props.card, slot)}
                />
              )}
            </For>
            <Show when={props.card.source.kind === 'check'}>
              <CheckCardActions card={props.card} task={props.task} />
            </Show>
            <Show when={props.card.source.kind === 'model'}>
              <ModelCardActions card={props.card} task={props.task} />
            </Show>
          </Show>
        </div>
      </Show>
    </section>
  );
}
