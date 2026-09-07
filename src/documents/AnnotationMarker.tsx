import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { AnnotationBubble } from './AnnotationBubble';
import type { DocumentAnnotation } from './types';

interface AnnotationMarkerProps {
  annotations: DocumentAnnotation[];
  onMakeTask: (annotation: DocumentAnnotation) => void;
}

function describe(annotations: readonly DocumentAnnotation[]): string {
  const questions = annotations.filter((a) => a.kind === 'question').length;
  const notes = annotations.length - questions;
  const parts: string[] = [];
  if (notes > 0) parts.push(`${notes} note${notes === 1 ? '' : 's'}`);
  if (questions > 0) parts.push(`${questions} question${questions === 1 ? '' : 's'}`);
  return `${parts.join(' and ')} on this passage`;
}

/** A question the agent has not come back on yet. */
function isAwaitingAnswer(annotation: DocumentAnnotation): boolean {
  return annotation.kind === 'question' && annotation.answerStatus === 'pending';
}

/**
 * The notes on a passage as a symbol in its margin. They open over the
 * document on hover, on keyboard focus, or pinned by a click, so the prose
 * reads exactly as it does without them.
 */
export function AnnotationMarker(props: AnnotationMarkerProps) {
  let root: HTMLDivElement | undefined;
  const [pinned, setPinned] = createSignal(false);
  const awaiting = () => props.annotations.some(isAwaitingAnswer);
  const label = () =>
    `${describe(props.annotations)}${awaiting() ? ', waiting for an answer' : ''}`;

  // A pinned bubble covers the prose, so anything else the reader does closes it.
  createEffect(() => {
    if (!pinned()) return;
    const close = (e: MouseEvent) => {
      if (!root?.contains(e.target as Node)) setPinned(false);
    };
    document.addEventListener('mousedown', close);
    onCleanup(() => document.removeEventListener('mousedown', close));
  });

  return (
    <div
      ref={root}
      class="docws-marker"
      classList={{
        'is-pinned': pinned(),
        'is-question': props.annotations.some((a) => a.kind === 'question'),
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !pinned()) return;
        e.stopPropagation();
        setPinned(false);
      }}
    >
      <button
        type="button"
        class="docws-marker-btn"
        aria-label={label()}
        aria-expanded={pinned()}
        onClick={(e) => {
          const open = !pinned();
          setPinned(open);
          // Focus alone holds the bubble open, so a click that closes it has to
          // give the focus back. A keyboard activation (detail 0) keeps it.
          if (!open && e.detail > 0) e.currentTarget.blur();
        }}
      >
        {/* A question waiting on its agent spins in the margin, so the wait is
            visible without opening the bubble to read "Answering…". */}
        <Show
          when={awaiting()}
          fallback={
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2.4" />
              <path d="M4.6 6.4h6.8M4.6 9.4h4.2" />
            </svg>
          }
        >
          <span class="inline-spinner" aria-hidden="true" />
        </Show>
        <Show when={props.annotations.length > 1}>
          <span class="docws-marker-count">{props.annotations.length}</span>
        </Show>
      </button>
      <div class="docws-marker-pop" role="group" aria-label={label()}>
        <For each={props.annotations}>
          {(annotation) => (
            <AnnotationBubble annotation={annotation} onMakeTask={props.onMakeTask} />
          )}
        </For>
      </div>
    </div>
  );
}
