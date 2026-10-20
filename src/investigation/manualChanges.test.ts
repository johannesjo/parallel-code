import { expect, it } from 'vitest';
import { hasManualChanges, manualChangesDigest, manualChangesPrompt } from './manualChanges';
import { makeFixture } from './fixture';
import { applyMapOperations } from '../../electron/shared/graph';
it('reports committed user fields and deletions from the canonical graph', () => {
  const graph = makeFixture().snapshots[1];
  const saved = applyMapOperations(graph, [
    { type: 'update', id: 'G1', changes: { detail: 'User note' } },
    { type: 'remove', id: 'H1' },
  ]);
  expect(hasManualChanges(graph)).toBe(false);
  expect(hasManualChanges(saved)).toBe(true);
  const prompt = manualChangesPrompt({
    taskId: 'task',
    runId: 'run',
    revision: saved.revision,
    snapshot: saved,
  });
  expect(prompt).toContain('User note');
  expect(prompt).toContain('"records":["H1"]');
  expect(prompt).toContain('overrideUser');
  expect(manualChangesPrompt({ taskId: 'task', snapshot: graph })).toBeUndefined();
});

it('reports edited relations and explanations, addresses the mind map, and keys the digest', () => {
  const graph = makeFixture().snapshots.find((snapshot) => snapshot.relations.length);
  if (!graph) throw new Error('fixture has no relations');
  const saved = applyMapOperations(graph, [
    { type: 'update_relation', id: graph.relations[0].id, changes: { rationale: 'Mine' } },
  ]);
  const prompt = manualChangesPrompt({ taskId: 'task', canvas: 'mindmap', snapshot: saved });
  expect(prompt).toContain('mind map');
  expect(prompt).toContain('mindmap_read');
  expect(prompt).toContain(`"relations":[{"id":"${graph.relations[0].id}"`);
  expect(manualChangesDigest(graph)).toBe('null');
  expect(manualChangesDigest(saved)).not.toBe(manualChangesDigest(graph));
  expect(manualChangesDigest(saved)).toBe(manualChangesDigest(structuredClone(saved)));
});

it('changes the digest for an edit past the detail the prompt quotes', () => {
  const graph = makeFixture().snapshots[1];
  const long = 'a'.repeat(1000);
  const sent = applyMapOperations(graph, [{ type: 'update', id: 'G1', changes: { detail: long } }]);
  const edited = applyMapOperations(sent, [
    { type: 'update', id: 'G1', changes: { detail: `${long} and more` } },
  ]);
  expect(manualChangesDigest(edited)).not.toBe(manualChangesDigest(sent));
  expect(manualChangesPrompt({ taskId: 'task', snapshot: edited })).not.toContain('and more');
});
