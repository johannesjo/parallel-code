import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore, store } from './core';
import { clearNotification } from './notification';
import { createTaskInBackground, restoreFailedDraft } from './task-creation';

const draft = { prefill: { prompt: 'Do it', projectId: 'project' }, dropUrl: null };

beforeEach(() => {
  vi.useFakeTimers();
  clearNotification();
  setStore({ newTaskPrefillPrompt: null, newTaskDropUrl: null });
});

afterEach(() => {
  vi.useRealTimers();
});

it('stops counting a creation as quick and announces it once a slow one is ready', async () => {
  let finish!: (taskId: string) => void;
  let quick!: () => boolean;
  const done = createTaskInBackground({
    name: 'Slow',
    create: (isQuick) => {
      quick = isQuick;
      return new Promise((resolve) => (finish = resolve));
    },
    onCreated: vi.fn(),
    draft,
  });
  expect(quick()).toBe(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(quick()).toBe(false);
  expect(store.notification).toBe('Creating "Slow"…');
  expect(store.notificationBusy).toBe(true);
  finish('slow');
  await done;
  expect(store.notification).toBe('"Slow" is ready');
  expect(store.notificationBusy).toBe(false);
});

function slowJob(name: string): { done: Promise<void>; finish: (taskId: string) => void } {
  let finish!: (taskId: string) => void;
  const done = createTaskInBackground({
    name,
    create: () => new Promise((resolve) => (finish = resolve)),
    onCreated: vi.fn(),
    draft,
  });
  return { done, finish: (taskId) => finish(taskId) };
}

it('keeps the creating notice up for as long as creation takes, counting queued tasks', async () => {
  const first = slowJob('First');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(store.notification).toBe('Creating "First"…');
  const second = slowJob('Second');
  await vi.advanceTimersByTimeAsync(500);
  expect(store.notification).toBe('Creating "First" and 1 more…');

  first.finish('first');
  await first.done;
  expect(store.notification).toBe('"First" is ready');
  await vi.advanceTimersByTimeAsync(3000);
  expect(store.notification).toBe('Creating "Second"…');

  second.finish('second');
  await second.done;
  await vi.advanceTimersByTimeAsync(3000);
  expect(store.notification).toBeNull();
});

it('returns to the creating notice after a failure notice expires', async () => {
  const pending = slowJob('Pending');
  await vi.advanceTimersByTimeAsync(500);
  await createTaskInBackground({
    name: 'Broken',
    create: () => Promise.reject(new Error('No worktree')),
    onCreated: vi.fn(),
    draft: { prefill: { prompt: ' ', projectId: 'project' }, dropUrl: null },
  });
  expect(store.notification).toContain('No worktree');
  expect(store.notificationBusy).toBe(false);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(store.notification).toBe('Creating "Pending"…');
  expect(store.notificationBusy).toBe(true);
  pending.finish('pending');
  await pending.done;
});

it('creates a quick task without any notice', async () => {
  await createTaskInBackground({
    name: 'Quick',
    create: async () => 'quick',
    onCreated: vi.fn(),
    draft,
  });
  await vi.advanceTimersByTimeAsync(500);
  expect(store.notification).toBeNull();
});

it('reports a failing follow-up without rejecting or keeping the draft for a retry', async () => {
  await expect(
    createTaskInBackground({
      name: 'Made',
      create: async () => 'made',
      onCreated: () => {
        throw new Error('Link failed');
      },
      draft,
    }),
  ).resolves.toBeUndefined();
  expect(store.notification).toContain('Link failed');
  restoreFailedDraft();
  expect(store.newTaskPrefillPrompt).toBeNull();
});

it('does not offer an empty failed draft again', async () => {
  await createTaskInBackground({
    name: 'Task 3',
    create: () => Promise.reject(new Error('No worktree')),
    onCreated: vi.fn(),
    draft: { prefill: { prompt: ' ', name: '', projectId: 'project' }, dropUrl: null },
  });
  expect(store.notification).toContain('No worktree');
  expect(store.notification).not.toContain('open New Task');
  restoreFailedDraft();
  expect(store.newTaskPrefillPrompt).toBeNull();
});

it('leads a kept draft failure with the retry hint, without the IPC prefix', async () => {
  await createTaskInBackground({
    name: 'Task 4',
    create: () =>
      Promise.reject(
        new Error("Error invoking remote method 'create_task': Error: git worktree add failed"),
      ),
    onCreated: vi.fn(),
    draft: { prefill: { prompt: 'Fix it', projectId: 'project' }, dropUrl: null },
  });
  expect(store.notification).toBe(
    'Could not create "Task 4" (open New Task to retry): git worktree add failed',
  );
  restoreFailedDraft();
});

it('brings a dismissed creating notice back with the next queue change', async () => {
  const first = slowJob('First');
  const second = slowJob('Second');
  await vi.advanceTimersByTimeAsync(500);
  clearNotification();
  expect(store.notification).toBeNull();
  expect(store.notificationBusy).toBe(false);
  first.finish('first');
  await first.done;
  await vi.advanceTimersByTimeAsync(3000);
  expect(store.notification).toBe('Creating "Second"…');
  expect(store.notificationBusy).toBe(true);
  second.finish('second');
  await second.done;
});
