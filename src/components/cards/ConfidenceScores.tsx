import { For, Show, type JSX } from 'solid-js';
import type { ReviewScore, ReviewScores } from '../../lib/review-summary';
import { LOW_CONFIDENCE_SCORE } from '../../lib/task-confidence';
import { HoverHint } from '../understanding/HoverHint';

/** Why a score is not higher, and what the rater checked to back it. */
function ScoreDetail(props: { entry: ReviewScore }) {
  return (
    <>
      <strong class="tour-hint-heading">
        {props.entry.label} {props.entry.score}%
      </strong>
      <p class="tour-hint-body">{props.entry.why}</p>
      <Show when={props.entry.verified}>
        {(checked) => (
          <>
            <p class="tour-hint-action">Checked:</p>
            <ul class="confidence-checked">
              <For each={checked()}>{(item) => <li>{item}</li>}</For>
            </ul>
          </>
        )}
      </Show>
    </>
  );
}

/** One score in the row; its detail opens on hover or focus. */
function Score(props: { entry: ReviewScore; lead?: boolean; children: JSX.Element }) {
  return (
    <HoverHint hint={() => <ScoreDetail entry={props.entry} />}>
      {(describedBy) => (
        <span
          class={props.lead ? 'confidence-score confidence-lead' : 'confidence-score'}
          // Focusable, so the keyboard reaches the detail too.
          tabindex="0"
          aria-describedby={describedBy()}
          data-low={props.entry.score < LOW_CONFIDENCE_SCORE ? '' : undefined}
        >
          {props.children}
        </span>
      )}
    </HoverHint>
  );
}

/**
 * The rating as a glance: the weakest score stands for the whole and leads,
 * the others follow on the same row. Reasons and evidence wait in each score's
 * popover; only a low rating keeps one line of its reason in the card, since
 * that is the one thing to act on. The Finish review shows the rating in full.
 */
export function ConfidenceScores(props: { scores: ReviewScores }) {
  const weakest = () => props.scores.weakest;
  const others = () => props.scores.all.filter((entry) => entry !== weakest());
  return (
    <div class="confidence">
      <div class="confidence-scores" role="group" aria-label="Scores">
        <Show when={weakest()}>
          {(entry) => (
            <Score entry={entry()} lead>
              <span class="confidence-number">{entry().score}%</span>{' '}
              <strong>{entry().label}</strong>
            </Score>
          )}
        </Show>
        <For each={others()}>
          {(entry) => (
            <Score entry={entry}>
              {entry.label} <span class="confidence-number">{entry.score}%</span>
            </Score>
          )}
        </For>
      </div>
      <Show when={props.scores.low && weakest()}>
        {(entry) => <p class="confidence-why">{entry().why}</p>}
      </Show>
    </div>
  );
}
