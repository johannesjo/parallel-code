import { For, Show, createSignal, onCleanup } from 'solid-js';
import { BRIEF_MODELS } from '../../../../electron/shared/task-name-model';
import { AI_PRESETS, missingFactCards, presetCard } from '../../../lib/card-gallery';
import { sourceLabel, triggerLabel } from '../../../lib/card-display';
import { checkCard } from '../../../lib/check-card';
import { CARD_LIMITS, type CardDefinition } from '../../../lib/cards';
import { errMessage } from '../../../lib/log';
import { allProjectChecks, draftCard, store } from '../../../store/store';
import { Dialog } from '../../Dialog';
import { DialogFooter } from '../../DialogFooter';

const takenIds = () => new Set(store.cardDefinitions.map((card) => card.id));

/** Every project check that has no card yet, one per check id. */
function checksWithoutCard() {
  const shown = new Set(
    store.cardDefinitions.flatMap((card) =>
      card.source.kind === 'check' ? [card.source.checkId] : [],
    ),
  );
  return allProjectChecks().filter((check) => !shown.has(check.id));
}

function Tile(props: { card: CardDefinition; detail?: string; onPick: () => void }) {
  return (
    <button type="button" class="card-tile" onClick={() => props.onPick()}>
      <b>{props.card.name}</b>
      <span>{props.detail ?? props.card.description}</span>
      <span class="card-tile-meta">
        {sourceLabel(props.card.source, store.briefModel)} · {triggerLabel(props.card.source)}
      </span>
    </button>
  );
}

/** The gallery: describe your own, AI presets, and the app facts and checks not shown yet. */
export function NewCardDialog(props: {
  onClose: () => void;
  onPick: (card: CardDefinition) => void;
}) {
  const [description, setDescription] = createSignal('');
  const [drafting, setDrafting] = createSignal(false);
  const [error, setError] = createSignal('');
  const full = () => store.cardDefinitions.length >= CARD_LIMITS.cards;
  // A draft that returns after the gallery closed opens nothing; the user gave up on it.
  // shortcut: the request still runs to its end. Cancel it if draftCard ever exposes one.
  let open = true;
  onCleanup(() => (open = false));

  async function draft() {
    setDrafting(true);
    setError('');
    try {
      const card = await draftCard(description());
      if (open) props.onPick(card);
    } catch (failure) {
      setError(errMessage(failure));
    } finally {
      setDrafting(false);
    }
  }

  return (
    <Dialog
      open
      onClose={props.onClose}
      width="640px"
      labelledBy="new-card-title"
      // Opens from Settings (1100), so it sits above it, as the theme editor does.
      zIndex={1200}
    >
      <h2 id="new-card-title" class="card-editor-title">
        Add card
      </h2>
      <Show when={full()}>
        <p class="card-editor-hint">{CARD_LIMITS.cards} cards at most; remove one first.</p>
      </Show>
      <label class="card-editor-field card-editor-stack">
        <span class="card-editor-label">Describe your own</span>
        <textarea
          class="input-field"
          rows={2}
          placeholder="show commit count and lines changed as numbers"
          value={description()}
          onInput={(e) => setDescription(e.currentTarget.value)}
        />
      </label>
      <DialogFooter
        error={error()}
        note={`One model call (${BRIEF_MODELS[store.briefModel].label}) drafts the layout from your description and check names; no prompts, diffs or replies are sent.`}
      >
        <button
          type="button"
          class="btn-primary"
          disabled={full() || drafting() || !description().trim()}
          onClick={() => void draft()}
        >
          {drafting() ? 'Drafting…' : 'Draft card'}
        </button>
      </DialogFooter>
      <div class="card-gallery">
        <section class="card-gallery-col" aria-label="AI cards">
          <h3>
            AI <span>sends task content to a model</span>
          </h3>
          <For each={AI_PRESETS}>
            {(preset) => {
              const card = () => presetCard(preset, takenIds());
              return <Tile card={card()} onPick={() => !full() && props.onPick(card())} />;
            }}
          </For>
        </section>
        <section class="card-gallery-col" aria-label="Non-AI cards">
          <h3>
            Non-AI <span>free, stays on this machine</span>
          </h3>
          <For each={missingFactCards(store.cardDefinitions)}>
            {(card) => <Tile card={card} onPick={() => !full() && props.onPick(card)} />}
          </For>
          <For each={checksWithoutCard()}>
            {(check) => {
              const card = () => checkCard(check, takenIds());
              return (
                <Tile
                  card={card()}
                  detail={check.command}
                  onPick={() => !full() && props.onPick(card())}
                />
              );
            }}
          </For>
        </section>
      </div>
    </Dialog>
  );
}
