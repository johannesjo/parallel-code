import { expect, it } from 'vitest';
import { branchPrompt } from './agentActions';

it('bounds large branch previews and escapes terminal control characters', () => {
  const records = [
    { id: 'root', title: 'Topic\u001b\r', detail: 'n'.repeat(900) },
    ...Array.from({ length: 45 }, (_, index) => ({
      id: `child${index}`,
      parent: 'root',
      title: 'Child',
      detail: '',
    })),
  ];
  const prompt = branchPrompt('task', 'mindmap', {
    intent: 'expand',
    rootId: 'root',
    revision: 1,
    map: { records, relations: [] },
  });
  const context = JSON.parse(prompt?.split('\n').find((line) => line.startsWith('{')) ?? '{}');
  expect(context.nodes).toHaveLength(32);
  expect(context.omittedNodes).toBe(14);
  expect(context.notesTruncated).toBe(true);
  expect(context.nodes[0].detail).toHaveLength(800);
  expect(prompt).toContain('mindmap_read');
  expect(prompt).toContain('mindmap_update');
  expect(prompt).not.toContain('\u001b');
  expect(prompt).not.toContain('\r');
});

it('does not prepare requests for missing nodes or request map changes when explaining', () => {
  const request = {
    intent: 'explain' as const,
    rootId: 'root',
    revision: 0,
    map: { records: [{ id: 'root', title: 'Topic', detail: '' }], relations: [] },
  };
  expect(branchPrompt('task', 'mindmap', { ...request, rootId: 'deleted' })).toBeUndefined();
  const prompt = branchPrompt('task', 'mindmap', request);
  expect(prompt).toContain('Do not change the map');
  expect(prompt).not.toContain('mindmap_update');
  const reasoning = branchPrompt('task', 'reasoning', request);
  expect(reasoning).not.toContain('publish separate findings');
  expect(reasoning).toContain('insert_explanation');
  expect(reasoning).toContain('reasoning_update');
  const context = JSON.parse(reasoning?.split('\n').find((line) => line.startsWith('{')) ?? '{}');
  expect(context.explanationRequest).toEqual({
    id: expect.any(String),
    nodeId: 'root',
    question: 'Explain this branch',
  });
});

it('asks for both sides of an assumption and attaches findings to the node', () => {
  const request = {
    intent: 'challenge' as const,
    rootId: 'root',
    revision: 4,
    map: { records: [{ id: 'root', title: 'Cache is stale', detail: '' }], relations: [] },
  };
  const reasoning = branchPrompt('task', 'reasoning', request) ?? '';
  expect(reasoning).toContain('evidence that contradicts it');
  expect(reasoning).toContain('supports or challenges relation');
  expect(reasoning).toContain('reasoning_update');
  expect(reasoning).not.toContain('publish separate findings');
  const mindmap = branchPrompt('task', 'mindmap', request) ?? '';
  expect(mindmap).toContain('child of the selected node');
  expect(mindmap).toContain('mindmap_update');
});
