import { For } from 'solid-js';

/** Which part of the spine a segment stands for; drives its fill. */
function segmentState(index: number, current: number): 'seen' | 'current' | 'rest' {
  if (index === current) return 'current';
  return index < current ? 'seen' : 'rest';
}

/**
 * The only chrome above the card: what the tour is about, a hairline bar for
 * where you are in it and "n / m". Each segment jumps to its card, so a reader
 * can go straight to the bottom line or back to the gist.
 *
 * @param current zero-based index into the spine
 */
export function TourProgress(props: {
  /** Mono path or title the tour is about. */
  subject: string;
  /** One title per card, used to name the segments. */
  titles: string[];
  current: number;
  onSelect: (index: number) => void;
  /** Cards with answered follow-ups under them get a marker. */
  answered?: ReadonlySet<number>;
}) {
  const total = () => props.titles.length;
  return (
    <div class="understanding-progress">
      <span class="understanding-subject" title={props.subject}>
        {props.subject}
      </span>
      <span class="understanding-segments">
        <For each={props.titles}>
          {(title, index) => (
            <button
              type="button"
              data-state={segmentState(index(), props.current)}
              data-answered={props.answered?.has(index()) ? '' : undefined}
              aria-current={index() === props.current ? 'step' : undefined}
              aria-label={`Card ${index() + 1} of ${total()}: ${title}${props.answered?.has(index()) ? ' (has answers)' : ''}`}
              title={title}
              onClick={() => props.onSelect(index())}
            />
          )}
        </For>
      </span>
      <span class="understanding-count">{`${props.current + 1} / ${total()}`}</span>
    </div>
  );
}
