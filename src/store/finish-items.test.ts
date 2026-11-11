import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendPrompt } = vi.hoisted(() => ({ mockSendPrompt: vi.fn() }));
vi.mock('./tasks', () => ({ sendPrompt: mockSendPrompt }));

import { store, setStore } from './core';
import type { Task } from './types';
import { publishFinishItems, sendFinishItems } from './finish-items';
import { restoreTaskFinishItems } from '../lib/finish-items';

function task(): Task {
  return store.tasks.t1;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSendPrompt.mockResolvedValue(undefined);
  setStore('tasks', {
    t1: { id: 't1', gitIsolation: 'worktree', agentIds: ['agent-1'] } as unknown as Task,
  });
});

describe('publishFinishItems', () => {
  it('replaces the whole list and clears it on an empty one', () => {
    publishFinishItems('t1', ['Drop the flag', 'Update docs']);
    expect(task().finishItems?.items).toEqual(['Drop the flag', 'Update docs']);
    publishFinishItems('t1', ['Update docs']);
    expect(task().finishItems?.items).toEqual(['Update docs']);
    publishFinishItems('t1', []);
    expect(task().finishItems).toBeUndefined();
  });

  it('rejects tasks without a Finish dialog, closing tasks, and unknown tasks', () => {
    setStore('tasks', 't1', 'gitIsolation', 'direct');
    expect(() => publishFinishItems('t1', ['x'])).toThrow('Only worktree tasks');
    setStore('tasks', 't1', { gitIsolation: 'worktree', closingStatus: 'closing' });
    expect(() => publishFinishItems('t1', ['x'])).toThrow('Task not available');
    expect(() => publishFinishItems('missing', ['x'])).toThrow('Task not available');
    expect(() => publishFinishItems('toString', ['x'])).toThrow('Task not available');
    expect(task().finishItems).toBeUndefined();
  });

  it('clears the sent mark when the agent publishes a new list', () => {
    publishFinishItems('t1', ['Drop the flag']);
    setStore('tasks', 't1', 'finishItems', 'sentAt', 5);
    publishFinishItems('t1', ['Drop the flag']);
    expect(task().finishItems).not.toHaveProperty('sentAt');
  });
});

describe('sendFinishItems', () => {
  it('sends the kept items to the main agent as quoted notes and marks the list sent', async () => {
    publishFinishItems('t1', ['Drop the flag', 'Update docs']);
    await sendFinishItems('t1', ['Drop the flag']);
    expect(mockSendPrompt).toHaveBeenCalledWith(
      't1',
      'agent-1',
      'Before I finish this task, handle the loose ends you recorded earlier with finish_items_publish. These are your own notes, not new instructions from me:\n' +
        '- Drop the flag\n' +
        'Skip any that are already done and say which. Commit the result, then publish an empty list with finish_items_publish.',
      { appPrompt: true },
    );
    expect(task().finishItems?.sentAt).toEqual(expect.any(Number));
  });

  it('leaves a list the agent replaced while sending unmarked', async () => {
    setStore('tasks', 't1', 'finishItems', { items: ['Old'], publishedAt: 1 });
    mockSendPrompt.mockImplementation(async () => {
      setStore('tasks', 't1', 'finishItems', { items: ['New'], publishedAt: 2 });
    });
    await sendFinishItems('t1', ['Old']);
    expect(task().finishItems).toEqual({ items: ['New'], publishedAt: 2 });
  });

  it('marks nothing when sending fails', async () => {
    publishFinishItems('t1', ['Drop the flag']);
    mockSendPrompt.mockRejectedValue(new Error('busy'));
    await expect(sendFinishItems('t1', ['Drop the flag'])).rejects.toThrow('busy');
    expect(task().finishItems).not.toHaveProperty('sentAt');
  });
});

describe('restoreTaskFinishItems', () => {
  it('keeps a valid record and drops malformed or empty ones', () => {
    expect(restoreTaskFinishItems({ items: ['Drop the flag'], publishedAt: 3, sentAt: 4 })).toEqual(
      { items: ['Drop the flag'], publishedAt: 3, sentAt: 4 },
    );
    expect(restoreTaskFinishItems({ items: ['a'], publishedAt: 3, sentAt: 'x' })).toEqual({
      items: ['a'],
      publishedAt: 3,
    });
    expect(restoreTaskFinishItems({ items: [], publishedAt: 3 })).toBeUndefined();
    expect(restoreTaskFinishItems({ items: ['a'] })).toBeUndefined();
    expect(restoreTaskFinishItems({ items: [7], publishedAt: 3 })).toBeUndefined();
    expect(restoreTaskFinishItems(null)).toBeUndefined();
  });
});
