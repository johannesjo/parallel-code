import { Show } from 'solid-js';
import { AgentModelMenu } from '../AgentModelMenu';
import { SparkleIcon } from '../icons';

/**
 * What stands where a generated tour has its ask bar: the keys for the mode
 * the reader is in, and Write card, which hands the card's notes to the agent
 * named beside it. The model is the one every tour asks, so changing it here
 * changes theirs too.
 */
export function ThinkingFooter(props: {
  editing: boolean;
  map: boolean;
  writing: boolean;
  onWrite: () => void;
}) {
  return (
    <div class="thinking-hints">
      <span>
        <Show when={!props.map} fallback="Mind map · edits change the cards · Ctrl+M back to cards">
          <Show
            when={props.editing}
            fallback="← → cards · ↓ ↑ follow-ups · type to write · Ctrl+M mind map"
          >
            Esc done · Alt+arrows move · Tab follow-up · Shift+Tab out
          </Show>
        </Show>
      </span>
      <Show when={!props.map}>
        <button
          type="button"
          class="thinking-write"
          title="Let the agent write this card from your notes · Alt+Enter"
          disabled={props.writing}
          onClick={() => props.onWrite()}
        >
          <SparkleIcon size={12} />
          Write card
        </button>
        <AgentModelMenu class="thinking-model" label="Card model" showModel />
      </Show>
    </div>
  );
}
