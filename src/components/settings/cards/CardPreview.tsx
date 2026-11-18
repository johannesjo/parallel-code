import { For, Show } from 'solid-js';
import {
  pinGroups,
  showsInPinRow,
  shownSlots,
  showsSlotLabel,
  sourceLabel,
  valueFor,
} from '../../../lib/card-display';
import { sampleValue } from '../../../lib/card-gallery';
import type { CardDefinition, CardValues } from '../../../lib/cards';
import { formatRelativeAge } from '../../../lib/relativeAge';
import { allProjectChecks, store } from '../../../store/store';
import { IconButton } from '../../IconButton';
import { PencilIcon, SyncIcon } from '../../icons';
import { CardSlot } from '../../cards/CardSlot';
import { CardsPaneFrame } from '../../cards/CardsPane';
import { CardMetaText } from '../../cards/CardView';
import { PinGroups } from '../../cards/PinRow';
import '../../cards/cards.css';

// A fixed age, a minute old: a ticking clock would only distract while editing.
const SAMPLE_AGE = formatRelativeAge(0, 60_000);

// The sample's buttons are drawn, not wired: the fieldset around them is disabled.
const nothing = () => undefined;

/** The command a check card would run: a project's own, or the check's id when no project has it yet. */
function sampleCommand(card: CardDefinition): string | undefined {
  const source = card.source;
  if (source.kind !== 'check') return undefined;
  return allProjectChecks().find((check) => check.id === source.checkId)?.command ?? source.checkId;
}

/** The row a task shows under a check card or an AI card filled on demand, as `CheckCardActions` and `ModelCardActions` draw it. */
function SampleActions(props: { card: CardDefinition }) {
  const command = () => sampleCommand(props.card);
  const manual = () => props.card.source.kind === 'model' && props.card.source.trigger === 'manual';
  return (
    <Show when={command() !== undefined || manual()}>
      <div class="card-check">
        <Show when={command()}>{(text) => <code>{text()}</code>}</Show>
        <button type="button" class="btn-secondary cards-btn card-check-run">
          {command() === undefined ? 'Refresh' : 'Run again'}
        </button>
      </div>
    </Show>
  );
}

/**
 * The draft filled with sample values, where a task shows it: in the cards
 * pane and in the bar below the title when it is there. Built from the pane's
 * own frame and the card styles, so the preview can't drift.
 */
export function CardPreview(props: { card: CardDefinition }) {
  const values = (): CardValues => ({
    values: Object.fromEntries(props.card.slots.map((slot) => [slot.id, sampleValue(slot)])),
    at: 0,
  });
  const name = () => props.card.name.trim() || 'Untitled card';
  // App cards show only the age in a task, as CardView does.
  const source = () =>
    props.card.source.kind === 'app' ? undefined : sourceLabel(props.card.source, store.briefModel);
  const pins = () => pinGroups([props.card], { cards: { [props.card.id]: values() } });
  return (
    <section class="card-editor-live" aria-label="Preview">
      <header class="card-editor-live-head">
        <h3>Preview</h3>
        <span>sample values</span>
      </header>
      {/* A disabled group: the sample's buttons do nothing and Tab goes straight to the form, yet it is still read aloud. */}
      <fieldset class="card-editor-live-views" disabled>
        <CardsPaneFrame
          actions={
            <>
              <Show when={props.card.source.kind === 'model'}>
                <IconButton icon={<SyncIcon size={12} />} title="Update now" onClick={nothing} />
              </Show>
              <IconButton icon={<PencilIcon size={12} />} title="Edit cards" onClick={nothing} />
            </>
          }
        >
          <div class="card">
            <div class="card-head">
              <span class="card-name">{name()}</span>
              <span class="card-meta">
                <CardMetaText source={source()} state={SAMPLE_AGE} />
              </span>
            </div>
            <div class="card-body">
              <For each={shownSlots(props.card)}>
                {(slot) => (
                  <CardSlot
                    slot={slot}
                    value={valueFor(slot, values())}
                    showLabel={showsSlotLabel(props.card, slot)}
                  />
                )}
              </For>
              <SampleActions card={props.card} />
            </div>
          </div>
        </CardsPaneFrame>
        <Show when={showsInPinRow(props.card)}>
          <div class="card-editor-live-group">
            <span class="card-editor-label">Bar below title</span>
            <div class="card-editor-live-surface">
              <PinGroups groups={pins()} label="Bar below title" />
            </div>
          </div>
        </Show>
      </fieldset>
    </section>
  );
}
