import { For, Show, createSignal } from 'solid-js';
import { BRIEF_MODELS, type BriefModelId } from '../../../electron/shared/task-name-model';
import { sourceLabel, triggerLabel } from '../../lib/card-display';
import { cardKind, pinnableSlots, type CardDefinition } from '../../lib/cards';
import { theme } from '../../lib/theme';
import { ConfirmDialog } from '../ConfirmDialog';
import {
  store,
  modelCallsPerTurn,
  moveCard,
  removeCard,
  setBriefModel,
  setCardEnabled,
  setCardMini,
  setShowCards,
  setSlotPinned,
} from '../../store/store';
import { CardBarPins } from './cards/CardBarPins';
import { CardEditor } from './cards/CardEditor';
import { NewCardDialog } from './cards/NewCardDialog';
import { ModelSelect, SettingsCheckboxRow, SettingsSection } from './settings-ui';
import './cards-settings.css';

function callsNote(): string {
  const calls = modelCallsPerTurn();
  const usage = 'Used by AI cards set to "default" and by PR drafts.';
  if (calls === 0) return `${usage} No enabled card calls a model after each turn.`;
  const count = calls === 1 ? 'about 1 model call' : `about ${calls} model calls`;
  return `${usage} With the enabled cards: ${count} per turn, only when something changed.`;
}

/** "Sonnet · after each turn · off in 2 projects": what fills the card, and when. */
function rowDetail(card: CardDefinition): string {
  const parts = [sourceLabel(card.source, store.briefModel), triggerLabel(card.source)];
  const overrides = Object.values(card.projects ?? {});
  const off = overrides.filter((on) => !on).length;
  const on = overrides.length - off;
  if (off) parts.push(`off in ${off} ${off === 1 ? 'project' : 'projects'}`);
  if (on) parts.push(`on in ${on} ${on === 1 ? 'project' : 'projects'}`);
  return parts.join(' · ');
}

/** The card row in hand and the row it is over: enough to show where it will land. */
function createCardDrag() {
  const [id, setId] = createSignal<string>();
  const [over, setOver] = createSignal<number>();
  let pending: ReturnType<typeof setTimeout> | undefined;
  const from = () => store.cardDefinitions.findIndex((card) => card.id === id());
  const end = () => {
    clearTimeout(pending);
    setId(undefined);
    setOver(undefined);
  };
  return {
    id,
    // A moment later: the browser takes its picture of the row after this event, and it should not be the dimmed one.
    start: (cardId: string) => {
      pending = setTimeout(() => setId(cardId));
    },
    over: (index: number | undefined) => setOver(index),
    end,
    /** The edge of row `index` the card lands on; a drop gives it that row's place. */
    side: (index: number) => {
      if (id() === undefined || over() !== index || from() === index) return undefined;
      return from() < index ? 'after' : 'before';
    },
    drop: (index: number) => {
      const cardId = id();
      if (cardId) moveCard(cardId, index);
      end();
    },
  };
}

function CardRow(props: {
  card: CardDefinition;
  index: number;
  drag: ReturnType<typeof createCardDrag>;
  onEdit: () => void;
  onRemove: () => void;
}) {
  // The summary counts as a pin: both are things the card shows in the bar below the title.
  const pins = () => (props.card.mini ? 1 : 0) + (props.card.pinned?.length ?? 0);
  const [pinning, setPinning] = createSignal(false);
  const prompt = () => (props.card.source.kind === 'model' ? props.card.source.prompt : '');
  const [showPrompt, setShowPrompt] = createSignal(false);
  // A draggable row turns a mouse-drag into a reorder, so it pauses over the prompt to let it be selected.
  const [overPrompt, setOverPrompt] = createSignal(false);
  const promptId = () => `cards-prompt-${props.card.id}`;
  return (
    <li
      class="cards-row"
      data-off={props.card.enabled ? undefined : ''}
      data-dragging={props.drag.id() === props.card.id ? '' : undefined}
      data-drop={props.drag.side(props.index)}
      draggable={!overPrompt()}
      onDragStart={(e) => {
        e.dataTransfer?.setData('text/plain', props.card.id);
        props.drag.start(props.card.id);
      }}
      onDragEnd={() => props.drag.end()}
      onDragOver={(e) => {
        // Only a card of this list: a file dragged over Settings is not ours to accept.
        if (!props.drag.id()) return;
        e.preventDefault();
        props.drag.over(props.index);
      }}
      onDrop={(e) => {
        e.preventDefault();
        props.drag.drop(props.index);
      }}
    >
      <div class="cards-row-line">
        <span class="cards-grip" aria-hidden="true" />
        <span class="cards-row-name">
          <span>{props.card.name}</span>
          <span class="cards-row-detail">{rowDetail(props.card)}</span>
          <Show when={prompt()}>
            <button
              type="button"
              class="cards-prompt"
              aria-label="Prompt"
              aria-controls={promptId()}
              aria-expanded={showPrompt()}
              title={showPrompt() ? 'Hide the prompt' : 'Show the whole prompt'}
              onClick={() => setShowPrompt(!showPrompt())}
            >
              {prompt()}
            </button>
          </Show>
        </span>
        <span class="cards-type">{cardKind(props.card.source) === 'ai' ? 'AI' : 'Non-AI'}</span>
        <button
          type="button"
          class="cards-pins"
          aria-expanded={pinning()}
          disabled={pinnableSlots(props.card).length === 0}
          title="What this card shows in the bar below the task title"
          onClick={() => setPinning(!pinning())}
        >
          {pins() ? `${pins()} pinned` : 'no pins'}
        </button>
        <button
          type="button"
          class="cards-edit"
          aria-label={`Edit ${props.card.name}`}
          onClick={() => props.onEdit()}
        >
          Edit
        </button>
        {/* Finish and the merge check read Confidence, so it is switched off, never removed. */}
        <Show when={!props.card.builtIn}>
          <button
            type="button"
            class="cards-edit"
            aria-label={`Remove ${props.card.name}`}
            onClick={() => props.onRemove()}
          >
            Remove
          </button>
        </Show>
        <input
          type="checkbox"
          aria-label={`Show ${props.card.name}`}
          checked={props.card.enabled}
          onChange={(e) => setCardEnabled(props.card.id, e.currentTarget.checked)}
        />
      </div>
      <Show when={showPrompt() && prompt()}>
        <pre
          id={promptId()}
          class="cards-prompt-full"
          onPointerEnter={() => setOverPrompt(true)}
          onPointerLeave={() => setOverPrompt(false)}
        >
          {prompt()}
        </pre>
      </Show>
      <Show when={pinning()}>
        <div class="cards-pin-list" role="group" aria-label={`Pins of ${props.card.name}`}>
          <span>In the bar below the title:</span>
          <CardBarPins
            card={props.card}
            onSummary={(on) => setCardMini(props.card.id, on)}
            onSlot={(slotId, on) => setSlotPinned(props.card.id, slotId, on)}
          />
        </div>
      </Show>
    </li>
  );
}

/** The Cards tab: the master switch, the default model, and every card in display order. */
export function CardsSettings() {
  const drag = createCardDrag();
  const [picking, setPicking] = createSignal(false);
  const [editing, setEditing] = createSignal<{ card: CardDefinition; isNew: boolean }>();
  const [removing, setRemoving] = createSignal<CardDefinition>();
  return (
    <>
      <SettingsCheckboxRow
        label="Show cards"
        checked={store.showCards}
        onChange={setShowCards}
        description="A line in each task header with what your cards say. Click it for all cards."
      />
      <ModelSelect
        label="Default AI model"
        value={store.briefModel}
        choices={BRIEF_MODELS}
        onChange={(id) => setBriefModel(id as BriefModelId)}
        hint={callsNote()}
      />
      <SettingsSection title="Cards">
        <ul
          class="cards-list"
          aria-label="Cards"
          onDragLeave={(e) => {
            // Out of the list, a drop lands nowhere, so no row stays marked.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) drag.over(undefined);
          }}
        >
          <For each={store.cardDefinitions} fallback={<li class="cards-empty">No cards yet.</li>}>
            {(card, index) => (
              <CardRow
                card={card}
                index={index()}
                drag={drag}
                onEdit={() => setEditing({ card, isNew: false })}
                onRemove={() => setRemoving(card)}
              />
            )}
          </For>
        </ul>
        <button type="button" class="btn-secondary cards-new" onClick={() => setPicking(true)}>
          Add card
        </button>
        <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
          Drag to reorder. The popover and the card line use this order.
          {store.showCards ? '' : ' Cards are hidden while Show cards is off.'}
        </span>
      </SettingsSection>
      <Show when={picking()}>
        <NewCardDialog
          onClose={() => setPicking(false)}
          onPick={(card) => {
            setPicking(false);
            setEditing({ card, isNew: true });
          }}
        />
      </Show>
      <Show when={editing()}>
        {(open) => (
          <CardEditor
            card={open().card}
            isNew={open().isNew}
            onClose={() => setEditing(undefined)}
            onRemove={
              open().isNew || open().card.builtIn ? undefined : () => setRemoving(open().card)
            }
          />
        )}
      </Show>
      {/* Removing also deletes what the card says on every task, which cannot be brought back. */}
      <ConfirmDialog
        open={removing() !== undefined}
        title="Remove card?"
        message={`Remove "${removing()?.name ?? ''}"? The values it shows on your tasks are deleted with it.`}
        confirmLabel="Remove"
        danger
        // Also asked from the editor (1200), so it sits above it.
        zIndex={1300}
        onConfirm={() => {
          const card = removing();
          setRemoving(undefined);
          setEditing(undefined);
          if (card) removeCard(card.id);
        }}
        onCancel={() => setRemoving(undefined)}
      />
    </>
  );
}
