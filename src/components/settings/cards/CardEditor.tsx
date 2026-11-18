import { Show, createSignal } from 'solid-js';
import { createStore, unwrap } from 'solid-js/store';
import { SLOT_LIMITS, type SlotDefinition } from '../../../lib/card-slots';
import {
  CARD_LIMITS,
  defaultConfidenceSlots,
  persistCardDefinitions,
  restoreCardDefinitions,
  type CardDefinition,
} from '../../../lib/cards';
import { holdsMergeEvidence } from '../../../lib/confidence-card';
import { errMessage } from '../../../lib/log';
import { addCard, draftCard, saveCard, store } from '../../../store/store';
import { Dialog } from '../../Dialog';
import { DialogFooter } from '../../DialogFooter';
import { CardPlacesFields } from './CardPlacesFields';
import { CardPreview } from './CardPreview';
import { CardSlotsEditor } from './CardSlotsEditor';
import { CardSourceFields } from './CardSourceFields';

/** The draft as it would be saved: clipped and checked the way a reload restores it. */
function tidy(draft: CardDefinition): CardDefinition | undefined {
  const restored = restoreCardDefinitions(persistCardDefinitions([draft]));
  return restored.find((card) => card.id === draft.id && card.builtIn === draft.builtIn);
}

/**
 * The draft with the default score list and findings in front, in place of any
 * slot using their ids; undefined when that would push out one of the user's.
 */
function withMergeEvidence(slots: SlotDefinition[]): SlotDefinition[] | undefined {
  const evidence = defaultConfidenceSlots().filter((slot) => MERGE_SLOTS.has(slot.id));
  const rest = slots.filter((slot) => !MERGE_SLOTS.has(slot.id));
  const next = [...evidence, ...rest];
  return next.length > SLOT_LIMITS.slots ? undefined : next;
}

const MERGE_SLOTS = new Set(['scores', 'findings']);

/** Why a Confidence layout without the score list or the findings never lets a task merge. */
function MergeNote(props: { draft: CardDefinition; onRestore: () => void }) {
  return (
    <Show when={props.draft.builtIn === 'confidence' && !holdsMergeEvidence(props.draft)}>
      {/* Laid out like the redraft row: a routine button beside a plain hint. */}
      <div class="card-editor-redraft-row" role="note">
        <button
          type="button"
          class="btn-secondary card-editor-redraft"
          onClick={() => props.onRestore()}
        >
          Add them back
        </button>
        <span class="card-editor-hint">
          Without the default score list and findings, no task shows as ready to merge.
        </span>
      </div>
    </Show>
  );
}

/** A layout drafted from the edited description, waiting to be used or discarded. */
function LayoutPreview(props: {
  draft: CardDefinition;
  next: CardDefinition;
  onUse: () => void;
  onDiscard: () => void;
}) {
  const kept = () => new Set(props.next.slots.map((slot) => slot.id));
  const lost = () => props.draft.slots.filter((slot) => !kept().has(slot.id));
  return (
    <div class="card-editor-preview" role="status">
      <span>
        New layout: {props.next.slots.map((slot) => slot.label).join(', ')}.
        <Show when={lost().length}>
          {' '}
          Using it clears stored values of{' '}
          {lost()
            .map((slot) => slot.label)
            .join(', ')}
          .
        </Show>
      </span>
      <button type="button" class="btn-secondary" onClick={() => props.onUse()}>
        Use new layout
      </button>
      <button type="button" class="btn-secondary" onClick={() => props.onDiscard()}>
        Discard
      </button>
    </div>
  );
}

interface CardEditorProps {
  card: CardDefinition;
  isNew: boolean;
  onClose: () => void;
  /** Asks to remove the saved card; left out for a card that was never added. */
  onRemove?: () => void;
}

/** Edits one card, new or saved; nothing reaches the store until Save or Add card. */
export function CardEditor(props: CardEditorProps) {
  // A copy taken when the editor opens; the store's card stays untouched until Save.
  // eslint-disable-next-line solid/reactivity
  const [draft, setDraft] = createStore(structuredClone(unwrap(props.card)));
  const [next, setNext] = createSignal<CardDefinition>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  async function redraft() {
    setBusy(true);
    setError('');
    try {
      setNext(await draftCard(draft.description));
    } catch (failure) {
      setError(errMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  function useLayout(layout: CardDefinition) {
    const ids = new Set(layout.slots.map((slot) => slot.id));
    const pinned = draft.pinned?.filter((id) => ids.has(id));
    setDraft({
      source: layout.source,
      slots: layout.slots,
      pinned: pinned?.length ? pinned : undefined,
    });
    setNext(undefined);
  }

  function save() {
    const card = tidy(unwrap(draft));
    // Restore drops a card without slots or with a check source naming no check.
    if (!card) return setError('A card needs a source and at least one slot.');
    if (!props.isNew) saveCard(card);
    else if (!addCard(card))
      return setError(
        store.cardDefinitions.length >= CARD_LIMITS.cards
          ? `${CARD_LIMITS.cards} cards at most; remove one first.`
          : 'A card with this id was added meanwhile; pick the entry again.',
      );
    props.onClose();
  }

  return (
    <Dialog
      open
      onClose={props.onClose}
      // Wide enough for the preview beside the form; narrower windows stack them.
      width="min(1040px, calc(100vw - 48px))"
      labelledBy="card-editor-title"
      closeOnBackdrop={false}
      // Opens from Settings (1100), so it sits above it, as the theme editor does.
      zIndex={1200}
    >
      <h2 id="card-editor-title" class="card-editor-title">
        {props.isNew ? 'Add card' : `Edit ${props.card.name}`}
      </h2>
      <div class="card-editor-layout">
        {/* First: the card is what the form is about, so it is read first and stays on top when stacked. */}
        <CardPreview card={draft} />
        <div class="card-editor-body">
          <label class="card-editor-field">
            <span class="card-editor-label">Name</span>
            <input
              class="input-field"
              maxLength={CARD_LIMITS.name}
              value={draft.name}
              onInput={(e) => setDraft('name', e.currentTarget.value)}
            />
          </label>
          {/* Confidence is filled by ratings, so it has no description or source to set. */}
          <Show when={!draft.builtIn}>
            <label class="card-editor-field card-editor-stack">
              <span class="card-editor-label">Description</span>
              <textarea
                class="input-field"
                rows={2}
                maxLength={CARD_LIMITS.description}
                value={draft.description}
                onInput={(e) => setDraft('description', e.currentTarget.value)}
              />
            </label>
            <Show when={draft.source.kind !== 'app'}>
              <div class="card-editor-redraft-row">
                <button
                  type="button"
                  class="btn-secondary card-editor-redraft"
                  disabled={busy() || !draft.description.trim()}
                  onClick={() => void redraft()}
                >
                  {busy() ? 'Drafting…' : 'Draft new layout'}
                </button>
                <span class="card-editor-hint">
                  The default AI model proposes a source and slots from the description; nothing
                  changes until you use them.
                </span>
              </div>
            </Show>
            <Show when={next()}>
              {(layout) => (
                <LayoutPreview
                  draft={draft}
                  next={layout()}
                  onUse={() => useLayout(layout())}
                  onDiscard={() => setNext(undefined)}
                />
              )}
            </Show>
            <div class="card-editor-section">
              <CardSourceFields draft={draft} setDraft={setDraft} />
            </div>
          </Show>
          <div class="card-editor-section">
            <CardSlotsEditor draft={draft} setDraft={setDraft} />
            <MergeNote
              draft={draft}
              onRestore={() => {
                const slots = withMergeEvidence(unwrap(draft).slots);
                if (!slots) return setError('Remove a slot first to make room for them.');
                setError('');
                setDraft('slots', slots);
              }}
            />
          </div>
          <div class="card-editor-section">
            <CardPlacesFields draft={draft} setDraft={setDraft} />
          </div>
        </div>
      </div>
      <DialogFooter
        error={error()}
        start={
          <Show when={props.onRemove}>
            {(remove) => (
              // Neutral until confirmed: the question it opens carries the warning.
              <button type="button" class="btn-secondary" onClick={() => remove()()}>
                Remove card
              </button>
            )}
          </Show>
        }
      >
        <button type="button" class="btn-secondary" onClick={() => props.onClose()}>
          Cancel
        </button>
        <button type="button" class="btn-primary" onClick={save}>
          {props.isNew ? 'Add card' : 'Save'}
        </button>
      </DialogFooter>
    </Dialog>
  );
}
