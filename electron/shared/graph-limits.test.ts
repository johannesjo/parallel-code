import { expect, it } from 'vitest';
import { GRAPH_ID_PATTERN, GRAPH_LIMITS } from './graph-limits.js';
import { graphOperationsSchema } from './graph-schema.js';

type Schema = Record<string, unknown>;
const property = (schema: unknown, path: string[]): Schema => {
  let current = schema as Schema;
  for (const key of path) current = current[key] as Schema;
  return current;
};
const operations = graphOperationsSchema.items.oneOf as Schema[];
const operation = (type: string) =>
  operations.find((item) => property(item, ['properties', 'type']).const === type) as Schema;
const node = property(operation('insert'), ['properties', 'node', 'properties']);
const link = property(operation('insert_relation'), ['properties', 'relation', 'properties']);
const explanation = property(operation('insert_explanation'), [
  'properties',
  'explanation',
  'properties',
]);
const source = property(node, ['sources', 'items']);

it('advertises the runtime ID pattern and size limits in the schema', () => {
  expect(property(node, ['id']).pattern).toBe(GRAPH_ID_PATTERN);
  expect(property(link, ['source']).pattern).toBe(GRAPH_ID_PATTERN);
  expect(graphOperationsSchema.maxItems).toBe(GRAPH_LIMITS.operations);
  expect(property(node, ['title']).maxLength).toBe(GRAPH_LIMITS.title);
  expect(property(node, ['detail']).maxLength).toBe(GRAPH_LIMITS.detail);
  expect(property(node, ['result']).maxLength).toBe(GRAPH_LIMITS.result);
  expect(property(node, ['criteria']).maxItems).toBe(GRAPH_LIMITS.criteria);
  expect(property(node, ['criteria', 'items']).maxLength).toBe(GRAPH_LIMITS.criterion);
  expect(property(node, ['evaluations']).maxItems).toBe(GRAPH_LIMITS.evaluations);
  expect(property(node, ['evaluations', 'items', 'properties', 'criterion']).maxLength).toBe(
    GRAPH_LIMITS.criterion,
  );
  expect(property(node, ['evaluations', 'items', 'properties', 'assessment']).maxLength).toBe(
    GRAPH_LIMITS.assessment,
  );
  expect(property(node, ['sources']).maxItems).toBe(GRAPH_LIMITS.sources);
  expect(property(source, ['properties', 'label']).maxLength).toBe(GRAPH_LIMITS.sourceLabel);
  expect(property(source, ['properties', 'url']).maxLength).toBe(GRAPH_LIMITS.sourceUrl);
  expect(property(source, ['properties', 'path']).maxLength).toBe(GRAPH_LIMITS.sourcePath);
  expect(property(link, ['kind']).maxLength).toBe(GRAPH_LIMITS.linkKind);
  expect(property(link, ['rationale']).maxLength).toBe(GRAPH_LIMITS.rationale);
  expect(property(explanation, ['question']).maxLength).toBe(GRAPH_LIMITS.question);
  expect(property(explanation, ['answer']).maxLength).toBe(GRAPH_LIMITS.answer);
});

it('requires a source to carry a url or a path', () => {
  expect(source.anyOf).toEqual([{ required: ['url'] }, { required: ['path'] }]);
});
