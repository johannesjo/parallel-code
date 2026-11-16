import { Show } from 'solid-js';
import type { CardDefinition } from '../../lib/cards';
import { getModelCardRun, runModelCard } from '../../store/store';
import type { Task } from '../../store/types';

/** Refresh for a card filled on demand; Retry after a failed run, whatever the trigger. */
export function ModelCardActions(props: { card: CardDefinition; task: Task }) {
  const run = () => getModelCardRun(props.task.id, props.card.id);
  const manual = () => props.card.source.kind === 'model' && props.card.source.trigger === 'manual';
  return (
    <Show when={manual() || run().error}>
      <div class="card-check">
        <button
          type="button"
          class="btn-secondary cards-btn card-check-run"
          disabled={run().running}
          onClick={() => void runModelCard(props.task.id, props.card.id, { force: true })}
        >
          {run().error ? 'Retry' : 'Refresh'}
        </button>
      </div>
    </Show>
  );
}
