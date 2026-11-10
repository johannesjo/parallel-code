import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import type { Task } from '../store/types';
import { TaskContextStrip, currentPlanStep } from './TaskContextStrip';

let container: HTMLDivElement;
let dispose: (() => void) | undefined;

function mount(fields: Partial<Task>, onWalkThrough?: () => void): void {
  setStore('tasks', { t1: { id: 't1', agentIds: ['a1'], ...fields } as unknown as Task });
  dispose = render(
    () => <TaskContextStrip task={store.tasks.t1} onWalkThrough={onWalkThrough} />,
    container,
  );
}

const strip = () => container.querySelector<HTMLButtonElement>('.ctx-strip');
const popover = () => document.querySelector('[role="dialog"][aria-label="Task context"]');

const plan = {
  steps: [
    { step: 'Read the scripts', status: 'completed' as const },
    { step: 'Check the dev command', status: 'in_progress' as const },
    { step: 'Commit', status: 'pending' as const },
  ],
  updatedAt: 1,
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  setStore({ agents: {}, taskBriefs: false });
});

afterEach(() => {
  dispose?.();
  container.remove();
});

describe('currentPlanStep', () => {
  it('names the step in progress, else the next to do, else the last', () => {
    expect(currentPlanStep(plan.steps)).toBe('Check the dev command');
    expect(
      currentPlanStep([
        { step: 'A', status: 'completed' },
        { step: 'B', status: 'pending' },
      ]),
    ).toBe('B');
    expect(
      currentPlanStep([
        { step: 'A', status: 'completed' },
        { step: 'B', status: 'completed' },
      ]),
    ).toBe('B');
    expect(currentPlanStep([])).toBe('');
  });
});

describe('TaskContextStrip', () => {
  it("names the plan's progress and current step in one line", () => {
    mount({ agentPlan: plan });
    expect(strip()?.textContent).toBe('Plan1/3 ·Check the dev command▾');
  });

  it('shows the goal until the agent writes a plan', () => {
    mount({ savedInitialPrompt: 'Fix the login redirect\nMore detail' });
    expect(strip()?.textContent).toBe('GoalFix the login redirect▾');
  });

  it('keeps the strip quiet and puts the hint in a tooltip until there is a goal or plan', () => {
    mount({});
    expect(strip()?.textContent).toBe('Goal▾');
    expect(strip()?.title).toBe("The agent's plan shows here once it writes a to-do list");
  });

  it('drops the hint tooltip once there is a goal or plan', () => {
    mount({ savedInitialPrompt: 'Fix the login redirect' });
    expect(strip()?.hasAttribute('title')).toBe(false);
    dispose?.();
    mount({ agentPlan: plan });
    expect(strip()?.hasAttribute('title')).toBe(false);
  });

  it('opens the full context below and closes it on Escape', () => {
    mount({ agentPlan: plan });
    strip()?.click();
    expect(strip()?.getAttribute('aria-expanded')).toBe('true');
    expect(popover()?.querySelectorAll('li')).toHaveLength(3);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(popover()).toBeNull();
    expect(strip()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on a click outside, but not on one inside', () => {
    mount({ agentPlan: plan });
    strip()?.click();
    popover()
      ?.querySelector('li')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(popover()).not.toBeNull();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(popover()).toBeNull();
  });

  it('closes before starting the walkthrough', () => {
    const onWalkThrough = vi.fn();
    mount({}, onWalkThrough);
    strip()?.click();
    const walk = [...(popover()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Walk me through',
    );
    walk?.click();
    expect(onWalkThrough).toHaveBeenCalledOnce();
    expect(popover()).toBeNull();
  });
});
