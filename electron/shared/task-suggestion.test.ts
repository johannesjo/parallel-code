import { describe, expect, it } from 'vitest';
import {
  parseTaskSuggestionRequest,
  pruneTaskSuggestions,
  restoreTaskSuggestions,
  TASK_SUGGESTION_LIMITS,
  type TaskSuggestion,
} from './task-suggestion.js';

const input = {
  title: 'Fix stale README badge',
  tldr: 'The badge points at a removed workflow.',
  prompt: 'Update README.md.\n\nDone when the badge renders.',
};

function suggestion(overrides: Partial<TaskSuggestion> = {}): TaskSuggestion {
  return { id: 'suggestion_ab12cd34', createdAt: 1, status: 'pending', ...input, ...overrides };
}

describe('parseTaskSuggestionRequest', () => {
  it('collapses title and tldr to one line but keeps the prompt as written', () => {
    expect(
      parseTaskSuggestionRequest({
        action: 'suggest',
        title: ' Fix stale\n README badge ',
        tldr: input.tldr,
        prompt: `  ${input.prompt}  `,
      }),
    ).toEqual({ action: 'suggest', ...input });
  });

  it('rejects empty or oversized fields with a message the agent can act on', () => {
    expect(() => parseTaskSuggestionRequest({ action: 'suggest', ...input, title: ' ' })).toThrow(
      'title must not be empty',
    );
    expect(() =>
      parseTaskSuggestionRequest({ action: 'suggest', ...input, tldr: 'x'.repeat(401) }),
    ).toThrow('at most 400');
    expect(() =>
      parseTaskSuggestionRequest({
        action: 'suggest',
        ...input,
        prompt: 'é'.repeat(TASK_SUGGESTION_LIMITS.promptBytes / 2 + 1),
      }),
    ).toThrow('bytes');
    expect(() => parseTaskSuggestionRequest({ action: 'other' })).toThrow('action');
  });

  it('rejects text that could hide or reorder what the card shows', () => {
    for (const bad of ['a\u202eb', 'a\u200bb', 'a\x1b[201~b'])
      expect(() =>
        parseTaskSuggestionRequest({ action: 'suggest', ...input, prompt: bad }),
      ).toThrow('control, bidi or zero-width');
    expect(() =>
      parseTaskSuggestionRequest({ action: 'suggest', ...input, title: 'Fix\u2066 it' }),
    ).toThrow('control, bidi or zero-width');
  });

  it('accepts only suggestion ids for a withdraw', () => {
    expect(
      parseTaskSuggestionRequest({ action: 'withdraw', suggestionId: 'suggestion_ab12cd34' }),
    ).toEqual({ action: 'withdraw', suggestionId: 'suggestion_ab12cd34' });
    expect(() =>
      parseTaskSuggestionRequest({ action: 'withdraw', suggestionId: '__proto__' }),
    ).toThrow('suggestionId');
  });
});

describe('restoreTaskSuggestions', () => {
  it('keeps valid entries and drops malformed ones', () => {
    const valid = suggestion();
    const answered = suggestion({
      id: 'suggestion_00000001',
      status: 'started',
      answeredAt: 2,
      startedTaskId: 'task-9',
      tldr: '',
      prompt: '',
    });
    expect(
      restoreTaskSuggestions([
        valid,
        answered,
        { ...valid, id: 'bad' },
        { ...valid, status: 'odd' },
        { ...valid, prompt: '' },
        null,
      ]),
    ).toEqual([valid, answered]);
    expect(restoreTaskSuggestions([{ ...answered, title: '' }])).toBeUndefined();
    expect(restoreTaskSuggestions('nope')).toBeUndefined();
  });
});

describe('pruneTaskSuggestions', () => {
  it('keeps every pending suggestion and only the newest answered ones', () => {
    const answered = Array.from({ length: TASK_SUGGESTION_LIMITS.answered + 3 }, (_, i) =>
      suggestion({
        id: `suggestion_${String(i).padStart(8, '0')}`,
        status: 'dismissed',
        answeredAt: i,
      }),
    );
    const pending = suggestion({ id: 'suggestion_pending0' });
    const kept = pruneTaskSuggestions([pending, ...answered]);
    expect(kept).toHaveLength(TASK_SUGGESTION_LIMITS.answered + 1);
    expect(kept[0]).toBe(pending);
    expect(kept.map((s) => s.answeredAt)).not.toContain(0);
    expect(kept[1]).toMatchObject({ status: 'dismissed', tldr: '', prompt: '' });
    expect(kept[0].prompt).toBe(input.prompt);
  });
});
