import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectTaskGroupToggle } from './Sidebar';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

describe('ProjectTaskGroupToggle', () => {
  it('exposes collapsed state and toggles the project task group', () => {
    const onToggle = vi.fn();
    const container = document.createElement('div');
    document.body.append(container);
    disposers.push(
      render(
        () => (
          <ProjectTaskGroupToggle
            project={{ id: 'project-1', name: 'Project One', path: '/repo', color: '#abc' }}
            taskCount={3}
            collapsed
            onToggle={onToggle}
          />
        ),
        container,
      ),
    );

    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(button?.getAttribute('aria-controls')).toBe('sidebar-project-tasks-project-1');
    expect(button?.textContent).toContain('Project One');
    expect(button?.textContent).toContain('(3)');

    button?.click();

    expect(onToggle).toHaveBeenCalledOnce();
  });
});
