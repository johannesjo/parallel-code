import type { MapNode, MindMapDocument } from '../../electron/shared/mindmap';
import { MAX_TOUR_DEPTH, findNode, type TourNode } from './tour-tree';
import { blankCard, editableText, withText } from './tour-tree-edit';

/**
 * A tour the reader writes, shown as a mind map: the tour's title is the
 * centre and every card an idea under it, so the map can only ever hold a
 * tree. The centre is not a card; renaming it changes nothing, as the first
 * card's title names the tour.
 */
export const TOUR_MAP_ROOT = 'tour';

export function tourToMindMap(
  subject: string,
  roots: readonly TourNode[],
  revision = 0,
): MindMapDocument {
  const records: MapNode[] = [
    { id: TOUR_MAP_ROOT, title: subject.trim() || 'Thinking tour', detail: '' },
  ];
  const add = (nodes: readonly TourNode[], parent: string): void => {
    for (const node of nodes) {
      records.push({
        id: node.id,
        parent,
        title: node.card.title,
        detail: editableText(node.card),
      });
      add(node.children, node.id);
    }
  };
  add(roots, TOUR_MAP_ROOT);
  return { version: 1, revision, records, relations: [] };
}

/**
 * The map's ideas back as the tour's cards, in the map's order. A card keeps
 * everything the map does not show; an idea new to the map is a new card.
 * Ideas nested deeper than a tour can go join the deepest card above them.
 */
export function mindMapToTour(map: MindMapDocument, previous: readonly TourNode[]): TourNode[] {
  const byParent = new Map<string, MapNode[]>();
  for (const record of map.records) {
    if (!record.parent) continue;
    byParent.set(record.parent, [...(byParent.get(record.parent) ?? []), record]);
  }
  const build = (parent: string, depth: number): TourNode[] =>
    (byParent.get(parent) ?? []).flatMap((record) => {
      const old = findNode(previous, record.id);
      const card = withText({ ...(old?.card ?? blankCard()), title: record.title }, record.detail);
      const node: TourNode = {
        id: record.id,
        card,
        ...(old?.question !== undefined && { question: old.question }),
        children: [],
      };
      if (depth < MAX_TOUR_DEPTH) return [{ ...node, children: build(record.id, depth + 1) }];
      return [node, ...build(record.id, depth)];
    });
  const rootId = map.records[0]?.id ?? TOUR_MAP_ROOT;
  return build(rootId, 1);
}
