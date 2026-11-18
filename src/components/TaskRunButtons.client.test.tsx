import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import type { Task } from '../store/types';
import { TaskRunButtons } from './TaskRunButtons';
import { openCanvasBrowserAt, startRunInTask, stopRunInTask } from '../store/store';
import { runState } from '../store/runs';

const runs = [
  { id: 'web', name: 'web', command: 'npm run dev', url: 'localhost:$PARALLEL_CODE_PORT' },
  { id: 'api', name: 'api', command: 'npm run api' },
];

vi.mock('../store/store', () => ({
  getProject: () => ({ runCommands: runs }),
  openCanvasBrowserAt: vi.fn(),
  setActiveTask: vi.fn(),
  startRunInTask: vi.fn(async () => undefined),
  stopRunInTask: vi.fn(),
}));
vi.mock('../store/runs', () => ({ runState: vi.fn(() => undefined) }));
vi.mock('../store/task-ports', () => ({ ensureTaskPortBase: () => 20040 }));

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const task = { id: 'task-1', projectId: 'p', portBase: 20040 } as Task;
  disposers.push(render(() => <TaskRunButtons task={task} />, container));
  return container;
}

function button(container: HTMLElement, selector: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(selector);
  if (!el) throw new Error(`Missing ${selector}`);
  return el;
}

it('starts a stopped run and keeps its restart button hidden but in place', () => {
  const container = mount();
  const toggle = button(container, 'button[title^="Start web"]');
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  const restart = button(container, '[aria-label="Restart web"]');
  expect(restart.style.visibility).toBe('hidden');
  expect(restart.disabled).toBe(true);
  toggle.click();
  expect(startRunInTask).toHaveBeenCalledWith('task-1', runs[0]);
});

it('stops a running run and offers restart', () => {
  vi.mocked(runState).mockImplementation((_, runId) => (runId === 'web' ? 'running' : undefined));
  const container = mount();
  const toggle = button(container, '[title="Stop web"]');
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  toggle.click();
  expect(stopRunInTask).toHaveBeenCalledWith('task-1', 'web');
  button(container, '[aria-label="Restart web"]').click();
  expect(startRunInTask).toHaveBeenCalledWith('task-1', runs[0]);
});

it('opens the run link on the task port, and offers no link button without one', () => {
  const container = mount();
  button(container, '[aria-label="Open web in the browser preview"]').click();
  expect(openCanvasBrowserAt).toHaveBeenCalledWith('task-1', 'http://localhost:20040');
  expect(container.querySelector('[aria-label="Open api in the browser preview"]')).toBeNull();
});
