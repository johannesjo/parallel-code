import { For, Show } from 'solid-js';
import { sf } from '../lib/fontScale';
import type { ReviewScore, ReviewScores } from '../lib/review-summary';
import { LOW_CONFIDENCE_SCORE } from '../lib/task-confidence';
import { theme } from '../lib/theme';

const tabular = { 'font-weight': '600', 'font-variant-numeric': 'tabular-nums' } as const;

/** What backs a score, so a grounded score reads apart from a guess. */
function checkedText(entry: ReviewScore): string {
  return entry.verified ? `Checked: ${entry.verified.join('; ')}` : '';
}

function Checked(props: { entry: ReviewScore }) {
  return (
    <Show when={checkedText(props.entry)}>
      {(text) => <span style={{ 'font-size': sf(12), color: theme.fgSubtle }}> {text()}</span>}
    </Show>
  );
}

/**
 * The rating at a glance, as a confidence audit reads: the weakest score
 * stands for the whole and says why it is not higher. Other scores keep their
 * reason only while below the bar; the rest share one quiet line, reason on
 * hover, since a score that needs no attention needs no reading either.
 */
export function ReviewScoreCard(props: {
  scores: ReviewScores;
  /** What the reviewer read the ask as; on hover, for when a score seems off. */
  goal?: string;
}) {
  const weakest = () => props.scores.weakest;
  const others = () => props.scores.all.filter((entry) => entry !== weakest());
  const low = () => others().filter((entry) => entry.score < LOW_CONFIDENCE_SCORE);
  const fine = () => others().filter((entry) => entry.score >= LOW_CONFIDENCE_SCORE);
  const scoreText = (entry: ReviewScore) => (
    <span
      style={{
        ...tabular,
        color: entry.score < LOW_CONFIDENCE_SCORE ? theme.warning : theme.fg,
      }}
    >
      {entry.score}%
    </span>
  );
  return (
    <section
      aria-label="Confidence"
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '6px',
        opacity: props.scores.stale ? '0.7' : '1',
      }}
    >
      <div
        title={props.goal ? `Rated against: ${props.goal}` : undefined}
        style={{ display: 'flex', 'align-items': 'baseline', gap: '10px', 'flex-wrap': 'wrap' }}
      >
        <Show when={weakest()}>
          {(entry) => (
            <>
              <span
                style={{
                  ...tabular,
                  'font-size': sf(22),
                  'line-height': '1',
                  color: props.scores.low ? theme.warning : theme.fg,
                }}
              >
                {entry().score}%
              </span>
              <span style={{ flex: '1', 'min-width': '0', color: theme.fgMuted }}>
                confident
                <Show when={entry().score < 100 && props.scores.all.length > 1}>
                  {' '}
                  · held back by{' '}
                  <strong style={{ 'font-weight': '600', color: theme.fg }}>{entry().label}</strong>
                </Show>
              </span>
            </>
          )}
        </Show>
        <span style={{ 'font-size': sf(12), color: theme.fgSubtle }}>
          {[props.scores.source, props.scores.stale && 'the code changed since']
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <Show when={weakest()}>
        {(entry) => (
          <p style={{ margin: '0', color: theme.fgMuted }}>
            {entry().why}
            <Checked entry={entry()} />
          </p>
        )}
      </Show>
      <Show when={low().length > 0}>
        <ul style={{ margin: '0', padding: '0', 'list-style': 'none' }}>
          <For each={low()}>
            {(entry) => (
              <li style={{ color: theme.fgMuted }}>
                <span style={{ color: theme.fg }}>{entry.label}</span> {scoreText(entry)} ·{' '}
                {entry.why}
                <Checked entry={entry} />
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={fine().length > 0}>
        <ul
          aria-label="Other scores"
          style={{
            margin: '0',
            padding: '0',
            'list-style': 'none',
            display: 'flex',
            'flex-wrap': 'wrap',
            gap: '4px 16px',
            'font-size': sf(12),
            color: theme.fgSubtle,
          }}
        >
          <For each={fine()}>
            {(entry) => (
              <li title={[entry.why, checkedText(entry)].filter(Boolean).join(' ')}>
                {entry.label} {scoreText(entry)}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
