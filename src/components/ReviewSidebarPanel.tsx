import { Show } from 'solid-js';
import { useReview } from './ReviewProvider';
import { ReviewSidebar } from './ReviewSidebar';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';

/** Toggle button that shows annotation count and opens/closes the review sidebar. */
export function ReviewCommentsButton() {
  const review = useReview();

  return (
    <Show when={review.annotations().length > 0}>
      <button
        onClick={() => review.setSidebarOpen(!review.sidebarOpen())}
        style={{
          background: review.sidebarOpen() ? theme.warning : 'transparent',
          color: review.sidebarOpen() ? theme.accentText : theme.warning,
          border: `1px solid ${theme.warning}`,
          'font-size': sf(11),
          padding: '2px 10px',
          'border-radius': '4px',
          cursor: 'pointer',
        }}
      >
        Comments ({review.annotations().length})
      </button>
    </Show>
  );
}

/** Sidebar column with error banner and annotation list. Renders nothing when closed or empty. */
export function ReviewSidebarPanel() {
  const review = useReview();

  return (
    <Show when={review.sidebarOpen() && review.annotations().length > 0}>
      <div style={{ display: 'flex', 'flex-direction': 'column' }}>
        <Show when={review.submitError()}>
          <div
            style={{
              padding: '6px 12px',
              color: theme.error,
              'font-size': sf(11),
              'border-bottom': `1px solid ${theme.border}`,
              background: 'rgba(255, 95, 115, 0.08)',
            }}
          >
            {review.submitError()}
          </div>
        </Show>
        <ReviewSidebar
          annotations={review.annotations()}
          canSubmit={review.canSubmit()}
          onDismiss={review.dismissAnnotation}
          onUpdate={review.updateAnnotation}
          onScrollTo={review.setScrollTarget}
          onSubmit={review.submitReview}
        />
      </div>
    </Show>
  );
}
