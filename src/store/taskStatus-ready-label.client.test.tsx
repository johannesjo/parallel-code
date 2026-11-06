import { afterEach, expect, it, vi } from 'vitest';
import { reconcile } from 'solid-js/store';
import { setStore } from './core';
import {
  extraPrWatchId,
  removePrChecks,
  setPrChecks,
  setTaskExtraPrs,
  type PrChecksState,
} from './pr-checks-state';
import { getReadyLabel } from './taskStatus';
import type { Task } from './types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));

const extra = 'https://github.com/o/lib/pull/3';
const checks = (overall: PrChecksState['overall']): PrChecksState => ({
  overall,
  passing: 0,
  pending: 0,
  failing: 0,
  checks: [],
  checkedAt: '2026-10-10T00:00:00Z',
});

afterEach(() => {
  setTaskExtraPrs('t', []);
  removePrChecks('t');
  removePrChecks(extraPrWatchId('t', extra));
  setStore('tasks', reconcile({}));
});

it('names the state of the PR that most needs attention, not just the task’s own', () => {
  setStore('tasks', { t: { id: 't', prUrl: 'https://github.com/o/r/pull/7' } as Task });
  setPrChecks('t', checks('success'));
  expect(getReadyLabel('t')).toBe('Ready to merge');
  setTaskExtraPrs('t', [{ url: extra, repo: 'lib' }]);
  setPrChecks(extraPrWatchId('t', extra), checks('pending'));
  expect(getReadyLabel('t')).toBe('CI running');
});
