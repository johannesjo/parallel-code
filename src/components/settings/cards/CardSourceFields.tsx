import { For, Match, Show, Switch } from 'solid-js';
import { produce, type SetStoreFunction } from 'solid-js/store';
import { BRIEF_MODELS } from '../../../../electron/shared/task-name-model';
import { exampleCheckOutput } from '../../../lib/card-gallery';
import { checkCard } from '../../../lib/check-card';
import type {
  CardDefinition,
  CardSource,
  CheckTrigger,
  ModelInput,
  ModelTrigger,
} from '../../../lib/cards';
import { allProjectChecks, store } from '../../../store/store';

export interface DraftProps {
  draft: CardDefinition;
  setDraft: SetStoreFunction<CardDefinition>;
}

/** Replaces the source outright: a store setter merges objects, so a dropped key would stay. */
function putSource(props: DraftProps, source: CardSource): void {
  props.setDraft(
    produce((draft) => {
      draft.source = source;
    }),
  );
}

type ModelSource = Extract<CardSource, { kind: 'model' }>;

const INPUTS: { id: ModelInput; label: string }[] = [
  { id: 'task-name', label: 'Task name' },
  { id: 'prompts', label: 'Prompts since last run' },
  { id: 'agent-message', label: "Agent's last message" },
  { id: 'diff', label: 'Branch diff' },
];
const TRIGGERS: { id: ModelTrigger; label: string }[] = [
  { id: 'after-turn', label: 'After each turn' },
  { id: 'manual', label: 'On demand' },
  { id: 'finish', label: 'At Finish' },
];
// Run is always on the card, so every choice includes on demand.
const CHECK_TRIGGERS: { id: CheckTrigger; label: string }[] = [
  { id: 'manual', label: 'On demand' },
  { id: 'finish', label: 'On demand and when Finish opens' },
  { id: 'after-turn', label: 'After each turn, and at Finish' },
];
const WHEN: Record<ModelTrigger, string> = {
  'after-turn': 'after each turn in which something changed',
  manual: 'when you refresh the card',
  finish: 'when the Finish dialog opens',
};

function ModelFields(props: DraftProps & { source: ModelSource }) {
  const set = (patch: Partial<ModelSource>) =>
    props.setDraft('source', { ...props.source, ...patch });
  const toggle = (input: ModelInput, on: boolean) =>
    set({
      inputs: INPUTS.map((i) => i.id).filter((id) =>
        id === input ? on : props.source.inputs.includes(id),
      ),
    });
  return (
    <>
      <label class="card-editor-field">
        <span class="card-editor-label">Model</span>
        <select
          class="input-field"
          value={props.source.model}
          onChange={(e) => set({ model: e.currentTarget.value as ModelSource['model'] })}
        >
          <option value="default">Default ({BRIEF_MODELS[store.briefModel].label})</option>
          <For each={Object.entries(BRIEF_MODELS)}>
            {([id, model]) => <option value={id}>{model.label}</option>}
          </For>
        </select>
      </label>
      <label class="card-editor-field">
        <span class="card-editor-label">Runs</span>
        <select
          class="input-field"
          value={props.source.trigger}
          onChange={(e) => set({ trigger: e.currentTarget.value as ModelTrigger })}
        >
          <For each={TRIGGERS}>{(t) => <option value={t.id}>{t.label}</option>}</For>
        </select>
      </label>
      <div class="card-editor-field" role="group" aria-label="Reads">
        <span class="card-editor-label">Reads</span>
        <span class="card-editor-inputs">
          <For each={INPUTS}>
            {(input) => (
              <label>
                <input
                  type="checkbox"
                  checked={props.source.inputs.includes(input.id)}
                  onChange={(e) => toggle(input.id, e.currentTarget.checked)}
                />
                {input.label}
              </label>
            )}
          </For>
        </span>
      </div>
      <label class="card-editor-field">
        <span class="card-editor-label">Check</span>
        <select
          class="input-field"
          value={props.source.checkId ?? ''}
          onChange={(e) => {
            const { checkId: _old, ...rest } = props.source;
            const checkId = e.currentTarget.value;
            putSource(props, checkId ? { ...rest, checkId } : rest);
          }}
        >
          <option value="">None</option>
          <For each={allProjectChecks()}>
            {(c) => <option value={c.id}>Run {c.name} first</option>}
          </For>
        </select>
      </label>
      <label class="card-editor-field card-editor-stack">
        <span class="card-editor-label">Prompt</span>
        <textarea
          class="input-field"
          rows={3}
          value={props.source.prompt}
          onInput={(e) => set({ prompt: e.currentTarget.value })}
        />
      </label>
      <p class="card-editor-hint">
        Sends the ticked task content to the model provider {WHEN[props.source.trigger]}. The card's
        previous values are always included so it stays stable.
      </p>
    </>
  );
}

/** Who fills the card, and for a model or check, how. App-fact cards are fixed. */
export function CardSourceFields(props: DraftProps) {
  const source = () => props.draft.source;
  const switchTo = (kind: 'model' | 'agent') =>
    putSource(
      props,
      kind === 'agent'
        ? { kind: 'agent' }
        : {
            kind: 'model',
            model: 'default',
            prompt: props.draft.description,
            inputs: ['prompts', 'agent-message', 'diff'],
            trigger: 'after-turn',
          },
    );
  return (
    <Switch>
      <Match when={source().kind === 'model' || source().kind === 'agent'}>
        <label class="card-editor-field">
          <span class="card-editor-label">Source</span>
          <select
            class="input-field"
            value={source().kind}
            onChange={(e) => switchTo(e.currentTarget.value as 'model' | 'agent')}
          >
            <option value="model">Model</option>
            <option value="agent">The agent, with card_publish</option>
          </select>
        </label>
        <Show when={source().kind === 'model' ? (source() as ModelSource) : undefined}>
          {(model) => <ModelFields {...props} source={model()} />}
        </Show>
      </Match>
      <Match when={source().kind === 'app'}>
        <p class="card-editor-hint">Filled from facts the app has: live and free.</p>
      </Match>
      <Match
        when={
          source().kind === 'check'
            ? (source() as Extract<CardSource, { kind: 'check' }>)
            : undefined
        }
      >
        {(check) => (
          <>
            <label class="card-editor-field">
              <span class="card-editor-label">Check result</span>
              <select
                class="input-field"
                value={check().mode}
                onChange={(e) => {
                  const mode = e.currentTarget.value as 'exit-code' | 'json';
                  props.setDraft('source', { ...check(), mode });
                  // Pass/fail has one fixed slot; JSON fills slots the user defines.
                  if (mode === 'exit-code')
                    props.setDraft('slots', checkCard({ id: check().checkId, name: '' }).slots);
                }}
              >
                <option value="exit-code">Pass or fail</option>
                <option value="json">JSON with slot values</option>
              </select>
            </label>
            <label class="card-editor-field">
              <span class="card-editor-label">Runs</span>
              <select
                class="input-field"
                value={check().trigger}
                onChange={(e) =>
                  props.setDraft('source', {
                    ...check(),
                    trigger: e.currentTarget.value as CheckTrigger,
                  })
                }
              >
                <For each={CHECK_TRIGGERS}>{(t) => <option value={t.id}>{t.label}</option>}</For>
              </select>
            </label>
            <Show when={check().mode === 'json'}>
              <p class="card-editor-hint">
                The command writes one JSON object, keyed by slot id, to the file named by
                PC_OUT_FILE. For these slots, with sample values:
              </p>
              <pre class="card-editor-example" aria-label="Example output">
                {exampleCheckOutput(props.draft.slots)}
              </pre>
            </Show>
          </>
        )}
      </Match>
    </Switch>
  );
}
