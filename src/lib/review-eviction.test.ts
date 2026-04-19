import { describe, it, expect } from 'vitest';
import { evictStaleAnnotations } from './review-eviction';
import type { FileDiff } from './unified-diff-parser';
import type { ReviewAnnotation } from '../components/review-types';

function makeAnnotation(overrides: Partial<ReviewAnnotation> = {}): ReviewAnnotation {
  return {
    id: 'test-1',
    filePath: 'src/app.ts',
    startLine: 5,
    endLine: 7,
    selectedText: 'const x = 1;\nconst y = 2;\nconst z = 3;',
    comment: 'rename x',
    ...overrides,
  };
}

describe('evictStaleAnnotations', () => {
  it('keeps annotation when file has no changes in annotated range', () => {
    const annotations = [makeAnnotation()];
    const files: FileDiff[] = [
      {
        path: 'src/app.ts',
        status: 'M',
        binary: false,
        hunks: [
          {
            oldStart: 20,
            oldCount: 3,
            newStart: 20,
            newCount: 4,
            lines: [
              { type: 'context', content: 'unchanged', oldLine: 20, newLine: 20 },
              { type: 'add', content: 'new line', oldLine: null, newLine: 21 },
            ],
          },
        ],
      },
    ];
    expect(evictStaleAnnotations(annotations, files)).toEqual(annotations);
  });

  it('evicts annotation when annotated lines are modified', () => {
    const annotations = [makeAnnotation({ startLine: 5, endLine: 7 })];
    const files: FileDiff[] = [
      {
        path: 'src/app.ts',
        status: 'M',
        binary: false,
        hunks: [
          {
            oldStart: 4,
            oldCount: 5,
            newStart: 4,
            newCount: 6,
            lines: [
              { type: 'context', content: 'line 4', oldLine: 4, newLine: 4 },
              { type: 'remove', content: 'old x', oldLine: 5, newLine: null },
              { type: 'add', content: 'new x', oldLine: null, newLine: 5 },
              { type: 'context', content: 'line 6', oldLine: 6, newLine: 6 },
            ],
          },
        ],
      },
    ];
    expect(evictStaleAnnotations(annotations, files)).toEqual([]);
  });

  it('keeps annotation when file is not in diff at all', () => {
    const annotations = [makeAnnotation({ filePath: 'src/other.ts' })];
    const files: FileDiff[] = [];
    expect(evictStaleAnnotations(annotations, files)).toEqual(annotations);
  });

  it('evicts annotation when file is deleted', () => {
    const annotations = [makeAnnotation()];
    const files: FileDiff[] = [{ path: 'src/app.ts', status: 'D', binary: false, hunks: [] }];
    expect(evictStaleAnnotations(annotations, files)).toEqual([]);
  });

  it('keeps multiple annotations when none overlap with changes', () => {
    const annotations = [
      makeAnnotation({ id: '1', startLine: 1, endLine: 3 }),
      makeAnnotation({ id: '2', startLine: 50, endLine: 55 }),
    ];
    const files: FileDiff[] = [
      {
        path: 'src/app.ts',
        status: 'M',
        binary: false,
        hunks: [
          {
            oldStart: 20,
            oldCount: 2,
            newStart: 20,
            newCount: 3,
            lines: [{ type: 'add', content: 'inserted', oldLine: null, newLine: 21 }],
          },
        ],
      },
    ];
    expect(evictStaleAnnotations(annotations, files)).toEqual(annotations);
  });

  it('evicts only the annotation whose lines were touched', () => {
    const annotations = [
      makeAnnotation({ id: '1', startLine: 1, endLine: 3 }),
      makeAnnotation({ id: '2', startLine: 5, endLine: 7 }),
    ];
    const files: FileDiff[] = [
      {
        path: 'src/app.ts',
        status: 'M',
        binary: false,
        hunks: [
          {
            oldStart: 5,
            oldCount: 3,
            newStart: 5,
            newCount: 3,
            lines: [
              { type: 'remove', content: 'old', oldLine: 5, newLine: null },
              { type: 'add', content: 'new', oldLine: null, newLine: 5 },
              { type: 'context', content: 'same', oldLine: 6, newLine: 6 },
            ],
          },
        ],
      },
    ];
    const result = evictStaleAnnotations(annotations, files);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });

  it('evicts annotation when remove lines have divergent old/new line numbers', () => {
    // After inserting 10 lines earlier, old line 5 is now new line 15.
    // A remove at oldLine 5 (newLine null) should still evict an annotation at new lines 10-20
    // because the hunk's newStart/newCount covers that range.
    const annotations = [makeAnnotation({ startLine: 10, endLine: 20 })];
    const files: FileDiff[] = [
      {
        path: 'src/app.ts',
        status: 'M',
        binary: false,
        hunks: [
          {
            oldStart: 5,
            oldCount: 3,
            newStart: 15,
            newCount: 2,
            lines: [
              { type: 'remove', content: 'old line', oldLine: 5, newLine: null },
              { type: 'context', content: 'kept', oldLine: 6, newLine: 15 },
              { type: 'context', content: 'kept2', oldLine: 7, newLine: 16 },
            ],
          },
        ],
      },
    ];
    expect(evictStaleAnnotations(annotations, files)).toEqual([]);
  });
});
