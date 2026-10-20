import { nodeTrail, type MapData, type MapNode } from '../graph/model';

/** The branch below `rootId` as its own map; the root loses its parent so layout starts there. */
export function branchSnapshot<S extends MapData<N>, N extends MapNode>(
  snapshot: S,
  rootId: string,
): S {
  const ids = new Set(
    snapshot.records
      .filter((node) => nodeTrail(snapshot.records, node.id).some((step) => step.id === rootId))
      .map((node) => node.id),
  );
  if (!ids.has(rootId)) return snapshot;
  return {
    ...snapshot,
    records: snapshot.records
      .filter((node) => ids.has(node.id))
      .map((node) => (node.id === rootId ? { ...node, parent: undefined } : node)),
    relations: snapshot.relations.filter((link) => ids.has(link.source) && ids.has(link.target)),
  };
}

/** Case-insensitive matches on title or notes; title hits come first. */
export function searchRecords<N extends MapNode>(records: N[], query: string, limit = 8): N[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const inTitle = records.filter((node) => node.title.toLowerCase().includes(needle));
  const inDetail = records.filter(
    (node) => !inTitle.includes(node) && node.detail.toLowerCase().includes(needle),
  );
  return [...inTitle, ...inDetail].slice(0, limit);
}
