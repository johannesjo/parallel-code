import { createSignal, onMount } from 'solid-js';
import { CloseIcon, RedoIcon } from '../icons';
import { TourIconButton } from './TourIconButton';

/** Enough for "focus on X, for a newcomer, three cards"; the prompt caps it again. */
const MAX_INSTRUCTION_CHARS = 500;

/** Asks how the whole tour should change, then regenerates it with that request. */
export function TourReworkBar(props: {
  onSubmit: (instructions: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = createSignal('');
  let input: HTMLInputElement | undefined;
  onMount(() => input?.focus());

  function submit(): void {
    const instructions = text().trim();
    if (instructions) props.onSubmit(instructions);
  }

  return (
    <div class="tour-rework">
      <input
        ref={input}
        type="text"
        class="understanding-ask-input"
        placeholder="Rework the tour, e.g. focus on error handling"
        aria-label="How should the tour change?"
        maxLength={MAX_INSTRUCTION_CHARS}
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
        // Keys belong to the field: arrows move the caret, Escape closes only this
        // bar. Native, not delegated, so it stops before the dialog's document listener.
        on:keydown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') props.onCancel();
          if (event.key !== 'Enter') return;
          event.preventDefault();
          submit();
        }}
        on:keyup={(event) => event.stopPropagation()}
      />
      <TourIconButton primary label="Regenerate tour" onClick={submit}>
        <RedoIcon />
      </TourIconButton>
      <TourIconButton label="Cancel rework" onClick={() => props.onCancel()}>
        <CloseIcon size={14} />
      </TourIconButton>
    </div>
  );
}
