import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8');
const handlers = new Map<string, (event: object) => void>();
const showNotification = vi.fn();
const matchAll = vi.fn();
const openWindow = vi.fn();
const close = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  handlers.clear();
  matchAll.mockResolvedValue([]);
  runInNewContext(source, {
    URL,
    URLSearchParams,
    self: {
      addEventListener: (name: string, handler: (event: object) => void) =>
        handlers.set(name, handler),
      location: { origin: 'https://computer.example' },
      registration: { showNotification },
      clients: { matchAll, openWindow },
    },
  });
});

async function dispatch(name: string, event: object) {
  const pending: Promise<unknown>[] = [];
  handlers.get(name)?.({
    ...event,
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  });
  await Promise.all(pending);
}

it('displays a task notification with a stable tag and no terminal data or credentials', async () => {
  await dispatch('push', {
    data: {
      json: () => ({
        taskId: 'task-1',
        taskName: 'Fix tests',
        lastLine: 'private output',
        token: 'secret',
      }),
    },
  });
  expect(showNotification).toHaveBeenCalledWith('Fix tests', {
    body: 'A task needs your input.',
    icon: '/icons/icon-192.png',
    tag: 'needs-input:task-1',
    renotify: true,
    data: { taskId: 'task-1' },
  });
});

it('shows a fallback notification for malformed pushes', async () => {
  await dispatch('push', {
    data: {
      json: () => {
        throw new Error('invalid JSON');
      },
    },
  });
  expect(showNotification).toHaveBeenCalledWith(
    'Parallel Code',
    expect.objectContaining({ data: { taskId: '' } }),
  );
});

it('opens a closed phone app at the task without trusting a supplied URL', async () => {
  await dispatch('notificationclick', {
    notification: { close, data: { taskId: 'a&token=secret', url: 'https://evil.example' } },
  });
  expect(close).toHaveBeenCalledOnce();
  const destination = new URL(openWindow.mock.calls[0][0] as string);
  expect(destination.origin).toBe('https://computer.example');
  expect(destination.search).toBe('');
  expect(new URLSearchParams(destination.hash.slice(1)).get('task')).toBe('a&token=secret');
});

it('navigates and focuses an existing phone window', async () => {
  const focus = vi.fn();
  const navigate = vi.fn().mockResolvedValue({ focus });
  matchAll.mockResolvedValue([{ url: 'https://computer.example/#task=old', navigate }]);
  await dispatch('notificationclick', { notification: { close, data: { taskId: 'new' } } });
  expect(navigate).toHaveBeenCalledWith('https://computer.example/#task=new');
  expect(focus).toHaveBeenCalledOnce();
  expect(openWindow).not.toHaveBeenCalled();
});

it('opens a new window if an existing one disappears during navigation', async () => {
  matchAll.mockResolvedValue([
    { url: 'https://computer.example/', navigate: vi.fn().mockResolvedValue(null) },
  ]);
  await dispatch('notificationclick', { notification: { close, data: {} } });
  expect(openWindow).toHaveBeenCalledWith('https://computer.example/');
});
