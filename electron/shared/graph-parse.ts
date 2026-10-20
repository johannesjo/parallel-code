/** Parsing and field validation of untrusted graph operations and persisted items. */
import { GRAPH_ID_REGEX, GRAPH_LIMITS } from './graph-limits.js';
import {
  linkFields,
  mapNodeKinds,
  nodeFields,
  reasoningStatuses,
  type GraphUpdate,
  type MapLink,
  type MapNode,
  type MapOperation,
  type NodeExplanation,
} from './graph-types.js';
export const graphObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const validGraphId = (value: unknown): value is string =>
  typeof value === 'string' &&
  GRAPH_ID_REGEX.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  assert(
    !unknown.length,
    `Unknown graph field: ${unknown.map((key) => JSON.stringify(key)).join(', ')}. Allowed fields: ${allowed.join(', ')}.`,
  );
}
function text(value: unknown, max: number, nonempty = false): asserts value is string {
  assert(
    typeof value === 'string' && value.length <= max && (!nonempty || !!value.trim()),
    `Expected ${nonempty ? 'nonempty ' : ''}text up to ${max} characters.`,
  );
}
function id(value: unknown): asserts value is string {
  assert(validGraphId(value), 'Invalid graph ID.');
}
function validateSources(value: unknown) {
  assert(
    Array.isArray(value) && value.length <= GRAPH_LIMITS.sources,
    `Expected at most ${GRAPH_LIMITS.sources} sources.`,
  );
  for (const source of value) {
    assert(graphObject(source), 'Invalid source.');
    keys(source, ['label', 'url', 'path', 'line']);
    text(source.label, GRAPH_LIMITS.sourceLabel, true);
    if (source.url !== undefined) {
      text(source.url, GRAPH_LIMITS.sourceUrl);
      const url = URL.canParse(source.url) ? new URL(source.url) : undefined;
      assert(
        url !== undefined &&
          /^https?:\/\//i.test(source.url) &&
          /^https?:$/.test(url.protocol) &&
          !!url.hostname &&
          !url.username &&
          !url.password &&
          ![...source.url].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) &&
          source.path === undefined &&
          source.line === undefined,
        'Invalid source URL.',
      );
    } else {
      text(source.path, GRAPH_LIMITS.sourcePath, true);
      assert(
        !source.path.startsWith('/') &&
          !/[\\:]/.test(source.path) &&
          ![...source.path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
          source.path.split('/').every((part) => part && part !== '.' && part !== '..'),
        'Invalid task-relative source path.',
      );
      assert(
        source.line === undefined || (Number.isSafeInteger(source.line) && Number(source.line) > 0),
        'Invalid source line.',
      );
    }
  }
}
function fields(value: Record<string, unknown>, kind: 'node' | 'link', partial: boolean) {
  for (const [key, v] of Object.entries(value)) {
    if (v === null && partial && !['title', 'detail', 'source', 'target'].includes(key)) continue;
    if (key === 'title') text(v, GRAPH_LIMITS.title, true);
    else if (key === 'detail' || key === 'result') text(v, GRAPH_LIMITS.detail);
    else if (key === 'kind')
      assert(
        typeof v === 'string' &&
          (kind === 'link'
            ? v.length <= GRAPH_LIMITS.linkKind
            : (mapNodeKinds as readonly string[]).includes(v)),
        kind === 'link'
          ? `Relation kind must be text up to ${GRAPH_LIMITS.linkKind} characters.`
          : `Invalid node kind. Use one of: ${mapNodeKinds.join(', ')}.`,
      );
    else if (key === 'status')
      assert(
        typeof v === 'string' && (reasoningStatuses as readonly string[]).includes(v),
        `Invalid status. Use one of: ${reasoningStatuses.join(', ')}.`,
      );
    else if (key === 'source' || key === 'target') id(v);
    else if (key === 'rationale') text(v, GRAPH_LIMITS.rationale);
    else if (key === 'confidence')
      assert(
        typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1,
        'Confidence must be from 0 to 1.',
      );
    else if (key === 'sources') validateSources(v);
    else if (key === 'criteria') {
      assert(Array.isArray(v) && v.length <= GRAPH_LIMITS.criteria, 'Invalid criteria.');
      v.forEach((x) => text(x, GRAPH_LIMITS.criterion, true));
    } else if (key === 'evaluations') {
      assert(Array.isArray(v) && v.length <= GRAPH_LIMITS.evaluations, 'Invalid evaluations.');
      for (const entry of v) {
        assert(graphObject(entry), 'Invalid evaluation.');
        keys(entry, ['criterion', 'assessment']);
        text(entry.criterion, GRAPH_LIMITS.criterion, true);
        text(entry.assessment, GRAPH_LIMITS.assessment, true);
      }
      assert(
        new Set(v.map((entry) => entry.criterion.trim())).size === v.length,
        'Duplicate evaluation criterion.',
      );
    }
  }
}
export function validateNode(value: unknown, trusted = false): asserts value is MapNode {
  assert(graphObject(value), 'Invalid node.');
  keys(value, ['id', 'parent', ...nodeFields, ...(trusted ? ['userEdited'] : [])]);
  id(value.id);
  if (value.parent !== undefined) id(value.parent);
  text(value.title, GRAPH_LIMITS.title, true);
  text(value.detail, GRAPH_LIMITS.detail);
  fields(
    Object.fromEntries(
      Object.entries(value).filter(
        ([k, v]) => nodeFields.includes(k as (typeof nodeFields)[number]) && v !== undefined,
      ),
    ),
    'node',
    false,
  );
  assert(
    value.confidence === undefined || value.kind === 'hypothesis',
    'Only hypotheses can have confidence.',
  );
  assert(
    value.evaluations === undefined || value.kind === 'option',
    'Only options can have evaluations.',
  );
  if (trusted) protection(value.userEdited, ['*', 'parent', 'children', ...nodeFields]);
}
export function validateLink(value: unknown, trusted = false): asserts value is MapLink {
  assert(graphObject(value), 'Invalid relation.');
  keys(value, ['id', ...linkFields, ...(trusted ? ['userEdited'] : [])]);
  id(value.id);
  id(value.source);
  id(value.target);
  fields(
    Object.fromEntries(
      Object.entries(value).filter(
        ([k, v]) => linkFields.includes(k as (typeof linkFields)[number]) && v !== undefined,
      ),
    ),
    'link',
    false,
  );
  if (trusted) protection(value.userEdited, ['*', ...linkFields]);
}
export function validateExplanation(
  value: unknown,
  trusted = false,
): asserts value is NodeExplanation {
  assert(graphObject(value), 'Invalid explanation.');
  keys(value, ['id', 'nodeId', 'question', 'answer', ...(trusted ? ['userEdited'] : [])]);
  id(value.id);
  id(value.nodeId);
  text(value.question, GRAPH_LIMITS.question, true);
  text(value.answer, GRAPH_LIMITS.answer, true);
  if (trusted) protection(value.userEdited, ['*', 'answer']);
}
function protection(value: unknown, allowed: string[]) {
  assert(
    value === undefined ||
      (Array.isArray(value) &&
        value.length <= allowed.length &&
        new Set(value).size === value.length &&
        value.every((v) => allowed.includes(v))),
    'Invalid protected fields.',
  );
}
export function parseGraphOperations(value: unknown): MapOperation[] {
  assert(
    Array.isArray(value) && value.length <= GRAPH_LIMITS.operations,
    `Expected at most ${GRAPH_LIMITS.operations} operations.`,
  );
  const types = [
    'insert',
    'update',
    'move',
    'remove',
    'insert_relation',
    'update_relation',
    'remove_relation',
    'insert_explanation',
    'update_explanation',
    'remove_explanation',
  ];
  for (const [index, op] of value.entries()) {
    assert(graphObject(op), 'Invalid graph operation.');
    assert(
      typeof op.type === 'string' && types.includes(op.type),
      `Unknown graph operation at operations[${index}].type. Use one of: ${types.join(', ')}.`,
    );
    assert(
      op.overrideUser === undefined || typeof op.overrideUser === 'boolean',
      'Invalid overrideUser.',
    );
    assert(op.tombstone === undefined || typeof op.tombstone === 'boolean', 'Invalid tombstone.');
    const removal = op.type.startsWith('remove');
    assert(!removal || op.userEdited === undefined, 'Removals cannot set protection.');
    assert(removal || op.tombstone === undefined, 'Only removals take tombstone.');
    protection(
      op.userEdited,
      op.type.endsWith('relation')
        ? ['*', ...linkFields]
        : op.type.endsWith('explanation')
          ? ['*', 'answer']
          : ['*', 'parent', 'children', ...nodeFields],
    );
    const allowed = ['type', 'overrideUser', 'userEdited', 'tombstone'];
    if (op.type === 'insert') {
      keys(op, [...allowed, 'node', 'after']);
      validateNode(op.node);
      if (op.after !== undefined) id(op.after);
    } else if (op.type === 'insert_relation') {
      keys(op, [...allowed, 'relation']);
      validateLink(op.relation);
    } else if (op.type === 'insert_explanation') {
      keys(op, [...allowed, 'explanation']);
      validateExplanation(op.explanation);
    } else {
      id(op.id);
      if (op.type === 'update' || op.type === 'update_relation') {
        keys(op, [...allowed, 'id', 'changes']);
        assert(
          graphObject(op.changes) && (Object.keys(op.changes).length || op.userEdited),
          'Empty graph patch.',
        );
        keys(op.changes, op.type === 'update' ? nodeFields : linkFields);
        fields(op.changes, op.type === 'update' ? 'node' : 'link', true);
      } else if (op.type === 'update_explanation') {
        keys(op, [...allowed, 'id', 'changes']);
        assert(graphObject(op.changes), 'Invalid explanation patch.');
        keys(op.changes, ['answer']);
        text(op.changes.answer, GRAPH_LIMITS.answer, true);
      } else if (op.type === 'move') {
        keys(op, [...allowed, 'id', 'parent', 'after']);
        id(op.parent);
        if (op.after !== undefined) id(op.after);
        assert(op.after !== op.id, 'A node cannot be placed after itself.');
      } else {
        keys(op, [...allowed, 'id']);
      }
    }
  }
  return structuredClone(value) as MapOperation[];
}
export function parseGraphUpdate(value: unknown): GraphUpdate {
  assert(graphObject(value), 'Invalid graph update.');
  keys(value, ['expectedRevision', 'operations']);
  assert(
    Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) >= 0,
    'Supply expectedRevision.',
  );
  return {
    expectedRevision: Number(value.expectedRevision),
    operations: parseGraphOperations(value.operations),
  };
}
