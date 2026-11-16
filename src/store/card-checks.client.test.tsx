import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardCheckResult, VerificationRun } from '../ipc/types';

const { mockInvoke, mockDiff } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockDiff: { reads: [] as string[] },
}));
vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));
vi.mock('../lib/load-task-diff', () => ({
  loadTaskDiff: () =>
    Promise.resolve({ rawDiff: mockDiff.reads.shift() ?? 'diff --git a/x b/x\n+x', cwd: '/wt' }),
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
}));
vi.mock('./projects', () => ({ getProjectPath: () => '/repo' }));
vi.mock('./check-suite-state', () => ({
  getTaskChecks: () => [{ id: 'verify', name: 'Check', kind: 'static', command: 'npm run check' }],
}));

import { readCard } from '../lib/card-display';
import { checkCard } from '../lib/check-card';
import { diffFingerprint } from '../lib/diff-excerpt';
import { getCheckCardRun, runCheckCard } from './card-checks';
import { cardTaskState } from './app-facts';
import { saveCard } from './cards';
import { setStore, store } from './core';
import type { Task } from './types';

const CARD = checkCard({ id: 'verify', name: 'Check' });
const OLD = {
  at: 1,
  values: { result: { type: 'status', rows: [{ state: 'ok', text: 'Passed' }] } },
};

function result(over: Partial<VerificationRun>): CardCheckResult {
  return {
    run: {
      command: 'npm run check',
      status: 'failed',
      exitCode: 1,
      headSha: 'a',
      dirty: false,
      headShaAfter: 'a',
      dirtyAfter: false,
      startedAt: '2026-01-01T10:00:00.000Z',
      finishedAt: '2026-01-01T10:00:05.000Z',
      outputTail: 'lint: 2 errors',
      ...over,
    },
  };
}

beforeEach(() => {
  mockInvoke.mockReset();
  setStore('cardDefinitions', [CARD]);
  setStore('tasks', {
    t1: {
      id: 't1',
      name: 'Fix login',
      projectId: 'p1',
      worktreePath: '/wt',
      gitIsolation: 'worktree',
      baseBranch: 'main',
      agentIds: [],
      cards: { [CARD.id]: OLD },
    } as unknown as Task,
  });
});

describe('runCheckCard', () => {
  it('shows the result, made from the code read before the run', async () => {
    mockInvoke.mockResolvedValue(result({}));
    await runCheckCard('t1', CARD.id);
    expect(mockInvoke.mock.calls[0][1]).toMatchObject({
      command: 'npm run check',
      mode: 'exit-code',
      taskName: 'Fix login',
      baseBranch: 'main',
      diff: 'diff --git a/x b/x\n+x',
      previous: JSON.stringify(OLD.values),
    });
    const values = store.tasks.t1.cards?.[CARD.id];
    expect(values?.values.result).toEqual({
      type: 'status',
      rows: [{ state: 'fail', text: 'Failed', value: 'exit 1 · 5 s' }],
    });
    expect(values?.fingerprint).toBe(diffFingerprint('diff --git a/x b/x\n+x'));
    expect(getCheckCardRun('t1', CARD.id)).toEqual({
      changed: false,
      outputTail: 'lint: 2 errors',
    });
  });

  it('marks a result the code changed under', async () => {
    mockInvoke.mockResolvedValue(result({ status: 'passed', exitCode: 0, dirtyAfter: true }));
    await runCheckCard('t1', CARD.id);
    expect(getCheckCardRun('t1', CARD.id).changed).toBe(true);
  });

  it('marks a result the code changed under on a tree that was already dirty', async () => {
    mockDiff.reads = ['diff --git a/x b/x\n+x', 'diff --git a/x b/x\n+x\n+edited'];
    mockInvoke.mockResolvedValue(
      result({ status: 'passed', exitCode: 0, dirty: true, dirtyAfter: true }),
    );
    await runCheckCard('t1', CARD.id);
    expect(getCheckCardRun('t1', CARD.id).changed).toBe(true);
    // Pins, summaries and the popover read the stored result, so it must read as outdated too.
    const card = readCard(CARD, cardTaskState(store.tasks.t1), 'haiku');
    expect(card.outdated).toBe(true);
  });

  it('keeps the previous values when the run times out', async () => {
    mockInvoke.mockResolvedValue(
      result({ status: 'timed_out', message: 'Timed out after 10 min' }),
    );
    await runCheckCard('t1', CARD.id);
    expect(store.tasks.t1.cards?.[CARD.id]).toEqual(OLD);
    expect(getCheckCardRun('t1', CARD.id).error).toBe('Timed out after 10 min');
  });

  it('drops the result of a run whose card was saved meanwhile', async () => {
    let finish: (value: CardCheckResult) => void = () => undefined;
    mockInvoke.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const run = runCheckCard('t1', CARD.id);
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
    saveCard({ ...structuredClone(CARD), slots: [{ id: 'note', type: 'line', label: 'Note' }] });
    finish(result({}));
    await run;
    expect(store.tasks.t1.cards?.[CARD.id]?.values.result).toBeUndefined();
  });

  it('drops the result of a run a newer one replaced', async () => {
    let finishFirst: (value: CardCheckResult) => void = () => undefined;
    mockInvoke
      .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce(result({ status: 'passed', exitCode: 0 }));
    const first = runCheckCard('t1', CARD.id);
    await runCheckCard('t1', CARD.id);
    finishFirst(result({ status: 'cancelled', message: 'Cancelled.' }));
    await first;
    expect(getCheckCardRun('t1', CARD.id).error).toBeUndefined();
    const rows = store.tasks.t1.cards?.[CARD.id]?.values.result;
    expect(rows).toMatchObject({ rows: [{ text: 'Passed' }] });
  });
});
