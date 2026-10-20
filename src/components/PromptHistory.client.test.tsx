import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../store/types';
import { PromptHistory } from './PromptHistory';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

function mount(overrides: Partial<Task> = {}) {
  const task: Task = {
    id: 'task',
    name: 'Task',
    projectId: 'project',
    branchName: 'branch',
    worktreePath: '/repo',
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
    ...overrides,
  };
  const parentClick = vi.fn();
  const root = document.createElement('div');
  document.body.append(root);
  dispose = render(
    () => (
      <div onClick={parentClick}>
        <PromptHistory task={task} emptyLabel="No prompts sent" />
      </div>
    ),
    root,
  );
  const button = root.querySelector('button');
  if (!button) throw new Error('Missing history trigger');
  return { button, parentClick };
}

describe('PromptHistory', () => {
  it('shows complete prompt text in order on click, not on hover, and toggles closed', () => {
    const { button } = mount({
      lastPrompt: 'Second prompt',
      promptHistory: [
        { text: 'First prompt\nwith another line', sentAt: 1700000000000 },
        { text: '<script>plain text</script>' },
        { text: 'Second prompt' },
      ],
    });
    button.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelector('[role="region"]')).toBeNull();
    button.click();
    const popover = document.querySelector('[role="region"]');
    expect(popover).not.toBeNull();
    expect([...document.querySelectorAll('li p')].map((p) => p.textContent)).toEqual([
      'First prompt\nwith another line',
      '<script>plain text</script>',
      'Second prompt',
    ]);
    expect(popover?.querySelector('script')).toBeNull();
    // Entries carry only their time and text; untimed legacy entries show just text.
    expect([...document.querySelectorAll('li')].map((li) => li.children.length)).toEqual([2, 1, 1]);
    button.dispatchEvent(new MouseEvent('mouseleave'));
    expect(document.querySelector('[role="region"]')).not.toBeNull();
    button.click();
    expect(document.querySelector('[role="region"]')).toBeNull();
  });

  it('supports keyboard access and Escape without handing focus to the terminal', () => {
    const { button, parentClick } = mount({ lastPrompt: 'Legacy prompt' });
    button.focus();
    button.click();
    expect(parentClick).not.toHaveBeenCalled();
    expect(document.querySelector('li p')?.textContent).toBe('Legacy prompt');
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement?.getAttribute('role')).toBe('region');
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(document.querySelector('[role="region"]')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens scrolled to the newest prompt', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900);
    const { button } = mount({ promptHistory: [{ text: 'Old' }, { text: 'New' }] });
    button.click();
    await Promise.resolve();
    expect(document.querySelector<HTMLElement>('[role="region"]')?.scrollTop).toBe(900);
  });

  it('shows an empty state and closes on an outside click', () => {
    const { button } = mount();
    button.click();
    expect(document.querySelector('[role="region"]')?.textContent).toContain(
      'No prompts sent yet.',
    );
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(document.querySelector('[role="region"]')).toBeNull();
  });
});
