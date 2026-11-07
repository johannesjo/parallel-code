import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../store/task-brief', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/task-brief')>()),
  refreshTaskBrief: vi.fn(),
}));

import { setStore, store } from '../store/core';
import { refreshTaskBrief } from '../store/task-brief';
import type { Task } from '../store/types';
import { TaskContext } from './TaskContext';

let container: HTMLDivElement;
let dispose: (() => void) | undefined;

function mount(
  fields: Partial<Task>,
  walk?: { onWalkThrough: () => void; walkThroughDisabled?: boolean },
): void {
  setStore('tasks', { t1: { id: 't1', agentIds: ['a1'], ...fields } as unknown as Task });
  dispose = render(() => <TaskContext task={store.tasks.t1} {...walk} />, container);
}

const button = (name: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === name);

const brief = (goal: string, now: string) => ({
  brief: { goal, now },
  generatedAt: 1,
  fingerprint: '',
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  setStore({ agents: {}, taskBriefs: true });
  vi.mocked(refreshTaskBrief).mockClear();
});

afterEach(() => {
  dispose?.();
  container.remove();
});

describe('TaskContext', () => {
  it('shows the goal and the plan, with the failure under the step in progress', () => {
    mount({
      brief: brief('Document local setup', 'Checking the dev command'),
      agentPlan: {
        steps: [
          { step: 'Read the scripts', status: 'completed' },
          { step: 'Check the dev command', status: 'in_progress' },
          { step: 'Commit', status: 'pending' },
        ],
        failedCommand: 'npm run dev',
        updatedAt: 1,
      },
    });
    expect(container.querySelector('.ctx-goalbar')?.textContent).toBe('GoalDocument local setup');
    expect(container.querySelector('.ctx-head')?.textContent).toBe('Plan 1/3');
    const current = container.querySelector('[aria-current="step"]');
    expect(current?.textContent).toBe('Check the dev command, in progressnpm run dev failed');
    expect(container.querySelectorAll('li')).toHaveLength(3);
    // "Now" repeats the step in progress, so it stays out while there is a plan.
    expect(container.textContent).not.toContain('Checking the dev command');
  });

  it('marks every finished step with a check, not only the last', () => {
    mount({
      agentPlan: {
        steps: [
          { step: 'A', status: 'completed' },
          { step: 'B', status: 'completed' },
          { step: 'C', status: 'in_progress' },
          { step: 'D', status: 'in_progress' },
        ],
        updatedAt: 1,
      },
    });
    const marks = [...container.querySelectorAll('li')].map(
      (row) => row.querySelectorAll('.ctx-icon path').length,
    );
    expect(marks).toEqual([1, 1, 1, 1]);
  });

  it("falls back to the brief's status when the agent wrote no plan", () => {
    mount({ brief: brief('Document local setup', 'Checking the dev command') });
    expect(container.querySelector('.ctx')?.hasAttribute('title')).toBe(false);
    expect(container.querySelector('.ctx-head')?.textContent).toBe('Now');
    expect(container.querySelector('.ctx-now')?.textContent).toBe('Checking the dev command');
  });

  it("uses the task's prompt as the goal and explains the empty plan", () => {
    mount({ savedInitialPrompt: 'Fix the login redirect\nMore detail' });
    expect(container.querySelector('.ctx-goalbar')?.textContent).toBe('GoalFix the login redirect');
    const section = container.querySelector('.ctx');
    expect(section?.getAttribute('title')).toBe(
      "The agent's plan shows here once it writes a to-do list",
    );
    expect(section?.textContent).not.toContain('plan shows here');
  });

  it('updates the brief on request and says when it was written', () => {
    mount({ brief: { ...brief('Goal', 'Now'), generatedAt: Date.now() - 5 * 60_000 } });
    expect(container.querySelector('.ctx-foot')?.textContent).toContain('Updated 5m');
    button('Update now')?.click();
    expect(refreshTaskBrief).toHaveBeenCalledWith('t1', { force: true });
  });

  it('explains a failed brief and disables Update now while one is written', () => {
    mount({ briefStatus: { state: 'failed', message: 'no API key' } });
    expect(container.querySelector('.ctx-foot')?.textContent).toContain(
      'The brief could not be written: no API key',
    );
    dispose?.();
    container.textContent = '';
    mount({ briefStatus: { state: 'generating' } });
    expect(container.querySelector('.ctx-foot')?.textContent).toContain('Updating…');
    expect(button('Update now')?.disabled).toBe(true);
  });

  it('leaves out brief controls while briefs are off', () => {
    setStore('taskBriefs', false);
    mount({});
    expect(button('Update now')).toBeUndefined();
  });

  it('starts the walkthrough, unless there are no changes to walk through', () => {
    const onWalkThrough = vi.fn();
    mount({}, { onWalkThrough, walkThroughDisabled: true });
    expect(button('Walk me through')?.disabled).toBe(true);
    dispose?.();
    container.textContent = '';
    mount({}, { onWalkThrough });
    button('Walk me through')?.click();
    expect(onWalkThrough).toHaveBeenCalledOnce();
  });
});
