import { describe, expect, it } from 'vitest';
import type { ReviewAnnotation } from '../components/review-types';
import {
  createDiffIdentity,
  createRequestGenerationGuard,
  transitionReviewAnnotations,
  type ReviewDiffSnapshot,
} from './diff-review-lifecycle';
import type { FileDiff } from './unified-diff-parser';

function annotation(): ReviewAnnotation {
  return {
    id: 'annotation-1',
    filePath: 'src/app.ts',
    startLine: 10,
    endLine: 10,
    selectedText: 'before();',
    comment: 'Keep this behavior.',
  };
}

function renderedDiff(content = 'before();'): FileDiff[] {
  return [
    {
      path: 'src/app.ts',
      status: 'M',
      binary: false,
      hunks: [
        {
          oldStart: 10,
          oldCount: 1,
          newStart: 10,
          newCount: 1,
          lines: [
            { type: 'remove', content: 'base();', oldLine: 10, newLine: null },
            { type: 'add', content, oldLine: null, newLine: 10 },
          ],
        },
      ],
    },
  ];
}

function unrelatedDiff(): FileDiff {
  return {
    path: 'src/other.ts',
    status: 'M',
    binary: false,
    hunks: [
      {
        oldStart: 2,
        oldCount: 1,
        newStart: 2,
        newCount: 1,
        lines: [
          { type: 'remove', content: 'old();', oldLine: 2, newLine: null },
          { type: 'add', content: 'newer();', oldLine: null, newLine: 2 },
        ],
      },
    ],
  };
}

function snapshot(
  diffIdentity: string,
  files: FileDiff[],
  reviewIdentity = 'task-a',
): ReviewDiffSnapshot {
  return { reviewIdentity, diffIdentity, files };
}

describe('diff review lifecycle', () => {
  it('keeps durable comments when the exact same diff is reopened', () => {
    const annotations = [annotation()];
    const identity = snapshot('diff-a', renderedDiff());

    expect(transitionReviewAnnotations(annotations, identity, identity)).toBe(annotations);
  });

  it('keeps an annotation when a cumulative diff changes only an unrelated file', () => {
    const annotations = [annotation()];
    const previous = snapshot('diff-a', renderedDiff());
    const next = snapshot('diff-b', [...renderedDiff(), unrelatedDiff()]);

    expect(transitionReviewAnnotations(annotations, previous, next)).toBe(annotations);
  });

  it('evicts an annotation when its anchored content changes', () => {
    expect(
      transitionReviewAnnotations(
        [annotation()],
        snapshot('diff-a', renderedDiff()),
        snapshot('diff-b', renderedDiff('after();')),
      ),
    ).toEqual([]);
  });

  it('evicts an annotation when its anchored range disappears from the diff', () => {
    expect(
      transitionReviewAnnotations(
        [annotation()],
        snapshot('diff-a', renderedDiff()),
        snapshot('diff-b', [unrelatedDiff()]),
      ),
    ).toEqual([]);
  });

  it('evicts an expanded-context annotation when its previous anchor cannot be reconstructed', () => {
    const expandedContextAnnotation = {
      ...annotation(),
      startLine: 50,
      endLine: 50,
      selectedText: 'expandedContext();',
    };

    expect(
      transitionReviewAnnotations(
        [expandedContextAnnotation],
        snapshot('diff-a', renderedDiff()),
        snapshot('diff-b', []),
      ),
    ).toEqual([]);
  });

  it('never carries durable comments into another worktree review', () => {
    expect(
      transitionReviewAnnotations(
        [annotation()],
        snapshot('same-diff', renderedDiff(), 'worktree-a'),
        snapshot('same-diff', renderedDiff(), 'worktree-b'),
      ),
    ).toEqual([]);
  });

  it('invalidates a closed viewer request before a reopened request starts', () => {
    const guard = createRequestGenerationGuard();
    const closedRequest = guard.begin();
    guard.invalidate();
    const reopenedRequest = guard.begin();

    expect(guard.isCurrent(closedRequest)).toBe(false);
    expect(guard.isCurrent(reopenedRequest)).toBe(true);
  });

  it('derives stable identities from the exact review scope and diff content', async () => {
    const first = await createDiffIdentity('task-a', 'diff content');
    const same = await createDiffIdentity('task-a', 'diff content');
    const changedContent = await createDiffIdentity('task-a', 'different content');
    const changedScope = await createDiffIdentity('task-b', 'diff content');

    expect(same).toBe(first);
    expect(changedContent).not.toBe(first);
    expect(changedScope).not.toBe(first);
  });
});
