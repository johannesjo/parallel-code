/** Undo support: the operation batch that turns one graph document into another. */
import { nodeTrail } from './graph-apply.js';
import {
  linkFields,
  nodeFields,
  type GraphDocument,
  type MapOperation,
  type ProtectedItem,
} from './graph-types.js';
const sameProtection = (a: ProtectedItem, b: ProtectedItem) =>
  JSON.stringify(a.userEdited ?? []) === JSON.stringify(b.userEdited ?? []);
/**
 * Used for local undo only; callers clear undo history on external revisions.
 * With `restore`, the operations also carry the target's protection and tombstones,
 * so undoing a user edit does not itself count as a user edit.
 */
export function graphDifference(
  before: GraphDocument,
  after: GraphDocument,
  options: { restore?: boolean } = {},
): MapOperation[] {
  const restore = options.restore === true;
  const exact = (item: ProtectedItem) => (restore ? { userEdited: item.userEdited ?? [] } : {});
  const keep = (name: 'records' | 'relations' | 'explanations', id: string) =>
    restore ? { tombstone: !!after.userDeleted?.[name]?.includes(id) } : {};
  const operations: MapOperation[] = [];
  const desired = new Set(after.records.map((node) => node.id));
  const removed = new Set(
    before.records.filter((node) => !desired.has(node.id)).map((node) => node.id),
  );
  for (const node of before.records)
    if (removed.has(node.id) && !removed.has(node.parent ?? ''))
      operations.push({ type: 'remove', id: node.id, ...keep('records', node.id) });
  const current = new Map(
    before.records.filter((node) => !removed.has(node.id)).map((node) => [node.id, node]),
  );
  for (const node of [...after.records].sort(
    (a, b) => nodeTrail(after.records, a.id).length - nodeTrail(after.records, b.id).length,
  )) {
    const old = current.get(node.id);
    if (!old) {
      const { userEdited: _protection, ...data } = node;
      operations.push({ type: 'insert', node: data, ...exact(node) });
    } else {
      const changes = Object.fromEntries(
        nodeFields
          .filter((field) => JSON.stringify(old[field]) !== JSON.stringify(node[field]))
          .map((field) => [field, node[field] ?? null]),
      );
      if (Object.keys(changes).length || (restore && !sameProtection(old, node)))
        operations.push({ type: 'update', id: node.id, changes, ...exact(node) });
    }
  }
  // Restore sibling order as well as parents. Root is never moved.
  for (const node of after.records) {
    if (!node.parent) continue;
    const siblings = after.records.filter((item) => item.parent === node.parent);
    const index = siblings.indexOf(node);
    const old = current.get(node.id);
    if (
      !old ||
      old.parent !== node.parent ||
      before.records
        .filter((item) => item.parent === old.parent && !removed.has(item.id))
        .map((item) => item.id)
        .join() !== siblings.map((item) => item.id).join()
    )
      operations.push({
        type: 'move',
        id: node.id,
        parent: node.parent,
        ...(index ? { after: siblings[index - 1].id } : {}),
        ...exact(node),
      });
  }
  for (const name of ['relations', 'explanations'] as const) {
    const previous = (before[name] ?? []).filter((item) =>
      'nodeId' in item
        ? !removed.has(item.nodeId)
        : !removed.has(item.source) && !removed.has(item.target),
    );
    const next = after[name] ?? [];
    for (const item of previous)
      if (!next.some((value) => value.id === item.id))
        operations.push({
          type: name === 'relations' ? 'remove_relation' : 'remove_explanation',
          id: item.id,
          ...keep(name, item.id),
        });
    for (const item of next) {
      const old = previous.find((value) => value.id === item.id);
      if ('nodeId' in item) {
        if (!old) {
          const { userEdited: _protection, ...explanation } = item;
          operations.push({ type: 'insert_explanation', explanation, ...exact(item) });
        } else if (
          ('answer' in old && old.answer !== item.answer) ||
          (restore && !sameProtection(old, item))
        )
          operations.push({
            type: 'update_explanation',
            id: item.id,
            changes: { answer: item.answer },
            ...exact(item),
          });
      } else if (!old) {
        const { userEdited: _protection, ...relation } = item;
        operations.push({ type: 'insert_relation', relation, ...exact(item) });
      } else if ('source' in old) {
        const changes = Object.fromEntries(
          linkFields
            .filter((field) => old[field] !== item[field])
            .map((field) => [field, item[field] ?? null]),
        );
        if (Object.keys(changes).length || (restore && !sameProtection(old, item)))
          operations.push({ type: 'update_relation', id: item.id, changes, ...exact(item) });
      }
    }
  }
  return operations;
}
