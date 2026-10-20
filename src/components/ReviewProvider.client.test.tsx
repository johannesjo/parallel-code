import { Show, createEffect, createSignal, onCleanup, type Setter } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRequestGenerationGuard,
  type RequestGenerationGuard,
} from '../lib/diff-review-lifecycle';
import { sendPrompt } from '../store/tasks';
import type {
  QualityFinding,
  QualityFindingLoadContext,
  QualityFindingProvider,
} from '../lib/quality-findings';
import type { FileDiff } from '../lib/unified-diff-parser';
import { ReviewProvider, useReview, type ReviewContextValue } from './ReviewProvider';

vi.mock('../store/tasks', () => ({
  sendPrompt: vi.fn(),
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  vi.mocked(sendPrompt).mockReset();
});

function finding(id: string): QualityFinding {
  return {
    id,
    source: 'fixture',
    ruleId: 'no-floating-promises',
    category: 'reliability',
    severity: 'warning',
    location: { filePath: 'src/app.ts', startLine: 10 },
    explanation: 'Await this promise.',
    state: 'open',
    freshness: 'current',
  };
}

function renderedDiff(content = 'runAsync();'): FileDiff[] {
  return [
    {
      path: 'src/app.ts',
      status: 'M',
      binary: false,
      hunks: [
        {
          oldStart: 9,
          oldCount: 2,
          newStart: 9,
          newCount: 3,
          lines: [
            { type: 'context', content: 'before', oldLine: 9, newLine: 9 },
            { type: 'add', content, oldLine: null, newLine: 10 },
            { type: 'context', content: 'after', oldLine: 10, newLine: 11 },
          ],
        },
      ],
    },
  ];
}

interface MountedReview {
  review: ReviewContextValue;
  setOpen: Setter<boolean>;
  setReviewIdentity: Setter<string>;
}

function mountReview(
  findingProvider?: QualityFindingProvider,
  onSubmitted?: () => void,
): MountedReview {
  const [open, setOpen] = createSignal(true);
  const [reviewIdentity, setReviewIdentity] = createSignal('task-a:/worktree-a');
  let review: ReviewContextValue | undefined;

  function CaptureReview() {
    review = useReview();
    return null;
  }

  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(
    render(
      () => (
        <ReviewProvider
          taskId="task-a"
          agentId="agent-a"
          findingProvider={findingProvider}
          reviewIdentity={reviewIdentity()}
          open={open()}
          compilePrompt={() => ''}
          onSubmitted={onSubmitted}
        >
          <CaptureReview />
        </ReviewProvider>
      ),
      host,
    ),
  );

  if (!review) throw new Error('Review context was not rendered');
  return { review, setOpen, setReviewIdentity };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ReviewProvider client lifecycle', () => {
  it('keeps durable comments on same-diff reopen and clears transient interaction state', async () => {
    const loadFindings = vi.fn(async () => [finding('finding-1')]);
    const { review, setOpen } = mountReview({ loadFindings });
    review.completeDiffLoad('diff-a', renderedDiff());
    await flushAsyncWork();
    review.dismissFinding('finding-1');
    review.addAnnotation({
      id: 'annotation-1',
      filePath: 'src/app.ts',
      startLine: 10,
      endLine: 10,
      selectedText: 'runAsync();',
      comment: 'Handle this promise.',
    });
    review.handleSelection({
      source: 'src/app.ts',
      startLine: 10,
      endLine: 10,
      selectedText: 'runAsync();',
    });
    review.handleSubmit('Why is this not awaited?', 'ask');
    review.handleSelection({
      source: 'src/app.ts',
      startLine: 11,
      endLine: 11,
      selectedText: 'after',
    });
    review.setScrollTarget({ filePath: 'src/app.ts', startLine: 10 });

    setOpen(false);
    await flushAsyncWork();

    expect(review.annotations()).toHaveLength(1);
    expect(review.findings()).toMatchObject([{ id: 'finding-1', state: 'dismissed' }]);
    expect(review.pendingSelection()).toBeNull();
    expect(review.activeQuestions()).toEqual([]);
    expect(review.scrollTarget()).toBeNull();
    expect(review.sidebarOpen()).toBe(false);

    setOpen(true);
    await flushAsyncWork();
    review.beginDiffLoad();
    review.completeDiffLoad('diff-a', renderedDiff());

    expect(review.annotations()).toHaveLength(1);
    expect(review.findings()).toMatchObject([
      { id: 'finding-1', state: 'dismissed', freshness: 'current' },
    ]);
    expect(loadFindings).toHaveBeenCalledOnce();
  });

  it('clears durable and transient state when the worktree identity changes', async () => {
    const { review, setReviewIdentity } = mountReview();
    review.completeDiffLoad('diff-a', renderedDiff());
    review.addAnnotation({
      id: 'annotation-1',
      filePath: 'src/app.ts',
      startLine: 10,
      endLine: 10,
      selectedText: 'runAsync();',
      comment: 'Handle this promise.',
    });
    review.handleSelection({
      source: 'src/app.ts',
      startLine: 10,
      endLine: 10,
      selectedText: 'runAsync();',
    });

    setReviewIdentity('task-b:/worktree-b');
    await flushAsyncWork();

    expect(review.annotations()).toEqual([]);
    expect(review.pendingSelection()).toBeNull();
    expect(review.findings()).toEqual([]);
  });

  it('evicts an expanded-context annotation after its diff location disappears', () => {
    const { review } = mountReview();
    review.completeDiffLoad('diff-a', renderedDiff());
    review.addAnnotation({
      id: 'expanded-context-annotation',
      filePath: 'src/app.ts',
      startLine: 50,
      endLine: 50,
      selectedText: 'expandedContext();',
      comment: 'Review the expanded context line.',
    });

    review.beginDiffLoad();
    review.completeDiffLoad('diff-b', []);

    expect(review.annotations()).toEqual([]);
  });

  it('ignores a provider response from a closed session after the same diff reopens', async () => {
    const requests: Array<{
      context: QualityFindingLoadContext;
      resolve: (findings: QualityFinding[]) => void;
    }> = [];
    const provider: QualityFindingProvider = {
      loadFindings: vi.fn(
        (context) =>
          new Promise<QualityFinding[]>((resolve) => {
            requests.push({ context, resolve });
          }),
      ),
    };
    const { review, setOpen } = mountReview(provider);

    review.beginDiffLoad();
    review.completeDiffLoad('diff-a', renderedDiff());
    setOpen(false);
    await flushAsyncWork();
    setOpen(true);
    await flushAsyncWork();
    review.beginDiffLoad();
    review.completeDiffLoad('diff-a', renderedDiff());

    expect(requests.map((request) => request.context.diffIdentity)).toEqual(['diff-a', 'diff-a']);

    requests[0].resolve([finding('late-finding')]);
    await flushAsyncWork();
    expect(review.findings()).toEqual([]);

    requests[1].resolve([finding('current-finding')]);
    await flushAsyncWork();
    expect(review.findings()).toMatchObject([
      { id: 'current-finding', freshness: 'current', state: 'open' },
    ]);
  });

  it('ignores a completed submission after navigation moves to another diff', async () => {
    let resolveSend: (() => void) | undefined;
    vi.mocked(sendPrompt).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const onSubmitted = vi.fn();
    const { review } = mountReview(undefined, onSubmitted);
    review.beginDiffLoad();
    review.completeDiffLoad('diff-a', renderedDiff('runA();'));
    review.addAnnotation({
      id: 'annotation-a',
      filePath: 'src/app.ts',
      startLine: 10,
      endLine: 10,
      selectedText: 'runA();',
      comment: 'Review diff A.',
    });

    const submission = review.submitReview();
    review.beginDiffLoad();
    review.completeDiffLoad('diff-b', renderedDiff('runB();'));
    review.addAnnotation({
      id: 'annotation-b',
      filePath: 'src/app.ts',
      startLine: 10,
      endLine: 10,
      selectedText: 'runB();',
      comment: 'Review diff B.',
    });
    resolveSend?.();
    await submission;

    expect(review.annotations().map((annotation) => annotation.id)).toEqual(['annotation-b']);
    expect(review.submitError()).toBe('');
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('ignores a rejected submission after navigation moves to another diff', async () => {
    let rejectSend: ((error: Error) => void) | undefined;
    vi.mocked(sendPrompt).mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        }),
    );
    const { review } = mountReview();
    review.beginDiffLoad();
    review.completeDiffLoad('diff-a', renderedDiff('runA();'));
    review.addAnnotation({
      id: 'annotation-a',
      filePath: 'src/app.ts',
      startLine: 10,
      endLine: 10,
      selectedText: 'runA();',
      comment: 'Review diff A.',
    });

    const submission = review.submitReview();
    review.beginDiffLoad();
    review.completeDiffLoad('diff-b', renderedDiff('runB();'));
    rejectSend?.(new Error('diff A terminal failure'));
    await submission;

    expect(review.submitError()).toBe('');
  });
});

interface PendingRequest {
  promise: Promise<string>;
  resolve: (value: string) => void;
}

function pendingRequest(): PendingRequest {
  let resolve: ((value: string) => void) | undefined;
  const promise = new Promise<string>((complete) => {
    resolve = complete;
  });
  if (!resolve) throw new Error('Request resolver was not initialized');
  return { promise, resolve };
}

function RequestOwner(props: {
  request: PendingRequest;
  guard: RequestGenerationGuard;
  onApply: (value: string) => void;
}) {
  createEffect(() => {
    const guard = props.guard;
    const onApply = props.onApply;
    const request = props.request;
    const generation = guard.begin();
    onCleanup(() => guard.invalidate());
    void request.promise.then((value) => {
      if (guard.isCurrent(generation)) onApply(value);
    });
  });
  return null;
}

describe('diff request client lifecycle', () => {
  it('rejects an old request after close and reopen even when it resolves last', async () => {
    const first = pendingRequest();
    const second = pendingRequest();
    const applied: string[] = [];
    const [open, setOpen] = createSignal(true);
    const [request, setRequest] = createSignal(first);
    const guard = createRequestGenerationGuard();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => (
          <Show when={open()}>
            <RequestOwner
              request={request()}
              guard={guard}
              onApply={(value) => applied.push(value)}
            />
          </Show>
        ),
        host,
      ),
    );

    setOpen(false);
    setRequest(second);
    setOpen(true);
    second.resolve('new');
    await flushAsyncWork();
    first.resolve('old');
    await flushAsyncWork();

    expect(applied).toEqual(['new']);
  });
});
