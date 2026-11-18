import { For, Show } from 'solid-js';
import { produce } from 'solid-js/store';
import {
  SLOT_LIMITS,
  SLOT_TYPES,
  type SlotDefinition,
  type SlotType,
} from '../../../lib/card-slots';
import { freeCardId } from '../../../lib/cards';
import { ArrowDownIcon, ArrowUpIcon, CloseIcon } from '../../icons';
import type { DraftProps } from './CardSourceFields';

/** What the type list calls each slot type; the ids are what cards store and agents publish. */
const SLOT_TYPE_NAMES: Record<SlotType, string> = {
  line: 'Line',
  text: 'Text block',
  score: 'Score 0–100',
  scores: 'Score list',
  stat: 'Number',
  items: 'List',
  checklist: 'Checklist',
  status: 'Status list',
};

/** Confidence, model, agent and JSON check cards fill slots the user lays out; app and pass/fail ones are fixed. */
function layoutEditable(draft: DraftProps['draft']): boolean {
  const { source } = draft;
  return (
    !!draft.builtIn ||
    source.kind === 'model' ||
    source.kind === 'agent' ||
    (source.kind === 'check' && source.mode === 'json')
  );
}

function SlotRow(props: DraftProps & { slot: SlotDefinition; index: number; editable: boolean }) {
  const set = (patch: Partial<SlotDefinition>) =>
    props.setDraft('slots', props.index, (slot) => ({ ...slot, ...patch }));
  // Replaced, not merged: a store setter would keep the old type's threshold or add-up.
  const setType = (type: SlotType) =>
    props.setDraft(
      produce((d) => {
        const { id, label, hint, hidden } = d.slots[props.index];
        d.slots[props.index] = {
          id,
          label,
          type,
          ...(hint && { hint }),
          ...(hidden && { hidden }),
        };
      }),
    );
  const move = (by: number) =>
    props.setDraft(
      produce((d) => {
        const [slot] = d.slots.splice(props.index, 1);
        d.slots.splice(props.index + by, 0, slot);
      }),
    );
  const remove = () =>
    props.setDraft(
      produce((d) => {
        d.slots.splice(props.index, 1);
      }),
    );
  const number = (value: string) => (value.trim() === '' ? undefined : Number(value));
  return (
    <li class="card-slot-row">
      <input
        class="input-field"
        aria-label="Slot label"
        maxLength={SLOT_LIMITS.label}
        value={props.slot.label}
        onInput={(e) => set({ label: e.currentTarget.value })}
      />
      <select
        class="input-field"
        aria-label="Slot type"
        disabled={!props.editable}
        value={props.slot.type}
        onChange={(e) => setType(e.currentTarget.value as SlotType)}
      >
        <For each={SLOT_TYPES}>
          {(type) => <option value={type}>{SLOT_TYPE_NAMES[type]}</option>}
        </For>
      </select>
      <span class="card-slot-moves">
        <Show when={props.editable}>
          <button
            type="button"
            aria-label={`Move ${props.slot.label} up`}
            title="Move up"
            disabled={props.index === 0}
            onClick={() => move(-1)}
          >
            <ArrowUpIcon size={12} />
          </button>
          <button
            type="button"
            aria-label={`Move ${props.slot.label} down`}
            title="Move down"
            disabled={props.index === props.draft.slots.length - 1}
            onClick={() => move(1)}
          >
            <ArrowDownIcon size={12} />
          </button>
          <button
            type="button"
            aria-label={`Remove ${props.slot.label}`}
            title="Remove slot"
            disabled={props.draft.slots.length === 1}
            onClick={remove}
          >
            <CloseIcon size={12} />
          </button>
        </Show>
      </span>
      <Show when={props.editable}>
        <div class="card-slot-extra">
          <Show when={props.draft.source.kind === 'model'}>
            <input
              class="input-field card-slot-hint"
              aria-label="Instruction for the model"
              placeholder="Instruction for the model (optional)"
              maxLength={SLOT_LIMITS.hint}
              value={props.slot.hint ?? ''}
              onInput={(e) => set({ hint: e.currentTarget.value || undefined })}
            />
          </Show>
          <Show when={props.slot.type === 'score' || props.slot.type === 'scores'}>
            <label>
              Warn below
              <input
                class="input-field"
                type="number"
                // Confidence's merge bar never goes under 60, so neither does its warning.
                min={props.draft.builtIn ? '60' : '0'}
                max="100"
                value={props.slot.warnBelow ?? ''}
                onInput={(e) => set({ warnBelow: number(e.currentTarget.value) })}
              />
            </label>
          </Show>
          <Show when={props.slot.type === 'stat'}>
            <label>
              Warn above
              <input
                class="input-field"
                type="number"
                min="0"
                value={props.slot.limit ?? ''}
                onInput={(e) => set({ limit: number(e.currentTarget.value) })}
              />
            </label>
          </Show>
          {/* A rating replaces the last one, so Confidence's lists never add up. */}
          <Show when={props.slot.type === 'items' && !props.draft.builtIn}>
            <label>
              <input
                type="checkbox"
                checked={!!props.slot.addUp}
                onChange={(e) => set({ addUp: e.currentTarget.checked || undefined })}
              />
              Add up across turns
            </label>
          </Show>
          {/* A hidden slot still fills and can be pinned; Confidence keeps its findings this way. */}
          <label>
            <input
              type="checkbox"
              checked={!props.slot.hidden}
              onChange={(e) => set({ hidden: e.currentTarget.checked ? undefined : true })}
            />
            Show in card
          </label>
        </div>
      </Show>
    </li>
  );
}

/** The card's slots in order: label, type, pin, and per-type settings. */
export function CardSlotsEditor(props: DraftProps) {
  const editable = () => layoutEditable(props.draft);
  const add = () => {
    const taken = new Set(props.draft.slots.map((slot) => slot.id));
    props.setDraft('slots', (slots) => [
      ...slots,
      { id: freeCardId('line', taken), type: 'line', label: 'New slot' },
    ]);
  };
  return (
    <div class="card-editor-stack">
      <span class="card-editor-label">Slots</span>
      <ul class="card-slot-list" aria-label="Slots">
        <For each={props.draft.slots}>
          {(slot, index) => (
            <SlotRow {...props} slot={slot} index={index()} editable={editable()} />
          )}
        </For>
      </ul>
      <Show when={editable() && props.draft.slots.length < SLOT_LIMITS.slots}>
        <button type="button" class="btn-secondary card-slot-add" onClick={add}>
          Add slot
        </button>
      </Show>
    </div>
  );
}
