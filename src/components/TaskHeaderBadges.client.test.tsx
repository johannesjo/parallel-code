import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { reconcile } from 'solid-js/store';
import { render } from 'solid-js/web';
import { TaskAttentionBadges, TaskRoutineBadges } from './TaskHeaderBadges';
import { store, setStore } from '../store/core';
import { bringTaskToFront, sendTaskToBack } from '../store/background-tasks';
import { invoke } from '../lib/ipc';
import type { Task } from '../store/types';
import type { VerificationRun } from '../ipc/types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));

const task: Task = {
  id: 'one',
  name: 'one',
  projectId: 'project',
  branchName: 'one',
  worktreePath: '/tmp/one',
  agentIds: [],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
  baseBranch: 'main',
};

let container: HTMLDivElement;
let dispose: () => void;
const onFinish = vi.fn();
const [canFinish, setCanFinish] = createSignal(true);

beforeEach(() => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  bringTaskToFront('one');
  setStore('collapsedTaskOrder', []);
  setStore('tasks', reconcile({ one: { ...task } }));
  setStore('taskOrder', ['one']);
  setCanFinish(true);
  onFinish.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  dispose = render(
    () => (
      <>
        <TaskAttentionBadges task={store.tasks.one} onFinish={canFinish() ? onFinish : undefined} />
        <TaskRoutineBadges task={store.tasks.one} />
      </>
    ),
    container,
  );
});

afterEach(() => {
  dispose();
  container.remove();
});

const verifyRun = (overrides: Partial<VerificationRun>): VerificationRun => ({
  command: 'npm test',
  headSha: 'a'.repeat(40),
  dirty: false,
  startedAt: '2026-10-06T10:00:00.000Z',
  finishedAt: '2026-10-06T10:01:00.000Z',
  status: 'failed',
  exitCode: 1,
  outputTail: '',
  ...overrides,
});

// rowChipBox gives every chip a fixed height; plain status text has none.
it('marks a failing verify run as a chip that still opens Finish', () => {
  setStore('tasks', 'one', 'verificationRun', verifyRun({}));
  const signal = container.querySelector<HTMLButtonElement>('button.task-check-signal');
  expect(signal?.textContent).toBe('Verify failed');
  expect(signal?.style.height).not.toBe('');
  signal?.click();
  expect(onFinish).toHaveBeenCalledOnce();
});

it('keeps the check summary as plain text once the task cannot be finished', () => {
  setStore('tasks', 'one', 'verificationRun', verifyRun({}));
  setCanFinish(false);
  expect(container.querySelector('button.task-check-signal')).toBeNull();
  expect(container.querySelector('.task-header-badges')?.textContent).toBe('Verify failed');
});

it('keeps a verify warning as plain status text', () => {
  setStore(
    'tasks',
    'one',
    'verificationRun',
    verifyRun({ status: 'passed', exitCode: 0, dirty: true }),
  );
  const signal = container.querySelector<HTMLButtonElement>('button.task-check-signal');
  expect(signal?.textContent).toBe('Re-run verify');
  expect(signal?.style.height).toBe('');
});

// The branch bar collapses an empty group's margin with :empty, so a group
// with nothing to show must hold no nodes at all.
it('leaves both groups empty when there is nothing to show', () => {
  for (const group of container.querySelectorAll('.task-header-badges')) {
    expect(group.matches(':empty')).toBe(true);
  }
});

const badge = (label: string) =>
  [...container.querySelectorAll<HTMLElement>('.task-header-badges > *')].find(
    (el) => el.textContent === label,
  );
// happy-dom drops color-mix() values, so the status text colour marks a tint.
const isTinted = (el: HTMLElement | undefined) =>
  /var\(--(warning|error|success|accent)\)/.test(el?.style.color ?? '');
const group = (el: HTMLElement | undefined) =>
  el?.parentElement?.classList.contains('task-header-badges--routine') ? 'routine' : 'attention';

it('leads with tinted attention badges and closes with neutral routine ones', () => {
  setStore('tasks', 'one', {
    gitIsolation: 'none',
    dockerMode: true,
    externalWorktree: true,
    needsReview: true,
    landingState: 'landing_failed',
  });
  for (const label of ['no git', 'Docker', 'Imported']) {
    expect(isTinted(badge(label)), label).toBe(false);
    expect(group(badge(label)), label).toBe('routine');
  }
  for (const label of ['Review', 'Merge failed']) {
    expect(isTinted(badge(label)), label).toBe(true);
    expect(group(badge(label)), label).toBe('attention');
  }
});

it('shows the snooze badge as neutral', () => {
  sendTaskToBack('one');
  const snoozed = [...container.querySelectorAll<HTMLElement>('.task-header-badges span')].find(
    (el) => el.textContent?.startsWith('Snoozed until'),
  );
  expect(snoozed).toBeDefined();
  expect(isTinted(snoozed)).toBe(false);
});

it.each([
  ['landed_cleanup_failed', 'Cleanup failed'],
  ['landing_escalated', 'Merge blocked'],
  ['landing_failed', 'Merge failed'],
] as const)('renders %s as a tinted, non-interactive badge', (landingState, label) => {
  setStore('tasks', 'one', 'landingState', landingState);
  const el = badge(label);
  expect(el?.tagName).toBe('SPAN');
  expect(isTinted(el)).toBe(true);
});

it('marks a merged task reviewed from its neutral badge', () => {
  setStore('tasks', 'one', { landingState: 'landed_pending_review', needsReview: false });
  const landed = badge('Merged');
  expect(landed?.tagName).toBe('BUTTON');
  expect(landed?.getAttribute('type')).toBe('button');
  expect(isTinted(landed)).toBe(false);

  landed?.click();
  expect(store.tasks.one.landingState).toBe('reviewed');
  const reviewed = badge('Reviewed');
  expect(reviewed?.tagName).toBe('SPAN');
  expect(isTinted(reviewed)).toBe(false);
});
