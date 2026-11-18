import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import type { TerminalBookmark } from '../store/types';
import { CommandBookmarkButton } from './CommandBookmarkButton';
import { openCanvasBrowserAt, startRunInTask, stopRunInTask } from '../store/store';
import { runState } from '../store/runs';

vi.mock('../store/store', () => ({
  openCanvasBrowserAt: vi.fn(),
  setActiveTask: vi.fn(),
  startRunInTask: vi.fn(async () => undefined),
  stopRunInTask: vi.fn(),
}));
vi.mock('../store/runs', () => ({ runState: vi.fn(() => undefined) }));
vi.mock('../store/task-ports', () => ({ ensureTaskPortBase: () => 20040 }));

const web = {
  id: 'web',
  name: 'web',
  command: 'npm run dev',
  url: 'localhost:$PARALLEL_CODE_PORT',
};

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function mount(bookmark: TerminalBookmark) {
  const container = document.createElement('div');
  document.body.append(container);
  const onActivate = vi.fn();
  disposers.push(
    render(
      () => (
        <CommandBookmarkButton
          taskId="task-1"
          bookmark={bookmark}
          highlighted={false}
          onActivate={onActivate}
        />
      ),
      container,
    ),
  );
  return { container, onActivate };
}

function button(container: HTMLElement, selector: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(selector);
  if (!el) throw new Error(`Missing ${selector}`);
  return el;
}

it('runs a stopped bookmark, labelled by a word from its command when unnamed', () => {
  const test = { id: 'test', command: 'npm run typecheck' };
  const { container, onActivate } = mount(test);
  const toggle = button(container, '[title="Run npm run typecheck"]');
  expect(toggle.textContent).toBe('typecheck');
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  toggle.click();
  expect(onActivate).toHaveBeenCalled();
  expect(startRunInTask).toHaveBeenCalledWith('task-1', test);
});

it('stops a running bookmark instead of starting another', () => {
  vi.mocked(runState).mockReturnValue('running');
  const { container } = mount(web);
  const toggle = button(container, '[title="Stop web"]');
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  toggle.click();
  expect(stopRunInTask).toHaveBeenCalledWith('task-1', 'web');
  expect(startRunInTask).not.toHaveBeenCalled();
});

it('opens the link on the task port, and offers no link button without one', () => {
  const { container } = mount(web);
  button(container, '[aria-label="Open web in the browser preview"]').click();
  expect(openCanvasBrowserAt).toHaveBeenCalledWith('task-1', 'http://localhost:20040');
  const plain = mount({ id: 'test', command: 'npm test' });
  expect(plain.container.querySelector('[aria-label^="Open"]')).toBeNull();
});
