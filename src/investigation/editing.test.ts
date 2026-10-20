import { expect, it } from 'vitest';
import {
  childNode,
  conflictFields,
  emptyWorkspace,
  getDraft,
  notePatch,
  restoreReasoningWorkspaces,
  updateDraft,
} from './editing';
import { makeFixture } from './fixture';
import { applyMapOperations } from '../../electron/shared/graph';
const snapshot = () => makeFixture().snapshots[0];
it('keeps draft text private and patches only dirty fields', () => {
  const graph = snapshot(),
    node = graph.records[0];
  const draft = {
    title: 'My goal',
    detail: node.detail,
    base: { title: node.title, detail: node.detail },
    question: 'Private question',
  };
  const workspace = updateDraft(emptyWorkspace(), node.id, draft);
  expect(getDraft(workspace, node.id)).toEqual(draft);
  expect(notePatch(graph, node.id, draft)).toEqual([
    { type: 'update', id: node.id, changes: { title: 'My goal' } },
  ]);
  expect(JSON.stringify(graph)).not.toContain('Private question');
});
it('detects overlapping edits but keeps unrelated updated fields', () => {
  const graph = snapshot(),
    node = graph.records[0];
  const draft = {
    title: 'My goal',
    detail: node.detail,
    base: { title: node.title, detail: node.detail },
    question: '',
  };
  const other = applyMapOperations(
    graph,
    [{ type: 'update', id: node.id, changes: { detail: 'New evidence' } }],
    graph.revision,
    'agent',
  );
  expect(conflictFields(other, node.id, draft)).toEqual([]);
  expect(notePatch(other, node.id, draft)[0]).toMatchObject({ changes: { title: 'My goal' } });
  const conflict = applyMapOperations(
    other,
    [{ type: 'update', id: node.id, changes: { title: 'Another goal' } }],
    other.revision,
    'agent',
  );
  expect(conflictFields(conflict, node.id, draft)).toEqual(['title']);
  expect(() => notePatch(conflict, node.id, draft)).toThrow('updated');
  expect(notePatch(conflict, node.id, draft, true)).toHaveLength(1);
});
it('rejects invalid or deleted drafts without mutating the workspace', () => {
  const graph = snapshot(),
    node = graph.records[0];
  const draft = {
    title: '',
    detail: '',
    base: { title: node.title, detail: node.detail },
    question: '',
  };
  expect(() => notePatch(graph, node.id, draft)).toThrow('title');
  expect(() => notePatch(graph, 'missing', { ...draft, title: 'Valid' })).toThrow('available');
});
it('restores only draft workspaces and rejects reserved keys and old saved overlays', () => {
  const node = snapshot().records[0];
  const draft = {
    title: node.title,
    detail: node.detail,
    base: { title: node.title, detail: node.detail },
    question: 'Unsent',
  };
  const workspace = updateDraft(emptyWorkspace(), node.id, draft);
  expect(restoreReasoningWorkspaces({ task: workspace })).toEqual({ task: workspace });
  expect(restoreReasoningWorkspaces({ task: { ...workspace, edits: [] } })).toBeUndefined();
  expect(restoreReasoningWorkspaces({ task: { drafts: { constructor: draft } } })).toBeUndefined();
  expect(getDraft(emptyWorkspace(), 'constructor')).toBeUndefined();
  expect(updateDraft(workspace, node.id, undefined)).toEqual(emptyWorkspace());
});
it('keeps the sent-changes digest through draft updates and restores only bounded strings', () => {
  const node = snapshot().records[0];
  const draft = { title: 'T', detail: '', base: { title: 'T', detail: '' }, question: '' };
  const sent = { ...emptyWorkspace(), sentChanges: 'digest-1' };
  expect(updateDraft(sent, node.id, draft).sentChanges).toBe('digest-1');
  expect(updateDraft(updateDraft(sent, node.id, draft), node.id, undefined)).toEqual(sent);
  expect(restoreReasoningWorkspaces({ task: sent })).toEqual({ task: sent });
  expect(restoreReasoningWorkspaces({ task: { drafts: {}, sentChanges: 1 } })).toBeUndefined();
  expect(
    restoreReasoningWorkspaces({ task: { drafts: {}, sentChanges: 'x'.repeat(100_001) } }),
  ).toBeUndefined();
});
it('creates a typed child without committing it or exposing drafts', () => {
  expect(childNode('root', 'hypothesis')).toMatchObject({
    parent: 'root',
    kind: 'hypothesis',
    status: 'untested',
    title: 'New hypothesis',
  });
});
it('defaults to a plain note without a semantic kind or status', () => {
  expect(childNode('root')).toEqual({
    id: expect.stringMatching(/^user_/),
    parent: 'root',
    title: 'New node',
    detail: '',
  });
});
