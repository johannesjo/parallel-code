import { For, Show, type JSX } from 'solid-js';
import type { ScoreEntry } from '../../lib/card-slots';
import { inConfidenceOrder } from '../../lib/task-confidence';
import { HoverHint } from '../understanding/HoverHint';
import { createFlashOnChange } from './flash';

/** Why a score is not higher, and what the rater checked to back it. */
function ScoreDetail(props: { entry: ScoreEntry }) {
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
function Score(props: { entry: ScoreEntry; low: boolean; lead?: boolean; children: JSX.Element }) {
  return (
    <HoverHint hint={() => <ScoreDetail entry={props.entry} />}>
      {(describedBy) => (
        <span
          class={props.lead ? 'confidence-score confidence-lead' : 'confidence-score'}
          // Focusable, so the keyboard reaches the detail too.
          tabindex="0"
          aria-describedby={describedBy()}
          data-low={props.low ? '' : undefined}
        >
          {props.children}
        </span>
      )}
    </HoverHint>
  );
}

/**
 * The rating as a glance, every score on one row with correctness first. The
 * weakest score stands for the whole and is drawn larger. Reasons and evidence
 * wait in each score's popover; only a low rating keeps one line of its reason
 * in the card, since that is the one thing to act on. The Finish review shows
 * the rating in full.
 */
export function ConfidenceScores(props: { scores: ScoreEntry[]; warnBelow?: number }) {
  const low = (entry: ScoreEntry) => props.warnBelow !== undefined && entry.score < props.warnBelow;
  const weakest = () =>
    props.scores.reduce<ScoreEntry | undefined>(
      (min, entry) => (!min || entry.score < min.score ? entry : min),
      undefined,
    );
  const lowWeakest = () => {
    const entry = weakest();
    return entry && low(entry) ? entry : undefined;
  };
  let el: HTMLDivElement | undefined;
  // A new rating gets noticed in a pane left open; the same numbers again are no news.
  createFlashOnChange(
    () => el,
    () => props.scores.map((entry) => `${entry.label}:${entry.score}`).join(),
  );
  return (
    <div ref={el} class="confidence">
      <div class="confidence-scores" role="group" aria-label="Scores">
        <For each={inConfidenceOrder(props.scores)}>
          {(entry) => (
            <Show
              when={entry === weakest()}
              fallback={
                <Score entry={entry} low={low(entry)}>
                  {entry.label} <span class="confidence-number">{entry.score}%</span>
                </Score>
              }
            >
              <Score entry={entry} low={low(entry)} lead>
                <span class="confidence-number">{entry.score}%</span> <strong>{entry.label}</strong>
              </Score>
            </Show>
          )}
        </For>
      </div>
      <Show when={lowWeakest()}>{(entry) => <p class="confidence-why">{entry().why}</p>}</Show>
    </div>
  );
}
