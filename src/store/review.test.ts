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
    expect(stageRework('t1', [], '  ')).toBe(false);
    expect(stageRework('t1', [risk('No real provider.')], '')).toBe(true);
    expect(store.tasks.t1.prefillPrompt).toBe(
      'Please rework this task based on my review:\n\n- Address this risk: No real provider.',
    );
    expect(store.showPromptInput).toBe(true);
  });
});
