import { For, Show } from 'solid-js';
import { TourCard } from './TourCard';
import type { TourBranch, TourRef } from '../../lib/understanding-tour';

/**
 * The follow-ups under one card, in the order asked, plus the question still
 * waiting for its answer.
 */
export function TourThreads(props: {
  threads: TourBranch[];
  /** The question in flight under this card, or ''. */
  pendingQuestion: string;
  onOpenRef: (ref: TourRef) => void;
}) {
  return (
    <>
      <For each={props.threads}>
        {(thread) => (
          <section class="understanding-thread" aria-label={thread.question}>
            <p class="understanding-thread-question" title={thread.question}>
              ↳ {thread.question}
            </p>
            <For each={thread.cards}>
              {(answer) => <TourCard card={answer} onOpenRef={props.onOpenRef} />}
            </For>
          </section>
        )}
      </For>
      <Show when={props.pendingQuestion}>
        {(question) => (
          <section class="understanding-thread" aria-label={question()} aria-busy="true">
            <p class="understanding-thread-question" title={question()}>
              ↳ {question()}
            </p>
            <div class="understanding-card understanding-card--message">
              <span class="inline-spinner" aria-hidden="true" />
              <span class="dialog-sr-only">Thinking…</span>
            </div>
          </section>
        )}
      </Show>
    </>
  );
}
