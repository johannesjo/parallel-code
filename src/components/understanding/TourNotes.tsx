import { Show } from 'solid-js';
import { SendIcon } from '../icons';
import { TourIconButton } from './TourIconButton';
import { mod } from '../../lib/platform';

/**
 * A scratchpad beside the tour for what the reader learned, which they can
 * hand to the task's agent once they have read enough.
 */
export function TourNotes(props: {
  value: string;
  onInput: (value: string) => void;
  /** Hands the notes to the agent chat; absent where there is none. */
  onSend?: () => void;
}) {
  const empty = () => props.value.trim() === '';

  return (
    <div class="tour-notes">
      {/* The send button sits in the field's corner, like a chat composer's. */}
      <div class="tour-notes-field">
        <textarea
          class="tour-notes-input"
          aria-label="Tour notes"
          classList={{ 'tour-notes-input--sendable': !!props.onSend }}
          placeholder={props.onSend ? 'Send to main agent' : 'Notes'}
          value={props.value}
          onInput={(event) => props.onInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            const send = event.key === 'Enter' && (event.metaKey || event.ctrlKey);
            if (!send || event.isComposing || empty()) return;
            event.preventDefault();
            props.onSend?.();
          }}
        />
        <Show when={props.onSend}>
          <TourIconButton
            class="tour-notes-send"
            label="Send notes to agent"
            tooltip={`Add these notes to the agent prompt · ${mod}+Enter`}
            disabled={empty()}
            onClick={() => props.onSend?.()}
          >
            <SendIcon size={13} />
          </TourIconButton>
        </Show>
      </div>
    </div>
  );
}
