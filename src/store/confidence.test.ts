import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLoadTaskDiff } = vi.hoisted(() => ({ mockLoadTaskDiff: vi.fn() }));

vi.mock('../lib/load-task-diff', () => ({
  loadTaskDiff: mockLoadTaskDiff,
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
}));
vi.mock('./projects', () => ({ getProjectPath: () => '/repo' }));

import type { SlotDefinition } from '../lib/card-slots';
import { confidenceCard, defaultConfidenceSlots } from '../lib/cards';
import { publishCardValues } from './card-publish';
import { mergeConfidence, publishTaskConfidence, storeRating, taskConfidence } from './confidence';
import { store, setStore } from './core';
import type { Task } from './types';

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+change';
const HEAD = 'c'.repeat(40);

/** A confidence_publish payload as skills sent it before the card was editable. */
const CLASSIC = {
  scores: [{ label: 'Correct', score: 80, why: 'Tested.', verified: ['npm test'] }],
  findings: [{ kind: 'gap', text: 'No docs', axis: 'Complete' }],
  source: 'confidence skill',
  asked: 'Add retries',
  changes: [{ now: 'Retries back off' }],
  keyLine: { file: 'src/retry.ts', line: 9, why: 'Start here' },
};

function useLayout(slots: SlotDefinition[]) {
  setStore('cardDefinitions', [confidenceCard(true, slots)]);
}

const task = () => store.tasks.t1;

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadTaskDiff.mockResolvedValue({ rawDiff: DIFF, cwd: '/wt' });
  setStore('cardDefinitions', [confidenceCard(true)]);
  setStore('tasks', {
    t1: {
      id: 't1',
      name: 'Fix login',
      projectId: 'p1',
      worktreePath: '/wt',
      gitIsolation: 'worktree',
      agentIds: ['agent-1'],
    } as unknown as Task,
  });
});

describe('publishTaskConfidence (confidence_publish)', () => {
  it('stores an old payload in the Confidence card and reads it back unchanged', () => {
    publishTaskConfidence('t1', structuredClone(CLASSIC));
    expect(taskConfidence(task())).toMatchObject({
      scores: CLASSIC.scores,
      findings: [{ kind: 'risk', text: 'No docs', axis: 'Complete' }],
      source: 'confidence skill',
      asked: 'Add retries',
      changes: [{ now: 'Retries back off' }],
      keyLine: { file: 'src/retry.ts', line: 9, why: 'Start here' },
    });
    expect(task().cards?.confidence?.origin).toBeUndefined();
  });

  it('keeps rejecting what it rejected before, with the same message', () => {
    expect(() => publishTaskConfidence('t1', { scores: [] })).toThrow('scores must be');
    expect(() =>
      publishTaskConfidence('t1', { scores: [{ label: 'C', score: 120, why: 'x' }] }),
    ).toThrow('scores[0].score must be a number from 0 to 100.');
    expect(task().cards?.confidence).toBeUndefined();
  });

  it('still lands when the user removed slots, dropping only their parts', () => {
    useLayout([{ id: 'scores', type: 'scores', label: 'Scores', warnBelow: 60 }]);
    publishTaskConfidence('t1', structuredClone(CLASSIC));
    expect(Object.keys(task().cards?.confidence?.values ?? {})).toEqual(['scores']);
  });

  it('lands while the card is switched off, since Finish and merge still read it', () => {
    setStore('cardDefinitions', [confidenceCard(false)]);
    publishTaskConfidence('t1', structuredClone(CLASSIC));
    expect(taskConfidence(task())?.scores).toEqual(CLASSIC.scores);
  });

  it('replaces the previous rating instead of keeping its parts', () => {
    publishTaskConfidence('t1', structuredClone(CLASSIC));
    publishTaskConfidence('t1', { scores: [{ label: 'Correct', score: 90, why: 'x' }] });
    expect(taskConfidence(task())).toMatchObject({ findings: [] });
    expect(taskConfidence(task())?.asked).toBeUndefined();
  });
});

describe('card_publish to the Confidence card', () => {
  it('accepts the classic payload, plus values for a slot the user added', () => {
    useLayout([...defaultConfidenceSlots(), { id: 'note', type: 'line', label: 'Note' }]);
    publishCardValues('t1', 'confidence', { ...structuredClone(CLASSIC), note: 'Ship it' });
    expect(task().cards?.confidence?.values.note).toEqual({ type: 'line', text: 'Ship it' });
    expect(taskConfidence(task())?.scores).toEqual(CLASSIC.scores);
  });

  it('accepts values keyed by its slots', () => {
    publishCardValues('t1', 'confidence', {
      scores: { scores: [{ label: 'Correct', score: 70, why: 'x' }] },
      findings: [{ text: 'Unclear name', severity: 'warn' }],
    });
    expect(taskConfidence(task())).toMatchObject({
      scores: [{ label: 'Correct', score: 70, why: 'x' }],
      findings: [{ kind: 'unverified', text: 'Unclear name' }],
    });
  });

  it('accepts a bare score list beside slot-keyed findings, as card_list describes it', () => {
    publishCardValues('t1', 'confidence', {
      scores: [{ label: 'Correct', score: 70, why: 'x' }],
      findings: [{ text: 'Unclear name', severity: 'warn' }],
    });
    expect(taskConfidence(task())?.findings).toEqual([
      { kind: 'unverified', text: 'Unclear name' },
    ]);
  });

  it('accepts list slots as card_list describes them, optional fields left out', () => {
    publishCardValues('t1', 'confidence', {
      scores: [{ label: 'Correct', score: 70, why: 'x' }],
      findings: [{ text: 'Unclear name' }],
      changes: [{ text: 'Retries back off' }],
    });
    expect(taskConfidence(task())).toMatchObject({
      findings: [{ kind: 'extra', text: 'Unclear name' }],
      changes: [{ now: 'Retries back off' }],
    });
  });

  it('rejects a broken classic payload with the confidence_publish message', () => {
    expect(() => publishCardValues('t1', 'confidence', { scores: [] })).toThrow('scores must be');
  });

  it('rejects values without scores as a rating without scores, as before', () => {
    expect(() => publishCardValues('t1', 'confidence', { asked: 'x' })).toThrow('scores must be');
    expect(task().cards?.confidence).toBeUndefined();
  });
});

describe('the app reviewer writing a rating', () => {
  const REVIEW = { scores: [{ label: 'Correct', score: 85, why: 'x' }], findings: [] };

  it('keeps who wrote it, the commit it read and the code fingerprint', () => {
    storeRating('t1', REVIEW, { at: 7, fingerprint: 'fp', origin: 'review', headSha: HEAD });
    expect(mergeConfidence(task())).toMatchObject({
      publishedAt: 7,
      fingerprint: 'fp',
      origin: 'review',
      headSha: HEAD,
      warnBelow: 60,
    });
  });

  it('loses its merge stamp once the agent publishes over it', () => {
    storeRating('t1', REVIEW, { at: 7, origin: 'review', headSha: HEAD });
    publishTaskConfidence('t1', structuredClone(CLASSIC));
    expect(mergeConfidence(task())?.origin).toBeUndefined();
  });

  it('offers no rating to the merge check while the findings slot was gone during the review', () => {
    useLayout([{ id: 'scores', type: 'scores', label: 'Scores', warnBelow: 60 }]);
    storeRating(
      't1',
      { ...REVIEW, findings: [{ kind: 'risk', text: 'Loops' }] },
      {
        at: 7,
        origin: 'review',
        headSha: HEAD,
      },
    );
    // Added back, the slot is empty: no findings stored is not "nothing found".
    useLayout(defaultConfidenceSlots());
    expect(mergeConfidence(task())).toBeUndefined();
  });

  it('offers no rating to the merge check once the layout lost the findings', () => {
    useLayout([{ id: 'scores', type: 'scores', label: 'Scores', warnBelow: 60 }]);
    storeRating('t1', REVIEW, { at: 7, origin: 'review', headSha: HEAD });
    expect(taskConfidence(task())?.scores).toEqual(REVIEW.scores);
    expect(mergeConfidence(task())).toBeUndefined();
  });
});
