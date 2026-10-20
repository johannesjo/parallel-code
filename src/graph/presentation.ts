import type { MapNode, MapNodeKind } from './model';

/** Type labels and shapes identify notes independently of assessment and activity. */
export const noteTypes = {
  goal: { label: 'Goal', mark: '◎', color: '--fg-muted', width: 240, height: 60 },
  question: { label: 'Question', mark: '?', color: '--fg', width: 240, height: 56 },
  hypothesis: {
    label: 'Hypothesis',
    mark: '◇',
    color: '--info',
    width: 196,
    height: 68,
  },
  option: { label: 'Option', mark: '⬡', color: '--review', width: 196, height: 68 },
  observation: {
    label: 'Evidence',
    mark: '▤',
    color: '--fg-muted',
    width: 184,
    height: 56,
  },
  experiment: {
    label: 'Experiment',
    mark: '△',
    color: '--warning',
    width: 196,
    height: 60,
  },
  decision: { label: 'Decision', mark: '◆', color: '--review', width: 196, height: 60 },
  work: { label: 'Work item', mark: '□', color: '--accent', width: 196, height: 60 },
} satisfies Record<
  Exclude<MapNodeKind, 'idea'>,
  { label: string; mark: string; color: string; width: number; height: number }
>;

/** Optional display attributes supplied by specialized graph views. */
export interface NodeAppearance {
  label: string;
  mark: string;
  color: string;
  width: number;
  height: number;
  kind?: string;
  status?: string;
  confidence?: number;
}

export function defaultAppearance(
  node: Pick<MapNode, 'kind' | 'parent'>,
  compact = false,
): NodeAppearance {
  if (node.kind && node.kind !== 'idea') {
    const type = noteTypes[node.kind];
    return { ...type, kind: node.kind, width: compact ? 160 : type.width };
  }
  return {
    label: '',
    mark: '',
    kind: 'idea',
    color: '--accent',
    width: compact ? 160 : 220,
    height: node.parent ? 48 : 60,
  };
}
