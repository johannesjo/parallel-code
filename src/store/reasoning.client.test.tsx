import { beforeEach, expect, it, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { parseReasoningFeed, parseReasoningUpdate } from '../../electron/shared/reasoning-feed';
import { acceptUpdate, emptyHistory } from '../../electron/shared/reasoning-state';
import { makeFixture } from '../investigation/fixture';
import { reasoningProfiles } from '../investigation/profiles';
import { emptyWorkspace, updateDraft } from '../investigation/editing';
import { invoke } from '../lib/ipc';
import { setStore, store } from './core';
import {
  getTaskReasoning,
  updateTaskReasoningFromAgent,
  commitTaskReasoningEdit,
} from './reasoning';
import type { Task } from './types';
vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('./persistence', () => ({ saveState: vi.fn() }));
let raw: string;
const task: Task = {
  id: 'task',
  name: 'Task',
  projectId: 'project',
  branchName: 'task/test',
  worktreePath: '/tmp/task',
  agentIds: ['agent'],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
};
beforeEach(() => {
  raw = JSON.stringify(makeFixture().updates[0]) + '\n';
  setStore('tasks', reconcile({ task: { ...task } }));
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (channel, args) => {
    if (channel === IPC.ReadReasoningFeed) return { raw, stamp: String(raw.length) };
    if (channel === IPC.AppendReasoningUpdate || channel === IPC.CommitReasoningEdit) {
      const update = parseReasoningUpdate((args as { update: unknown }).update);
      const history = parseReasoningFeed(raw).history;
      const previous = history.snapshots.at(-1);
      if (
        update.expectedRevision !== (previous?.revision ?? 0) ||
        update.runId !== (history.updates[0]?.runId ?? null)
      )
        throw new Error('Revision changed');
      const event = {
        ...update,
        runId: update.newRunId ?? update.runId ?? '',
        expectedRevision: update.newRunId ? 0 : update.expectedRevision,
        sequence: update.newRunId ? 0 : history.updates.length,
        actor: channel === IPC.CommitReasoningEdit ? ('user' as const) : ('agent' as const),
      };
      const { newRunId: _new, ...accepted } = event;
      const next = acceptUpdate(update.newRunId ? emptyHistory() : history, accepted);
      raw = next.updates.map((event) => JSON.stringify(event) + '\n').join('');
      return next.snapshots.at(-1);
    }
    throw new Error('Unexpected channel');
  });
});
it('returns one canonical graph with user edits and excludes unsent drafts', async () => {
  const current = await getTaskReasoning('task');
  const node = current.graph?.records[0];
  if (!node) throw new Error('Missing root');
  const workspace = updateDraft(emptyWorkspace(), node.id, {
    title: 'Private draft',
    detail: '',
    base: { title: node.title, detail: node.detail },
    question: 'Private question',
  });
  setStore('tasks', 'task', 'reasoningWorkspaces', { key: workspace });
  await commitTaskReasoningEdit('task', {
    runId: current.runId,
    expectedRevision: current.revision,
    operations: [{ type: 'update', id: node.id, changes: { title: 'Saved user title' } }],
  });
  const saved = await getTaskReasoning('task');
  expect(saved.revision).toBe(current.revision + 1);
  expect(saved.graph?.records[0]).toMatchObject({
    title: 'Saved user title',
    userEdited: ['title'],
  });
  expect(saved).not.toHaveProperty('report');
  expect(saved).not.toHaveProperty('view');
  expect(JSON.stringify(saved)).not.toContain('Private');
  await expect(
    updateTaskReasoningFromAgent('task', {
      runId: current.runId,
      expectedRevision: current.revision,
      operations: [],
    }),
  ).rejects.toThrow('Revision');
});
it('cannot spoof user authority and attaches explanations through the same operations', async () => {
  const current = await getTaskReasoning('task');
  await expect(
    updateTaskReasoningFromAgent('task', {
      runId: current.runId,
      expectedRevision: current.revision,
      operations: [],
      actor: 'user',
    }),
  ).rejects.toThrow('Unknown');
  const result = await updateTaskReasoningFromAgent('task', {
    runId: current.runId,
    expectedRevision: current.revision,
    operations: [
      {
        type: 'insert_explanation',
        explanation: { id: 'answer', nodeId: 'G1', question: 'Why?', answer: 'Evidence.' },
      },
    ],
  });
  expect(result.graph?.explanations?.[0].answer).toBe('Evidence.');
  expect(store.tasks.task.canvasTabs).toBeUndefined();
});
it('refuses reads and saves for replaced task sessions', async () => {
  vi.mocked(invoke).mockImplementationOnce(async () => {
    setStore('tasks', 'task', 'agentIds', ['replacement']);
    return { raw, stamp: String(raw.length) };
  });
  await expect(getTaskReasoning('task')).rejects.toThrow('session changed');
  await expect(getTaskReasoning('__proto__')).rejects.toThrow('Task not available');
});
it('reads an empty graph and initializes it through a fresh-run operation', async () => {
  raw = '';
  const document = await getTaskReasoning('task');
  expect(document).toMatchObject({ runId: null, revision: 0, graph: null });
  // The read carries the guidance an agent-opened graph never gets through the activation prompt.
  expect(document.workflows).toEqual(
    Object.fromEntries(
      Object.entries(reasoningProfiles).map(([key, value]) => [key, value.instructions]),
    ),
  );
  const result = await updateTaskReasoningFromAgent('task', {
    runId: null,
    newRunId: 'new',
    expectedRevision: 0,
    operations: makeFixture().updates[0].operations,
  });
  expect(result).toMatchObject({ runId: 'new', revision: 1 });
  expect(store.tasks.task.canvasTabs).toContainEqual({ kind: 'reasoning' });
});
