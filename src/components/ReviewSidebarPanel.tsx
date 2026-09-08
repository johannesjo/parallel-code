import { Show } from 'solid-js';
import { useReview, type ReviewContextValue } from './ReviewProvider';
import { ReviewSidebar } from './ReviewSidebar';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { CloseIcon } from './icons';

interface ReviewSidebarState {
  reviewCount: number;
  findingsLoading: boolean;
  findingsError: string;
  submitError: string;
}

function hasReviewSidebarState(state: ReviewSidebarState): boolean {
  return (
    state.reviewCount > 0 ||
    state.findingsLoading ||
    Boolean(state.findingsError) ||
    Boolean(state.submitError)
  );
}

function currentReviewSidebarState(review: ReviewContextValue): ReviewSidebarState {
  return {
    reviewCount: review.annotations().length + review.openFindings().length,
    findingsLoading: review.findingsLoading(),
    findingsError: review.findingsError(),
    submitError: review.submitError(),
  };
}

/** Toggle button that shows annotation count and opens/closes the review sidebar. */
export function ReviewCommentsButton() {
  const review = useReview();
  const state = () => currentReviewSidebarState(review);

  return (
    <Show when={hasReviewSidebarState(state())}>
      <button
        onClick={() => review.setSidebarOpen(!review.sidebarOpen())}
        style={{
          background: review.sidebarOpen() ? theme.warning : 'transparent',
          color: review.sidebarOpen() ? theme.accentText : theme.warning,
          border: `1px solid ${theme.warning}`,
          'font-size': sf(12),
          padding: '2px 10px',
          'border-radius': 'var(--radius-xs)',
          cursor: 'pointer',
        }}
      >
        Review ({state().reviewCount})
      </button>
    </Show>
  );
}

/** Explicitly rerun the configured quality-finding provider for the current diff. */
export function ReviewFindingsRefreshButton() {
  const review = useReview();
  return (
    <button
      type="button"
      onClick={review.refreshFindings}
      disabled={review.findingsLoading()}
      title="Rerun quality findings for this diff"
      aria-label="Refresh quality findings"
      style={{
        background: 'transparent',
        color: theme.fgMuted,
        border: `1px solid ${theme.border}`,
        'font-size': sf(12),
        padding: '2px 10px',
        'border-radius': 'var(--radius-xs)',
        cursor: review.findingsLoading() ? 'wait' : 'pointer',
        opacity: review.findingsLoading() ? '0.6' : '1',
      }}
    >
      Refresh findings
    </button>
  );
}

/** Sidebar column with human comments and provider findings. */
export function ReviewSidebarPanel() {
  const review = useReview();
  const state = () => currentReviewSidebarState(review);

  return (
    <Show when={review.sidebarOpen() && hasReviewSidebarState(state())}>
      <div style={{ display: 'flex', 'flex-direction': 'column' }}>
        <Show when={review.submitError()}>
          <div
            style={{
              padding: '6px 12px',
              color: theme.error,
              'font-size': sf(12),
              'border-bottom': `1px solid ${theme.border}`,
              background: 'rgba(255, 95, 115, 0.08)',
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
            }}
          >
            <span style={{ flex: '1' }}>{review.submitError()}</span>
            <button
              type="button"
              onClick={review.clearSubmitError}
              title="Dismiss submission error"
              aria-label="Dismiss submission error"
              style={{
                display: 'flex',
                background: 'transparent',
                border: 'none',
                color: theme.fgMuted,
                cursor: 'pointer',
                padding: '2px',
                'border-radius': 'var(--radius-xs)',
              }}
            >
              <CloseIcon size={13} />
            </button>
          </div>
        </Show>
        <Show when={review.findingsLoading()}>
          <div
            style={{
              padding: '6px 12px',
              color: theme.fgMuted,
              'font-size': sf(12),
              'border-bottom': `1px solid ${theme.border}`,
            }}
          >
            Loading quality findings...
          </div>
        </Show>
        <Show when={review.findingsError()}>
          <div
            style={{
              padding: '6px 12px',
              color: theme.warning,
              'font-size': sf(12),
              'border-bottom': `1px solid ${theme.border}`,
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
            }}
          >
            <span style={{ flex: '1' }}>
              Quality findings unavailable: {review.findingsError()}
            </span>
            <button
              type="button"
              onClick={review.clearFindingsError}
              title="Dismiss quality findings error"
              aria-label="Dismiss quality findings error"
              style={{
                display: 'flex',
                background: 'transparent',
                border: 'none',
                color: theme.fgMuted,
                cursor: 'pointer',
                padding: '2px',
                'border-radius': 'var(--radius-xs)',
              }}
            >
              <CloseIcon size={13} />
            </button>
          </div>
        </Show>
        <ReviewSidebar
          annotations={review.annotations()}
          findings={review.openFindings()}
          selectedFindingIds={review.selectedFindingIds()}
          canSubmit={review.canSubmit()}
          submitting={review.submitting()}
          onDismiss={review.dismissAnnotation}
          onUpdate={review.updateAnnotation}
          onScrollTo={review.setScrollTarget}
          onSubmit={review.submitReview}
          onFindingSelected={review.setFindingSelected}
          onFindingDismiss={review.dismissFinding}
          onFindingScrollTo={(finding) =>
            review.setScrollTarget({
              id: finding.id,
              filePath: finding.location.filePath,
              startLine: finding.location.startLine,
              endLine: finding.location.endLine,
            })
          }
        />
      </div>
    </Show>
  );
}
