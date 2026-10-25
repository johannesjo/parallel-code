import { beforeEach, describe, expect, it } from 'vitest';
import { reviewItemId, type ReviewItem } from '../lib/review-summary';
import { setStore, store } from './core';
import {
  dismissReviewItem,
  getReviewDismissals,
  restoreReviewItem,
  setReviewDismissReason,
  stageRework,
} from './review';
import type { Task } from './types';

function risk(text: string): ReviewItem {
  return {
    id: reviewItemId('risk', text),
    kind: 'risk',
    text,
    source: 'From the confidence check',
    ask: `Address this risk: ${text}`,
  };
}

beforeEach(() => {
  const task = {
    id: 't1',
    name: 'Task',
    projectId: 'p1',
    branchName: 'branch',
    worktreePath: '/repo',
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
  } as unknown as Task;
  setStore('tasks', { t1: task });
  setStore('showPromptInput', false);
});

describe('review dismissals', () => {
  it('stores a dismissal with its reason and lists it for the next rating', () => {
    dismissReviewItem('t1', risk('No real provider.'), 'CI covers it');
    setReviewDismissReason('t1', reviewItemId('risk', 'No real provider.'), 'CI and staging');
    expect(getReviewDismissals('t1')).toEqual([
      { text: 'No real provider.', reason: 'CI and staging' },
    ]);
  });

  it('removes one dismissal and clears the record once the last one goes', () => {
    dismissReviewItem('t1', risk('One.'));
    dismissReviewItem('t1', risk('Two.'));
    restoreReviewItem('t1', reviewItemId('risk', 'One.'));
    expect(Object.keys(store.tasks.t1.reviewDismissed ?? {})).toEqual([
      reviewItemId('risk', 'Two.'),
    ]);
    restoreReviewItem('t1', reviewItemId('risk', 'Two.'));
    expect(store.tasks.t1.reviewDismissed).toBeUndefined();
  });

  it('ignores tasks that are gone and reasons for items never dismissed', () => {
    dismissReviewItem('missing', risk('One.'));
    setReviewDismissReason('t1', 'risk:none', 'why');
    expect(store.tasks.t1.reviewDismissed).toBeUndefined();
  });
});

describe('stageRework', () => {
  it('stages one prompt in the task input and refuses an empty one', () => {
    expect(stageRework('t1', [])).toBe(false);
    expect(stageRework('t1', [risk('No real provider.')])).toBe(true);
    expect(store.tasks.t1.prefillPrompt).toBe(
      'Please rework this task based on my review:\n\n- Address this risk: No real provider.',
    );
    expect(store.showPromptInput).toBe(true);
  });

  it('marks decisions it asks about as handled in the brief', () => {
    setStore('tasks', 't1', 'brief', {
      brief: {
        goal: '',
        headline: '',
        unbacked: [],
        changed: [],
        extra: [],
        open: [],
        decided: [{ text: 'Used X.' }],
      },
      generatedAt: 1,
      fingerprint: 'f',
      turns: [],
      decisions: {},
    });
    const decision: ReviewItem = {
      id: reviewItemId('decision', 'Used X.'),
      kind: 'decision',
      text: 'Used X.',
      source: '',
      ask: 'Reconsider this decision: Used X.',
    };
    stageRework('t1', [decision]);
    expect(store.tasks.t1.brief?.decisions).toEqual({ 'Used X.': 'sent' });
  });
});

describe('dismissal cap', () => {
  it('drops the oldest dismissals past the cap', () => {
    for (let i = 0; i < 52; i++) dismissReviewItem('t1', risk(`Risk ${i}.`));
    const ids = Object.keys(store.tasks.t1.reviewDismissed ?? {});
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe(reviewItemId('risk', 'Risk 2.'));
  });
});
