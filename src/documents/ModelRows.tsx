import { For, Show } from 'solid-js';
import { documentAgentSupport } from '../../electron/documents/shared';
import type { DocumentCandidateSpec } from '../../electron/documents/types';
import type { DocumentModelChoice } from '../store/types';

/** One candidate's slot in the remembered choices: an agent and its n-th candidate. */
export interface ChoiceSlot {
  agentId: string;
  index: number;
}

export interface ModelSlot extends ChoiceSlot {
  spec: DocumentCandidateSpec;
}

interface ModelRowsProps {
  slots: ModelSlot[];
  choice: (slot: ChoiceSlot) => DocumentModelChoice;
  /** `persist` is true once the user is done with the field, false while typing. */
  onChoice: (slot: ChoiceSlot, patch: DocumentModelChoice, persist: boolean) => void;
}

/** Model and reasoning level per candidate, one row each. */
export function ModelRows(props: ModelRowsProps) {
  return (
    <div class="docws-model-rows" role="group" aria-label="Model per candidate">
      <For each={props.slots}>
        {(slot) => {
          const support = documentAgentSupport(slot.agentId);
          const listId = `docws-models-${slot.spec.id}`;
          const who = `candidate ${slot.spec.label} (${slot.spec.agentName})`;
          return (
            <div class="docws-model-row">
              <span class="docws-model-agent">
                <span class="docws-candidate-label">{slot.spec.label}</span>
                {slot.spec.agentName}
                <Show when={slot.spec.isMain}>
                  <span class="docws-main-badge">main</span>
                </Show>
              </span>
              <label>
                Model{' '}
                <input
                  class="docws-model-input"
                  list={listId}
                  placeholder="default"
                  aria-label={`Model for ${who}`}
                  title="Any model name the CLI accepts; empty for its default"
                  value={props.choice(slot).model ?? ''}
                  onInput={(e) => props.onChoice(slot, { model: e.currentTarget.value }, false)}
                  onChange={(e) => props.onChoice(slot, { model: e.currentTarget.value }, true)}
                />
                <datalist id={listId}>
                  <For each={support.models}>{(m) => <option value={m} />}</For>
                </datalist>
              </label>
              <Show when={support.efforts.length > 0}>
                <label>
                  Reasoning{' '}
                  <select
                    class="docws-select"
                    aria-label={`Reasoning level for ${who}`}
                    value={props.choice(slot).effort ?? ''}
                    onChange={(e) => props.onChoice(slot, { effort: e.currentTarget.value }, true)}
                  >
                    <option value="">default</option>
                    <For each={support.efforts}>{(e) => <option value={e}>{e}</option>}</For>
                  </select>
                </label>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}
