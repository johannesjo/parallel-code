import { beforeEach, describe, expect, it, vi } from 'vitest';

// Client suite: the unit suite renders Solid for the server, where effects never run.
const { mockIsTaskWorking, mockDiff, mockRequest, mockInvoke } = vi.hoisted(() => ({
  mockIsTaskWorking: vi.fn(),
  mockDiff: { raw: '' },
  mockRequest: vi.fn(),
  mockInvoke: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('../lib/model-request', () => ({ startModelRequest: mockRequest }));
vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));
vi.mock('./check-suite-state', () => ({
  getTaskChecks: () => [{ id: 'verify', name: 'Check', kind: 'static', command: 'npm test' }],
}));

vi.mock('../lib/load-task-diff', () => ({
  loadTaskDiff: () => Promise.resolve({ rawDiff: mockDiff.raw, cwd: '/wt' }),
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
}));
vi.mock('./projects', () => ({ getProjectPath: () => '/repo' }));
vi.mock('./taskStatus', () => ({
  isTaskWorking: mockIsTaskWorking,
  getAgentOutputTail: () => '',
  normalizeCurrentFrame: (tail: string) => tail,
}));

import { appFactCard } from '../lib/app-facts';
import { confidenceCard, type CardDefinition } from '../lib/cards';
import { checkCard } from '../lib/check-card';
import { legacyRatingValues } from '../lib/confidence-card';
import { IPC } from '../../electron/ipc/channels';
import { isConfidenceOutdated, type TaskConfidence } from '../lib/task-confidence';
import { diffFingerprint } from '../lib/diff-excerpt';
import { store, setStore } from './core';
import { modelCallsPerTurn } from './cards';
import { startTurnWatcher } from './turn-watcher';
import type { Task } from './types';

const AGENT_CARD: CardDefinition = {
  id: 'done-criteria',
  name: 'Done criteria',
  description: '',
  source: { kind: 'agent' },
  slots: [{ id: 'steps', type: 'checklist', label: 'Steps' }],
  enabled: true,
};
const CHANGED = 'diff --git a/x b/x\n+changed';

beforeEach(() => {
  vi.clearAllMocks();
  mockDiff.raw = '';
  setStore('showCards', true);
  setStore('cardDefinitions', []);
  setStore('tasks', {
    t1: {
      id: 't1',
      name: 'Setup',
      projectId: 'p1',
      worktreePath: '/wt',
      gitIsolation: 'worktree',
      agentIds: ['agent-1'],
    } as unknown as Task,
  });
});

/** Runs one agent turn that changes the code, then lets it settle. */
async function runTurn(diff = CHANGED): Promise<void> {
  vi.useFakeTimers();
  try {
    setStore('taskOrder', ['t1']);
    mockIsTaskWorking.mockReturnValue(true);
    const stop = startTurnWatcher();
    await vi.advanceTimersByTimeAsync(0);
    mockDiff.raw = diff;
    mockIsTaskWorking.mockReturnValue(false);
    setStore('taskOrder', ['t1']);
    await vi.advanceTimersByTimeAsync(5_000);
    stop();
  } finally {
    vi.useRealTimers();
  }
}

function modelCard(id: string, trigger: 'after-turn' | 'manual'): CardDefinition {
  return {
    id,
    name: id,
    description: '',
    source: { kind: 'model', model: 'default', prompt: 'Say.', inputs: ['diff'], trigger },
    slots: [{ id: 'now', type: 'line', label: 'Now' }],
    enabled: true,
  };
}

describe('startTurnWatcher', () => {
  it('dates a rating after a code change while a card is on', async () => {
    setStore('cardDefinitions', [structuredClone(AGENT_CARD)]);
    const rating: TaskConfidence = {
      scores: [],
      findings: [],
      publishedAt: 1,
      fingerprint: diffFingerprint(''),
    };
    setStore('tasks', 't1', 'cards', { confidence: legacyRatingValues(rating) });
    await runTurn();
    expect(store.tasks.t1.codeFingerprint?.fingerprint).toBe(diffFingerprint(CHANGED));
    expect(isConfidenceOutdated(rating, store.tasks.t1.codeFingerprint)).toBe(true);
  });

  it('dates a rating after a code change with no card on', async () => {
    const rating: TaskConfidence = {
      scores: [],
      findings: [],
      publishedAt: 1,
      fingerprint: diffFingerprint(''),
    };
    setStore('tasks', 't1', 'cards', { confidence: legacyRatingValues(rating) });
    await runTurn();
    expect(isConfidenceOutdated(rating, store.tasks.t1.codeFingerprint)).toBe(true);
  });

  it('reads nothing while no card is on and nothing is rated', async () => {
    await runTurn();
    expect(store.tasks.t1.codeFingerprint).toBeUndefined();
  });

  it('reads nothing while only Confidence is on and nothing is rated', async () => {
    setStore('cardDefinitions', [confidenceCard(true)]);
    await runTurn();
    expect(store.tasks.t1.codeFingerprint).toBeUndefined();
  });

  it('reads an idle task once when a diff card is on, without waiting for a turn', async () => {
    setStore('cardDefinitions', [appFactCard('diff-size', true)]);
    mockDiff.raw = 'diff --git a/x b/x\n@@ -1 +1,2 @@\n+one\n+two\n-old';
    vi.useFakeTimers();
    try {
      setStore('taskOrder', ['t1']);
      mockIsTaskWorking.mockReturnValue(false);
      const stop = startTurnWatcher();
      await vi.advanceTimersByTimeAsync(5_000);
      stop();
    } finally {
      vi.useRealTimers();
    }
    expect(store.tasks.t1.facts?.diff).toEqual({
      added: 2,
      removed: 1,
      files: 1,
      at: expect.any(Number) as number,
    });
  });

  it('spreads the first reads of idle tasks out, so launch does not start every git read at once', async () => {
    setStore('cardDefinitions', [appFactCard('diff-size', true)]);
    mockDiff.raw = 'diff --git a/x b/x\n+one';
    const task = (id: string) => ({ ...store.tasks.t1, id }) as Task;
    setStore('tasks', { t2: task('t2'), t3: task('t3') });
    vi.useFakeTimers();
    try {
      setStore('taskOrder', ['t1', 't2', 't3']);
      mockIsTaskWorking.mockReturnValue(false);
      const stop = startTurnWatcher();
      await vi.advanceTimersByTimeAsync(4_100);
      expect(['t1', 't2', 't3'].map((id) => !!store.tasks[id].facts)).toEqual([true, false, false]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(['t1', 't2', 't3'].map((id) => !!store.tasks[id].facts)).toEqual([true, true, true]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends as many requests after a turn as the Cards tab promises, and none for an unchanged turn', async () => {
    setStore('cardDefinitions', [
      modelCard('a', 'after-turn'),
      modelCard('b', 'after-turn'),
      modelCard('c', 'manual'),
    ]);
    mockRequest.mockImplementation(() => ({
      result: Promise.resolve('{"now":"Added retries"}'),
      cancel: vi.fn(),
    }));
    await runTurn();
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(modelCallsPerTurn()).toBe(2);
    await runTurn();
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('sends no request when it first reads an idle task, only after a turn', async () => {
    setStore('cardDefinitions', [modelCard('a', 'after-turn')]);
    setStore('tasks', 't1', 'promptHistory', [{ text: 'add retries', sentAt: 1 }] as never);
    vi.useFakeTimers();
    try {
      setStore('taskOrder', ['t1']);
      mockIsTaskWorking.mockReturnValue(false);
      const stop = startTurnWatcher();
      await vi.advanceTimersByTimeAsync(5_000);
      stop();
    } finally {
      vi.useRealTimers();
    }
    expect(store.tasks.t1.codeFingerprint).toBeDefined();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("runs an after-turn check card after a turn, from that turn's diff, but not on a first read", async () => {
    const card = checkCard({ id: 'verify', name: 'Check' });
    const source = { kind: 'check', checkId: 'verify', mode: 'exit-code', trigger: 'after-turn' };
    setStore('cardDefinitions', [{ ...card, source } as CardDefinition]);
    const checkRuns = () =>
      (mockInvoke.mock.calls as unknown as [string, Record<string, unknown>][]).filter(
        ([channel]) => channel === IPC.RunCardCheck,
      );
    vi.useFakeTimers();
    try {
      setStore('taskOrder', ['t1']);
      mockIsTaskWorking.mockReturnValue(false);
      const stop = startTurnWatcher();
      await vi.advanceTimersByTimeAsync(5_000);
      stop();
    } finally {
      vi.useRealTimers();
    }
    expect(checkRuns()).toEqual([]);
    await runTurn();
    expect(checkRuns()).toHaveLength(1);
    expect(checkRuns()[0][1]).toMatchObject({ command: 'npm test', diff: CHANGED });
  });

  it('reads nothing for live facts alone: activity and CI need no diff', async () => {
    setStore('cardDefinitions', [appFactCard('activity', true), appFactCard('ci', true)]);
    await runTurn();
    expect(store.tasks.t1.codeFingerprint).toBeUndefined();
  });

  it('reads nothing while cards are hidden', async () => {
    setStore('showCards', false);
    setStore('cardDefinitions', [structuredClone(AGENT_CARD)]);
    await runTurn();
    expect(store.tasks.t1.codeFingerprint).toBeUndefined();
  });
});
