import { positionsFor as layout } from '../graph/layout';
import { notePresentation } from './presentation';
import type { Snapshot } from './state';

export function positionsFor(
  snapshot: Snapshot,
  compact = false,
  heights: ReadonlyMap<string, number> = new Map(),
) {
  return layout(snapshot, (node) => notePresentation(node.kind, compact), compact, heights);
}
