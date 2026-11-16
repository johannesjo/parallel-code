import { Show } from 'solid-js';
import type { CardDefinition } from '../../lib/cards';
import { cardCheck, getCheckCardRun, runCheckCard } from '../../store/store';
import type { Task } from '../../store/types';

/** The check a card runs, its Run button and the last run's output. */
export function CheckCardActions(props: { card: CardDefinition; task: Task }) {
  const check = () => cardCheck(props.task.id, props.card.id);
  const run = () => getCheckCardRun(props.task.id, props.card.id);
  const label = () => {
    if (run().running) return 'Running…';
    if (run().error) return 'Retry';
    return props.task.cards?.[props.card.id] ? 'Run again' : 'Run';
  };
  return (
    <>
      <div class="card-check">
        <code>{check()?.command ?? 'This project has no such check.'}</code>
        <button
          type="button"
          class="btn-secondary cards-btn card-check-run"
          disabled={!check() || run().running}
          onClick={() => void runCheckCard(props.task.id, props.card.id)}
        >
          {label()}
        </button>
      </div>
      <Show when={run().outputTail}>
        {(tail) => (
          <details class="card-check-output">
            <summary>Output</summary>
            <pre>{tail()}</pre>
          </details>
        )}
      </Show>
    </>
  );
}
