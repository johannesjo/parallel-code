import { mapNodeKinds, reasoningStatuses } from './graph.js';
import { GRAPH_ID_PATTERN, GRAPH_LIMITS } from './graph-limits.js';

const id = { type: 'string', pattern: GRAPH_ID_PATTERN };
const nodeFields = {
  title: { type: 'string', minLength: 1, maxLength: GRAPH_LIMITS.title },
  detail: { type: 'string', maxLength: GRAPH_LIMITS.detail },
  kind: { enum: [...mapNodeKinds] },
  status: { enum: [...reasoningStatuses] },
  confidence: {
    type: 'number',
    minimum: 0,
    maximum: 1,
    description: 'Hypotheses only; agent-reported assessment.',
  },
  result: { type: 'string', maxLength: GRAPH_LIMITS.result },
  criteria: {
    type: 'array',
    maxItems: GRAPH_LIMITS.criteria,
    items: { type: 'string', minLength: 1, maxLength: GRAPH_LIMITS.criterion },
  },
  evaluations: {
    type: 'array',
    maxItems: GRAPH_LIMITS.evaluations,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['criterion', 'assessment'],
      properties: {
        criterion: { type: 'string', minLength: 1, maxLength: GRAPH_LIMITS.criterion },
        assessment: { type: 'string', minLength: 1, maxLength: GRAPH_LIMITS.assessment },
      },
    },
  },
  sources: {
    type: 'array',
    maxItems: GRAPH_LIMITS.sources,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['label'],
      anyOf: [{ required: ['url'] }, { required: ['path'] }],
      properties: {
        label: { type: 'string', minLength: 1, maxLength: GRAPH_LIMITS.sourceLabel },
        url: {
          type: 'string',
          maxLength: GRAPH_LIMITS.sourceUrl,
          description: 'HTTP(S) URL without credentials; omit path and line.',
        },
        path: {
          type: 'string',
          minLength: 1,
          maxLength: GRAPH_LIMITS.sourcePath,
          description: 'Task-relative path without traversal; omit url.',
        },
        line: { type: 'integer', minimum: 1 },
      },
    },
  },
};
const linkFields = {
  source: id,
  target: id,
  kind: { type: 'string', maxLength: GRAPH_LIMITS.linkKind },
  rationale: { type: 'string', maxLength: GRAPH_LIMITS.rationale },
};
const explanationFields = {
  nodeId: id,
  question: { type: 'string', minLength: 1, maxLength: GRAPH_LIMITS.question },
  answer: { type: 'string', minLength: 1, maxLength: GRAPH_LIMITS.answer },
};
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const patch = (fields: Record<string, unknown>, requiredFields: string[]) => ({
  ...object(
    Object.fromEntries(
      Object.entries(fields).map(([key, schema]) => [
        key,
        requiredFields.includes(key) ? schema : { anyOf: [schema, { type: 'null' }] },
      ]),
    ),
    [],
  ),
  minProperties: 1,
});
const operation = (type: string, properties: Record<string, unknown>, required: string[]) =>
  object(
    {
      type: { const: type },
      overrideUser: {
        type: 'boolean',
        description:
          'Explicitly allow this operation to change protected user content. Ordinary edits should omit it.',
      },
      ...properties,
    },
    ['type', ...required],
  );
/** Both tools advertise exactly the same operation protocol. */
export const graphOperationsSchema = {
  type: 'array',
  maxItems: GRAPH_LIMITS.operations,
  description:
    'Atomic operations. Omitted patch fields are preserved; null clears optional fields. IDs are stable. User-edited fields and deleted IDs require explicit overrideUser. All resulting references must exist.',
  items: {
    oneOf: [
      operation(
        'insert',
        { node: object({ id, parent: id, ...nodeFields }, ['id', 'title', 'detail']), after: id },
        ['node'],
      ),
      operation('update', { id, changes: patch(nodeFields, ['title', 'detail']) }, [
        'id',
        'changes',
      ]),
      operation('move', { id, parent: id, after: id }, ['id', 'parent']),
      operation('remove', { id }, ['id']),
      operation(
        'insert_relation',
        { relation: object({ id, ...linkFields }, ['id', 'source', 'target']) },
        ['relation'],
      ),
      operation('update_relation', { id, changes: patch(linkFields, ['source', 'target']) }, [
        'id',
        'changes',
      ]),
      operation('remove_relation', { id }, ['id']),
      operation(
        'insert_explanation',
        {
          explanation: object({ id, ...explanationFields }, ['id', 'nodeId', 'question', 'answer']),
        },
        ['explanation'],
      ),
      operation(
        'update_explanation',
        { id, changes: object({ answer: explanationFields.answer }, ['answer']) },
        ['id', 'changes'],
      ),
      operation('remove_explanation', { id }, ['id']),
    ],
  },
};
