import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { setActiveTask } from '../store/navigation';
import { showNotification } from '../store/notification';
import { holdTaskSuggestion, startTaskSuggestion } from '../store/task-suggestions';
import type { Task } from '../store/types';
import type { TaskSuggestion } from '../../electron/shared/task-suggestion';
import { TaskSuggestionCards } from './TaskSuggestionCards';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));
vi.mock('../store/persistence', () => ({ saveState: vi.fn(() => Promise.resolve()) }));
vi.mock('../store/notification', () => ({
  showNotification: vi.fn(),
  NOTIFICATION_ERROR_MS: 10_000,
}));
vi.mock('../store/navigation', () => ({ setActiveTask: vi.fn(), toggleNewTaskPanel: vi.fn() }));
vi.mock('../store/task-suggestions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/task-suggestions')>()),
  startTaskSuggestion: vi.fn(),
}));

const pending: TaskSuggestion = {
  id: 'suggestion_ab12cd34',
  title: 'Fix stale README badge',
  tldr: 'The badge points at a removed workflow.',
  prompt: 'Update README.md to use the ci.yml badge.',
  createdAt: 1,
  status: 'pending',
};

const task = {
  id: 'task-1',
  name: 'Task',
  projectId: 'project-1',
  agentIds: [],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
  taskSuggestions: [pending, { ...pending, id: 'suggestion_dismiss0', status: 'dismissed' }],
} as unknown as Task;

let dispose: (() => void) | undefined;

beforeEach(() => {
  setStore('tasks', reconcile({ 'task-1': structuredClone(task) }));
  setStore('showNewTaskPanel', false);
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <TaskSuggestionCards task={store.tasks['task-1'] as Task} />, host);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = '';
  setStore('tasks', reconcile({}));
  vi.clearAllMocks();
});

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

it('previews only pending suggestions, with the prompt behind a disclosure', () => {
  expect(document.querySelectorAll('article')).toHaveLength(1);
  expect(document.body.textContent).toContain('Fix stale README badge');
  expect(document.body.textContent).toContain('The badge points at a removed workflow.');
  expect(document.querySelector('pre')).toBeNull();
  button('Show prompt').click();
  expect(document.querySelector('pre')?.textContent).toBe(pending.prompt);
  expect(button('Hide prompt').getAttribute('aria-expanded')).toBe('true');
});

it('dismisses a suggestion', () => {
  button('Dismiss').click();
  expect(store.tasks['task-1'].taskSuggestions?.[0].status).toBe('dismissed');
  expect(document.querySelector('section')).toBeNull();
});

it('starts a suggestion and offers to open the new task in a notice', async () => {
  vi.mocked(startTaskSuggestion).mockImplementation(async () => {
    setStore('tasks', 'task-2', { id: 'task-2' } as Task);
    setStore('tasks', 'task-1', 'taskSuggestions', 0, 'status', 'started');
    return 'task-2';
  });
  button('Start task').click();
  expect(startTaskSuggestion).toHaveBeenCalledWith('task-1', pending.id);
  await vi.waitFor(() => expect(showNotification).toHaveBeenCalled());
  const [message, opts] = vi.mocked(showNotification).mock.calls[0];
  expect(message).toBe('Started “Fix stale README badge”');
  opts?.action?.run();
  expect(setActiveTask).toHaveBeenCalledWith('task-2');
  // The card leaves without a lingering receipt that would later shift the terminal.
  expect(document.querySelector('section')).toBeNull();
});

it('locks the card while the user is starting it', () => {
  const release = holdTaskSuggestion(pending.id);
  try {
    expect(button('Starting…').disabled).toBe(true);
    expect(button('Dismiss').disabled).toBe(true);
  } finally {
    release();
  }
  expect(button('Start task').disabled).toBe(false);
});

it('keeps the card and says why when starting fails', async () => {
  vi.mocked(startTaskSuggestion).mockRejectedValue(new Error('worktree failed'));
  button('Start task').click();
  await vi.waitFor(() =>
    expect(showNotification).toHaveBeenCalledWith(
      expect.stringContaining('worktree failed'),
      expect.anything(),
    ),
  );
  expect(button('Start task').disabled).toBe(false);
});

it('opens the New Task form to edit first, unless one is already open', () => {
  setStore('showNewTaskPanel', true);
  button('Edit first').click();
  expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('New Task form'));
  setStore('showNewTaskPanel', false);
  button('Edit first').click();
  expect(store.newTaskPrefillPrompt).toMatchObject({
    taskSuggestion: { suggestionId: pending.id },
  });
});
