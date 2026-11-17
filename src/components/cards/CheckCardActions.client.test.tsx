import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardCheckResult, VerificationRun } from '../../ipc/types';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock('../../lib/ipc', () => ({ invoke: mockInvoke }));
vi.mock('../../lib/load-task-diff', () => ({
  loadTaskDiff: () => Promise.resolve({ rawDiff: '', cwd: '/wt' }),
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
}));
vi.mock('../../store/check-suite-state', () => ({
  getTaskChecks: () => [{ id: 'verify', name: 'Check', kind: 'static', command: 'npm run check' }],
  getProjectChecks: () => [],
}));

import { checkCard } from '../../lib/check-card';
import { setStore, store } from '../../store/core';
import { CardView } from './CardView';

const CARD = checkCard({ id: 'verify', name: 'Check' });

function finished(over: Partial<VerificationRun>): CardCheckResult {
  const run: VerificationRun = {
    command: 'npm run check',
    status: 'passed',
    exitCode: 0,
    headSha: 'a',
    dirty: false,
    headShaAfter: 'a',
    dirtyAfter: false,
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:00:02.000Z',
    outputTail: 'all good',
    ...over,
  };
  return { run };
}

let dispose: (() => void) | undefined;
beforeEach(() => {
  mockInvoke.mockReset();
  setStore('showCards', true);
  setStore('cardDefinitions', [CARD]);
  setStore('tasks', {
    t1: { id: 't1', projectId: 'p1', worktreePath: '/wt', gitIsolation: 'none', agentIds: [] },
  } as never);
});
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

const button = () => document.querySelector<HTMLButtonElement>('.card-check-run');
const meta = () => document.querySelector('.card-meta')?.textContent ?? '';

async function clickRun(): Promise<void> {
  button()?.click();
  await vi.waitFor(() => expect(button()?.disabled).toBe(false));
}

describe('a check card', () => {
  it('runs on demand, shows a failed run, then a result the code changed under', async () => {
    dispose = render(
      () => <CardView card={CARD} task={store.tasks.t1} now={Date.now()} />,
      document.body,
    );
    expect(button()?.textContent).toBe('Run');
    expect(meta()).toContain('not run yet');

    mockInvoke.mockResolvedValueOnce(
      finished({ status: 'timed_out', exitCode: null, message: 'Timed out after 10 min' }),
    );
    await clickRun();
    expect(meta()).toContain('failed');
    // In full under the head, where a long message wraps instead of being cut off.
    expect(document.querySelector('.card-error-detail')?.textContent).toBe(
      'Timed out after 10 min',
    );
    expect(button()?.textContent).toBe('Retry');
    expect(document.querySelector('.card-check-output pre')?.textContent).toBe('all good');

    let finishRun: (value: unknown) => void = () => {};
    mockInvoke.mockReturnValueOnce(new Promise((resolve) => (finishRun = resolve)));
    button()?.click();
    // A re-run hides the old error: the head says it is running again.
    await vi.waitFor(() => expect(document.querySelector('.card-error-detail')).toBeNull());
    finishRun(finished({ dirtyAfter: true }));
    await vi.waitFor(() => expect(button()?.disabled).toBe(false));
    expect(meta()).toContain('code changed during the run');
    expect(document.body.textContent).toContain('Passed');
    expect(button()?.textContent).toBe('Run again');
  });
});
