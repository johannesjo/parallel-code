import { For, Show } from 'solid-js';
import { GO_DEEPER_QUESTION } from '../../lib/understanding-prompt';
import { questionPoint, type TourNode } from '../../lib/tour-tree';

/**
 * What the reader asked to get to a card, in their words: the point they dug
 * into, "Deeper" for the fixed Go deeper request, or their own question.
 */
export function questionLabel(question: string, parentTitle: string): string {
  if (question === GO_DEEPER_QUESTION) return `Deeper: ${parentTitle}`;
  return questionPoint(question) ?? question;
}

/**
 * The answers under a card, as links into them, plus the question still
 * waiting for its answer. Sits at the foot of the card, so depth is found where
 * the reading ends rather than only in the outline.
 */
export function TourDeeper(props: {
  answers: TourNode[];
  /** The question in flight under this card, or ''. */
  pendingQuestion: string;
  parentTitle: string;
  onSelect: (id: string) => void;
}) {
  return (
    <Show when={props.answers.length > 0 || props.pendingQuestion}>
      <nav class="tour-deeper" aria-label="Answers under this card">
        <For each={props.answers}>
          {(answer) => (
            <button
              type="button"
              class="tour-deeper-link"
              title={questionLabel(answer.question ?? '', props.parentTitle)}
              onClick={() => props.onSelect(answer.id)}
            >
              <span class="tour-deeper-title">{answer.card.title}</span>
              <span class="tour-deeper-arrow" aria-hidden="true">
                ›
              </span>
            </button>
          )}
        </For>
        <Show when={props.pendingQuestion}>
          {(question) => (
            <p class="tour-deeper-pending" aria-busy="true">
              <span class="inline-spinner" aria-hidden="true" />
              <span>{questionLabel(question(), props.parentTitle)}</span>
            </p>
          )}
        </Show>
      </nav>
    </Show>
  );
}
