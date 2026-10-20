import { Show, createSignal } from 'solid-js';
import { CloseIcon, LayersIcon, MentionIcon } from '../icons';
import { TourIconButton } from './TourIconButton';

/** Ask input and Go deeper action; the result replaces the current branch. */
export function TourAskBar(props: {
  disabled: boolean;
  asking: boolean;
  onAsk: (question: string) => void;
  onGoDeeper: () => void;
  /** Aborts the follow-up request in flight. */
  onCancel: () => void;
  /** The ask field, so the dialog can hand it focus on Enter. */
  ref?: (element: HTMLInputElement) => void;
  /** Up leaves the field for the card above, as it leaves an answer. */
  onLeave?: () => void;
  /** Says why the field is closed, or where a question is being answered. */
  placeholder?: string;
  /** Offered in Go deeper's place once the tour can hold no deeper answer. */
  onContinueInChat?: () => void;
}) {
  const [question, setQuestion] = createSignal('');

  function submit(): void {
    const text = question().trim();
    if (!text) return;
    setQuestion('');
    props.onAsk(text);
  }

  return (
    <div class="understanding-ask">
      <input
        ref={(element) => props.ref?.(element)}
        type="text"
        class="understanding-ask-input"
        placeholder={props.placeholder ?? 'Ask about this card…'}
        aria-label="Ask about this card"
        value={question()}
        disabled={props.disabled}
        onInput={(event) => setQuestion(event.currentTarget.value)}
        // Arrow keys move the caret here; the dialog must not navigate cards, and
        // Escape only lets go of the field. Up steps back to the card, as the
        // field sits below the last card down. Native, not delegated: a delegated
        // handler runs on document, too late to stop the dialog's Escape listener.
        on:keydown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') event.currentTarget.blur();
          // Composing text, or selecting it with a modifier, keeps the field.
          const plain = !(
            event.isComposing ||
            event.shiftKey ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          );
          if (event.key === 'ArrowUp' && plain && props.onLeave) {
            event.preventDefault();
            props.onLeave();
          }
          if (event.key !== 'Enter') return;
          event.preventDefault();
          submit();
        }}
        on:keyup={(event) => event.stopPropagation()}
      />
      <Show
        when={props.asking}
        fallback={
          <Show
            when={props.onContinueInChat}
            fallback={
              <TourIconButton
                label="Go deeper"
                tooltip="Go deeper"
                disabled={props.disabled}
                onClick={() => props.onGoDeeper()}
              >
                <LayersIcon size={15} />
              </TourIconButton>
            }
          >
            {(onContinue) => (
              <TourIconButton
                label="Continue in chat"
                tooltip="Continue in the agent chat with this card"
                onClick={() => onContinue()()}
              >
                <MentionIcon size={14} />
              </TourIconButton>
            )}
          </Show>
        }
      >
        {/* The spinner carries the wait; the wording is for screen readers only. */}
        <span role="status" class="understanding-asking">
          <span class="inline-spinner" aria-hidden="true" />
          <span class="dialog-sr-only">Thinking…</span>
        </span>
        <TourIconButton label="Cancel question" tooltip="Cancel" onClick={() => props.onCancel()}>
          <CloseIcon size={14} />
        </TourIconButton>
      </Show>
    </div>
  );
}
