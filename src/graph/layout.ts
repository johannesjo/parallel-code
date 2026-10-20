import { hierarchy, tree } from 'd3-hierarchy';
import type { MapData, MapNode } from './model';

export interface Position {
  x: number;
  y: number;
}
export type MapOrientation = 'vertical' | 'horizontal';

/** Prefer nearby nodes aligned with the requested screen direction. */
export function adjacentNode(
  positions: ReadonlyMap<string, Position>,
  id: string,
  key: string,
): string | undefined {
  const origin = positions.get(id);
  const directions: Partial<Record<string, Position>> = {
    ArrowLeft: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
    ArrowUp: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 },
  };
  const direction = directions[key];
  if (!origin || !direction) return;
  let nearest: string | undefined;
  let best = Infinity;
  for (const [candidate, point] of positions) {
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    if (dx * direction.x + dy * direction.y <= 0.5) continue;
    const cross = Math.abs(dx * direction.y - dy * direction.x);
    const score = Math.hypot(dx, dy) + 2 * cross;
    if (score < best) {
      best = score;
      nearest = candidate;
    }
  }
  return nearest;
}

/** Only reported navigation records enter layout; collapse retains their space. */
export function positionsFor<N extends MapNode>(
  snapshot: MapData<N>,
  size: (node: N) => { width: number; height: number },
  compact = false,
  heights: ReadonlyMap<string, number> = new Map(),
  orientation: MapOrientation = 'vertical',
): Map<string, Position> {
  const root = snapshot.records.find((r) => !r.parent);
  if (!root) return new Map();
  const nodes = hierarchy(root, (r) => snapshot.records.filter((child) => child.parent === r.id));
  const horizontal = orientation === 'horizontal';
  const height = (node: N) => heights.get(node.id) ?? size(node).height;
  const layout = tree<(typeof snapshot.records)[number]>()
    .nodeSize([1, 100])
    .separation((a, b) => {
      const breadth = horizontal
        ? height(a.data) + height(b.data)
        : size(a.data).width + size(b.data).width;
      return breadth / 2 + (a.parent === b.parent ? (compact ? 16 : 20) : 32);
    })(nodes);
  const rows: number[] = [];
  const depths = new Map(layout.descendants().map((node) => [node.data.id, node.depth]));
  const peerRows = new Set(
    snapshot.relations
      .filter(
        (link) =>
          link.source !== link.target && depths.get(link.source) === depths.get(link.target),
      )
      .map((link) => depths.get(link.source)),
  );
  for (const node of layout.descendants()) {
    rows[node.depth] = Math.max(
      rows[node.depth] ?? 0,
      horizontal ? size(node.data).width : height(node.data),
    );
  }
  const centers = [0];
  for (let depth = 1; depth < rows.length; depth++)
    centers[depth] =
      centers[depth - 1] +
      rows[depth - 1] / 2 +
      rows[depth] / 2 +
      72 +
      // Horizontal relation labels sit beside their lane and need additional width.
      (peerRows.has(depth - 1) ? (horizontal ? 96 : 48) : 0);
  return new Map(
    layout
      .descendants()
      .map((node) => [
        node.data.id,
        horizontal ? { x: centers[node.depth], y: node.x } : { x: node.x, y: centers[node.depth] },
      ]),
  );
}
