import { reconcile } from 'solid-js/store';
import { afterEach, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import {
  extraPrWatchId,
  removePrChecks,
  setPrChecks,
  setTaskExtraPrs,
  type PrChecksState,
} from '../store/pr-checks-state';
import { awaitsOpenPr } from '../store/task-prs';
import type { Task } from '../store/types';
import { boardLaneOf } from './task-board-lanes';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn(), fireAndForget: vi.fn() }));

const extraUrl = 'https://github.com/acme/lib/pull/3';
const task = {
  id: 'task-1',
  name: 'Task',
  projectId: 'project-1',
  agentIds: [],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
  gitIsolation: 'worktree',
} as unknown as Task;

const checks = (overrides: Partial<PrChecksState>): PrChecksState => ({
  overall: 'pending',
  passing: 0,
  pending: 1,
  failing: 0,
  checks: [],
  checkedAt: '2026-11-05T00:00:00Z',
  ...overrides,
});

afterEach(() => {
  setTaskExtraPrs('task-1', []);
  removePrChecks('task-1');
  removePrChecks(extraPrWatchId('task-1', extraUrl));
  setStore('tasks', reconcile({}));
});

it('puts a task whose only PR is in a nested repository in pull request', () => {
  setStore('tasks', reconcile({ 'task-1': task }));
  expect(boardLaneOf(task)).toBe('stopped');
  setTaskExtraPrs('task-1', [{ url: extraUrl, repo: 'lib' }]);
  setPrChecks(extraPrWatchId('task-1', extraUrl), checks({}));
  expect(boardLaneOf(task)).toBe('pr');
});

it('keeps a task in pull request while another PR is open after its own merged', () => {
  const withPr = { ...task, prUrl: 'https://github.com/acme/app/pull/12' };
  setStore('tasks', reconcile({ 'task-1': withPr }));
  setPrChecks('task-1', checks({ overall: 'none', merged: true }));
  setTaskExtraPrs('task-1', [{ url: extraUrl, repo: 'lib' }]);
  setPrChecks(extraPrWatchId('task-1', extraUrl), checks({ overall: 'failure', failing: 1 }));
  expect(boardLaneOf(withPr)).toBe('needs');
});

it('routes a signalled-done subtask with a PR by its CI, not straight to Needs you', () => {
  const done = { ...task, signalDoneReceived: true };
  setStore('tasks', reconcile({ 'task-1': done }));
  expect(boardLaneOf(done)).toBe('needs');
  const withPr = { ...done, prUrl: 'https://github.com/acme/app/pull/12' };
  setStore('tasks', reconcile({ 'task-1': withPr }));
  setPrChecks('task-1', checks({}));
  expect(boardLaneOf(withPr)).toBe('pr');
  expect(awaitsOpenPr(withPr, false)).toBe(true);
  setPrChecks('task-1', checks({ overall: 'failure', pending: 0, failing: 1 }));
  expect(boardLaneOf(withPr)).toBe('needs');
  // The sidebar tray shares this rule, so it lists the failing result too.
  expect(awaitsOpenPr(withPr, false)).toBe(false);
  // Babysit owns a CI failure while it can act.
  expect(awaitsOpenPr(withPr, true)).toBe(true);
  setPrChecks('task-1', checks({ overall: 'success', pending: 0, passing: 1 }));
  expect(boardLaneOf(withPr)).toBe('ready');
});

it('returns a signalled-done subtask to Needs you once its PR merged', () => {
  const merged = {
    ...task,
    signalDoneReceived: true,
    prUrl: 'https://github.com/acme/app/pull/12',
  };
  setStore('tasks', reconcile({ 'task-1': merged }));
  setPrChecks('task-1', checks({ overall: 'success', pending: 0, merged: true }));
  expect(boardLaneOf(merged)).toBe('needs');
});

it('keeps a subtask whose landing needs review in Needs you despite running CI', () => {
  const escalated = { ...task, needsReview: true, prUrl: 'https://github.com/acme/app/pull/12' };
  setStore('tasks', reconcile({ 'task-1': escalated }));
  setPrChecks('task-1', checks({}));
  expect(boardLaneOf(escalated)).toBe('needs');
  const landed: Task = { ...escalated, needsReview: false, landingState: 'landed_pending_review' };
  setStore('tasks', reconcile({ 'task-1': landed }));
  expect(boardLaneOf(landed)).toBe('needs');
});
