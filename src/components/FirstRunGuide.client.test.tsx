import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projects: [] as Array<{ id: string }>,
  pickAndAddProject: vi.fn(),
  toggleNewTaskDialog: vi.fn(),
  setNewTaskPrefillPrompt: vi.fn(),
}));

vi.mock('../store/store', () => ({
  store: {
    availableAgents: [
      { name: 'Claude Code', available: true },
      { name: 'Codex', available: false },
    ],
    lastProjectId: 'p2',
  },
  pickAndAddProject: mocks.pickAndAddProject,
  toggleNewTaskDialog: mocks.toggleNewTaskDialog,
}));
vi.mock('../store/projects', () => ({ codeProjects: () => mocks.projects }));
vi.mock('../store/tasks', () => ({ setNewTaskPrefillPrompt: mocks.setNewTaskPrefillPrompt }));

import { FirstRunGuide } from './FirstRunGuide';
import { FIRST_TASK_SUGGESTIONS } from './first-run';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  mocks.projects = [];
  vi.clearAllMocks();
});

function mount(): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(render(() => <FirstRunGuide />, container));
  return container;
}

describe('FirstRunGuide', () => {
  it('walks through the three steps and names detected agents before any project exists', () => {
    const container = mount();

    expect(container.textContent).toContain('Link a git repository');
    expect(container.textContent).toContain('Detected: Claude Code');
    expect(container.textContent).toContain('Describe the task');

    container.querySelector('button')?.click();
    expect(mocks.pickAndAddProject).toHaveBeenCalledOnce();
  });

  it('opens the new-task dialog pre-filled when a suggestion is clicked', () => {
    mocks.projects = [{ id: 'p1' }, { id: 'p2' }];
    const container = mount();

    const chips = container.querySelectorAll<HTMLButtonElement>('.first-run-suggestion');
    expect(chips).toHaveLength(FIRST_TASK_SUGGESTIONS.length);

    chips[1].click();
    const expected = FIRST_TASK_SUGGESTIONS[1];
    expect(mocks.setNewTaskPrefillPrompt).toHaveBeenCalledWith(
      expected.prompt,
      'p2',
      expected.name,
    );
    expect(mocks.toggleNewTaskDialog).toHaveBeenCalledWith(true);
  });
});
