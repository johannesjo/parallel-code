import { For, Show } from 'solid-js';
import type { NodeExplanation } from '../../electron/shared/reasoning-state';
import type { InvestigationRecord } from './state';

interface Badge {
  glyph: string;
  count: number;
  tooltip: string;
}

const plural = (count: number, noun: string, many = `${noun}s`) =>
  `${count} ${count === 1 ? noun : many}`;

/** Compact counts of attached data; the Details card holds the readable content.
 *  Sources have their own corner mark on the card, so they are not counted here. */
function nodeBadges(record: InvestigationRecord, explanations: NodeExplanation[]): Badge[] {
  const criteria = record.criteria ?? [];
  const evaluations = record.evaluations ?? [];
  const candidates: Badge[] = [
    {
      glyph: '✓',
      count: criteria.length,
      tooltip: plural(criteria.length, 'acceptance criterion', 'acceptance criteria'),
    },
    { glyph: '⚖', count: evaluations.length, tooltip: plural(evaluations.length, 'evaluation') },
    {
      glyph: 'Q&A',
      count: explanations.length,
      tooltip: plural(explanations.length, 'saved answer'),
    },
  ];
  return candidates.filter((badge) => badge.count > 0);
}

/** Read-only glyph counts on a card; they never take focus or change the card's width. */
export function NodeBadges(props: {
  record: InvestigationRecord;
  explanations: NodeExplanation[];
}) {
  const badges = () => nodeBadges(props.record, props.explanations);
  return (
    <Show when={badges().length}>
      <span class="reasoning-node-badges">
        <For each={badges()}>
          {(badge) => (
            <span
              class="reasoning-node-badge"
              role="img"
              title={badge.tooltip}
              aria-label={badge.tooltip}
            >
              {badge.glyph} {badge.count}
            </span>
          )}
        </For>
      </span>
    </Show>
  );
}
