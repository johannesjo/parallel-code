/** Graph transactions: navigation trails, document validation, and atomic operation batches. */
import { GRAPH_LIMITS, GRAPH_MAX_BYTES } from './graph-limits.js';
import {
  assert,
  graphObject,
  keys,
  validGraphId,
  validateExplanation,
  validateLink,
  validateNode,
} from './graph-parse.js';
import type {
  GraphDocument,
  MapLink,
  MapNode,
  MapOperation,
  NodeExplanation,
  ProtectedItem,
} from './graph-types.js';
export function nodeTrail<N extends MapNode>(records: N[], target: string): N[] {
  const byId = new Map(records.map((node) => [node.id, node]));
  const trail: N[] = [];
  const seen = new Set<string>();
  let node = byId.get(target);
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    trail.unshift(node);
    node = byId.get(node.parent ?? '');
  }
  return trail;
}
export function visibleNodes<N extends MapNode>(records: N[], collapsed: ReadonlySet<string>): N[] {
  return records.filter((node) =>
    nodeTrail(records, node.id)
      .slice(0, -1)
      .every((parent) => !collapsed.has(parent.id)),
  );
}
export function validateGraph(document: GraphDocument, allowEmpty = false): void {
  assert(
    document.version === 1 && Number.isSafeInteger(document.revision) && document.revision >= 0,
    'Invalid graph version or revision.',
  );
  assert(
    Array.isArray(document.records) &&
      document.records.length <= GRAPH_LIMITS.nodes &&
      (allowEmpty || document.records.length),
    `Graph must have 1–${GRAPH_LIMITS.nodes} nodes.`,
  );
  assert(
    Array.isArray(document.relations) &&
      document.relations.length <= GRAPH_LIMITS.relations &&
      (document.explanations === undefined ||
        (Array.isArray(document.explanations) &&
          document.explanations.length <= GRAPH_LIMITS.explanations)),
    `Graph exceeds ${GRAPH_LIMITS.relations} relations or ${GRAPH_LIMITS.explanations} explanations.`,
  );
  for (const node of document.records) validateNode(node, true);
  const ids = new Set(document.records.map((node) => node.id));
  assert(ids.size === document.records.length, 'Duplicate node ID.');
  assert(
    !document.records.length || document.records.filter((node) => !node.parent).length === 1,
    'Graph must have exactly one root.',
  );
  for (const node of document.records) {
    const trail = nodeTrail(document.records, node.id);
    assert(!trail[0].parent, 'Invalid parent reference or navigation cycle.');
  }
  for (const link of document.relations) {
    validateLink(link, true);
    assert(ids.has(link.source) && ids.has(link.target), 'Invalid relation reference.');
  }
  for (const entry of document.explanations ?? []) {
    validateExplanation(entry, true);
    assert(ids.has(entry.nodeId), 'Explanation refers to an unavailable node.');
  }
  for (const name of ['relations', 'explanations'] as const) {
    const items = document[name] ?? [];
    assert(new Set(items.map((item) => item.id)).size === items.length, 'Duplicate graph ID.');
  }
  if (document.userDeleted !== undefined) {
    assert(graphObject(document.userDeleted), 'Invalid deleted IDs.');
    keys(document.userDeleted, ['records', 'relations', 'explanations']);
    for (const [name, value] of Object.entries(document.userDeleted)) {
      assert(
        Array.isArray(value) &&
          value.length <= GRAPH_LIMITS.tombstones &&
          value.every(validGraphId),
        'Invalid deleted IDs.',
      );
      const live = document[name as keyof typeof document.userDeleted] ?? [];
      const revived = value.find((id) => live.some((item) => item.id === id));
      assert(!revived, `Deleted ID ${revived} is still a live ${name.replace(/s$/, '')}.`);
    }
  }
  assert(
    new TextEncoder().encode(JSON.stringify(document)).length <= GRAPH_MAX_BYTES,
    `Graph document exceeds ${GRAPH_MAX_BYTES / 1024 / 1024} MB serialized; shorten detail, result, or answer text, or remove nodes, relations, or explanations.`,
  );
}
export interface ApplyOptions {
  /** Replaying persisted history must accept relations that predate the strict checks. */
  strictRelations?: boolean;
}
const linkKey = (link: MapLink) => `${link.id}\0${link.source}\0${link.target}\0${link.kind ?? ''}`;
/**
 * Self-loops and duplicate (source, target, kind) triples are rejected only when a batch
 * introduces them: graphs persisted before these checks may hold some, and must stay editable.
 */
const pairKey = (link: MapLink) => `${link.source}\0${link.target}\0${link.kind ?? ''}`;
function assertRelationsDistinct(before: MapLink[], after: MapLink[]): void {
  const untouched = new Set(before.map(linkKey));
  // Count the whole batch up front: a changed relation may duplicate one stored after it,
  // which comparing against only the links seen so far would miss.
  const counts = new Map<string, number>();
  for (const link of after) counts.set(pairKey(link), (counts.get(pairKey(link)) ?? 0) + 1);
  for (const link of after) {
    if (untouched.has(linkKey(link))) continue;
    assert(link.source !== link.target, `Relation ${link.id} links ${link.source} to itself.`);
    assert(
      (counts.get(pairKey(link)) ?? 0) <= 1,
      `Relation ${link.id} duplicates link (${link.source} → ${link.target}, ${link.kind ?? 'untyped'}). Update the existing relation instead.`,
    );
  }
}
export function applyMapOperations<D extends GraphDocument>(
  document: D,
  operations: MapOperation[],
  expectedRevision = document.revision,
  actor: 'user' | 'agent' = 'user',
  options: ApplyOptions = {},
): D {
  assert(
    document.revision === expectedRevision,
    'The graph has changed. Read it again before editing.',
  );
  const next = structuredClone(document);
  function check(item: ProtectedItem, changed: string[], override?: boolean) {
    assert(
      actor === 'user' ||
        override ||
        !item.userEdited?.some((field) => field === '*' || changed.includes(field)),
      `User-edited item ${item.id} is protected; use overrideUser explicitly.`,
    );
  }
  function mark<T extends ProtectedItem>(item: T, changed: string[], exact?: string[]): T {
    if (actor !== 'user') return item;
    const fields = exact ?? [...new Set([...(item.userEdited ?? []), ...changed])];
    const marked = { ...item };
    if (fields.length) marked.userEdited = fields;
    else delete marked.userEdited;
    return marked;
  }
  const known = (target: string) =>
    (['records', 'relations', 'explanations'] as const).some(
      (name) =>
        document[name]?.some((item) => item.id === target) ||
        document.userDeleted?.[name]?.includes(target),
    );
  function required<T extends ProtectedItem>(items: T[], target: string): T {
    const item = items.find((item) => item.id === target);
    assert(
      item,
      known(target)
        ? `Graph item ${target} is no longer available.`
        : `Unknown graph item ${target}. Read the graph again to find current IDs.`,
    );
    return item;
  }
  function tombstone(
    name: 'records' | 'relations' | 'explanations',
    item: ProtectedItem,
    enabled = true,
  ) {
    // User-created IDs are random; agents never reuse them, so a tombstone would only accumulate.
    if (actor !== 'user' || !enabled || item.userEdited?.includes('*')) return;
    // shortcut: FIFO cap — the oldest deletions become resurrectable once the tombstone limit is reached
    const ids = [...new Set([...(next.userDeleted?.[name] ?? []), item.id])].slice(
      -GRAPH_LIMITS.tombstones,
    );
    next.userDeleted = { ...next.userDeleted, [name]: ids };
  }
  function insert<T extends ProtectedItem>(
    items: T[],
    item: T,
    name: 'records' | 'relations' | 'explanations',
    override?: boolean,
    exact?: string[],
  ) {
    assert(!items.some((old) => old.id === item.id), 'Duplicate graph ID.');
    assert(
      actor === 'user' || override || !next.userDeleted?.[name]?.includes(item.id),
      'User-deleted ID is protected; use overrideUser explicitly.',
    );
    if (next.userDeleted?.[name])
      next.userDeleted[name] = next.userDeleted[name]?.filter((id) => id !== item.id);
    items.push(mark(item, ['*'], exact));
  }
  function patch<T extends ProtectedItem>(
    items: T[],
    target: string,
    changes: object,
    override?: boolean,
    exact?: string[],
  ) {
    const item = required(items, target);
    const changed = Object.entries(changes)
      .filter(
        ([key, value]) =>
          JSON.stringify(Reflect.get(item, key)) !==
          JSON.stringify(value === null ? undefined : value),
      )
      .map(([key]) => key);
    check(item, changed, override);
    const patched = { ...item };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) Reflect.deleteProperty(patched, key);
      else Reflect.set(patched, key, value);
    }
    items[items.indexOf(item)] = mark(patched, changed, exact);
  }
  for (const op of operations) {
    assert(
      actor === 'user' || (op.userEdited === undefined && op.tombstone === undefined),
      'Only user edits can restore protection.',
    );
    if (op.type === 'insert') {
      if (next.records.length) {
        assert(op.node.parent, 'The central topic cannot be duplicated.');
        required(next.records, op.node.parent);
      }
      insert(next.records, { ...op.node }, 'records', op.overrideUser, op.userEdited);
      if (op.after !== undefined) {
        const sibling = required(next.records, op.after);
        assert(
          sibling.parent === op.node.parent && sibling.id !== op.node.id,
          'The target must be a sibling.',
        );
        const node = next.records.pop();
        if (node) next.records.splice(next.records.indexOf(sibling) + 1, 0, node);
      }
    } else if (op.type === 'update')
      patch(next.records, op.id, op.changes, op.overrideUser, op.userEdited);
    else if (op.type === 'move') {
      assert(op.after !== op.id, 'A node cannot be placed after itself.');
      const node = required(next.records, op.id);
      assert(node.parent, 'The central topic cannot be moved.');
      required(next.records, op.parent);
      for (const parentId of new Set([node.parent, op.parent])) {
        const parent = required(next.records, parentId);
        check(parent, ['children'], op.overrideUser);
        if (actor === 'user' && op.userEdited === undefined)
          next.records[next.records.indexOf(parent)] = mark(parent, ['children']);
      }
      assert(
        !nodeTrail(next.records, op.parent).some((parent) => parent.id === op.id),
        'A branch cannot be moved into itself.',
      );
      patch(next.records, op.id, { parent: op.parent }, op.overrideUser, op.userEdited);
      const moved = required(next.records, op.id);
      next.records = next.records.filter((node) => node.id !== op.id);
      const sibling = op.after === undefined ? undefined : required(next.records, op.after);
      assert(!sibling || sibling.parent === op.parent, 'The target must be a sibling.');
      next.records.splice(
        sibling ? next.records.indexOf(sibling) + 1 : next.records.length,
        0,
        moved,
      );
    } else if (op.type === 'remove') {
      assert(required(next.records, op.id).parent, 'The central topic cannot be removed.');
      const removed = new Set(
        next.records
          .filter((node) => nodeTrail(next.records, node.id).some((parent) => parent.id === op.id))
          .map((node) => node.id),
      );
      for (const name of ['records', 'relations', 'explanations'] as const) {
        const items: ProtectedItem[] = (next[name] ?? []).filter((item) =>
          name === 'records'
            ? removed.has(item.id)
            : name === 'relations'
              ? removed.has((item as MapLink).source) || removed.has((item as MapLink).target)
              : removed.has((item as NodeExplanation).nodeId),
        );
        for (const item of items) {
          check(item, item.userEdited ?? [], op.overrideUser);
          tombstone(name, item, op.tombstone);
        }
      }
      next.records = next.records.filter((node) => !removed.has(node.id));
      next.relations = next.relations.filter(
        (link) => !removed.has(link.source) && !removed.has(link.target),
      );
      if (next.explanations)
        next.explanations = next.explanations.filter((entry) => !removed.has(entry.nodeId));
    } else if (op.type === 'insert_relation')
      insert(next.relations, { ...op.relation }, 'relations', op.overrideUser, op.userEdited);
    else if (op.type === 'update_relation')
      patch(next.relations, op.id, op.changes, op.overrideUser, op.userEdited);
    else if (op.type === 'insert_explanation')
      insert(
        (next.explanations ??= []),
        { ...op.explanation },
        'explanations',
        op.overrideUser,
        op.userEdited,
      );
    else if (op.type === 'update_explanation')
      patch(next.explanations ?? [], op.id, op.changes, op.overrideUser, op.userEdited);
    else {
      const name = op.type === 'remove_relation' ? 'relations' : 'explanations';
      const items: ProtectedItem[] = next[name] ?? [];
      const item = required(items, op.id);
      check(item, item.userEdited ?? [], op.overrideUser);
      items.splice(items.indexOf(item), 1);
      tombstone(name, item, op.tombstone);
    }
  }
  for (const node of next.records) if (node.kind === 'idea') delete node.kind;
  next.revision++;
  if (options.strictRelations !== false)
    assertRelationsDistinct(document.relations, next.relations);
  validateGraph(next);
  return next;
}
