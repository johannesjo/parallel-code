import { Match, Show, Switch, type JSX } from 'solid-js';
import { theme } from '../lib/theme';
import { isMac } from '../lib/platform';
import { parseGitHubUrl } from '../lib/github-url';
import type { PrChecksState } from '../store/pr-checks-state';
import { AlertIcon, CheckIcon, GitMergeIcon, PencilIcon, PersonIcon } from './icons';

type ReviewStatusKind = 'approved' | 'changes-requested' | 'review-needed' | 'draft' | 'merged';

/** GitHub's own "merged" purple, so the state reads the same as on github.com. */
const GITHUB_MERGED_COLOR = '#8957e5';

/** Solid pill like GitHub's merged label: a finished PR is the one state worth a full badge. */
const mergedBadgeStyle: JSX.CSSProperties = {
  'font-size': '11px',
  'font-weight': '600',
  padding: '1px 6px',
  gap: '4px',
  'border-radius': 'var(--radius-xs)',
  background: GITHUB_MERGED_COLOR,
  // Fixed white, not a theme token: the fill is theme-independent too.
  color: '#fff',
  'white-space': 'nowrap',
};

interface ReviewStatus {
  kind: ReviewStatusKind;
  label: string;
  accessibleLabel: string;
  title: string;
  color: string;
}

function ReviewStatusIcon(props: { kind: ReviewStatusKind }) {
  return (
    <Switch>
      <Match when={props.kind === 'approved'}>
        <CheckIcon size={12} />
      </Match>
      <Match when={props.kind === 'changes-requested'}>
        <AlertIcon size={12} />
      </Match>
      <Match when={props.kind === 'review-needed'}>
        <PersonIcon size={12} />
      </Match>
      <Match when={props.kind === 'draft'}>
        <PencilIcon size={12} />
      </Match>
      <Match when={props.kind === 'merged'}>
        <GitMergeIcon size={12} />
      </Match>
    </Switch>
  );
}

function reviewStatusOf(c: PrChecksState | undefined): ReviewStatus | null {
  if (!c) return null;
  if (c.merged) {
    return {
      kind: 'merged',
      label: 'Merged',
      accessibleLabel: 'Merged',
      title: 'Pull request merged',
      color: GITHUB_MERGED_COLOR,
    };
  }
  if (c.isDraft) {
    return {
      kind: 'draft',
      label: 'Draft',
      accessibleLabel: 'Draft',
      title: 'Draft pull request',
      color: theme.fgMuted,
    };
  }
  switch (c.reviewDecision) {
    case 'CHANGES_REQUESTED':
      return {
        kind: 'changes-requested',
        label: 'Changes',
        accessibleLabel: 'Changes requested',
        title: 'Review: changes requested',
        color: theme.warning,
      };
    case 'APPROVED':
      return {
        kind: 'approved',
        label: 'Approved',
        accessibleLabel: 'Approved',
        title: 'Review: approved',
        color: theme.success,
      };
    case 'REVIEW_REQUIRED':
      return {
        kind: 'review-needed',
        label: 'Review',
        accessibleLabel: 'Review needed',
        title: 'Review required',
        color: theme.accent,
      };
    default:
      return null;
  }
}

function ciStatusOf(
  c: PrChecksState | undefined,
): { label: string; title: string; color: string } | null {
  if (!c || c.overall === 'none') return null;
  if (c.overall === 'pending') {
    return {
      label: 'CI running',
      title: `CI running — ${c.pending} pending, ${c.passing} passing${c.failing ? `, ${c.failing} failing` : ''}`,
      color: theme.warning,
    };
  }
  if (c.overall === 'success') {
    return {
      label: 'CI passed',
      title: `CI passed — ${c.passing} check${c.passing === 1 ? '' : 's'}`,
      color: theme.success,
    };
  }
  return {
    label: 'CI failed',
    title: `CI failed — ${c.failing} failing, ${c.passing} passing${c.pending ? `, ${c.pending} pending` : ''}`,
    color: theme.error,
  };
}

interface PrChipProps {
  url: string;
  /** Nested repository folder the PR belongs to; shown before the number. */
  repo?: string;
  checks: PrChecksState | undefined;
  style: JSX.CSSProperties;
  /** Opens the in-app PR panel; without it the chip opens GitHub. */
  onOpenPullRequest?: (prUrl: string) => void;
}

/** A pull request's number with its CI, review and conflict state. */
export function PrChip(props: PrChipProps) {
  const mod = isMac ? 'Cmd' : 'Ctrl';
  const prNumber = () => parseGitHubUrl(props.url)?.number;
  const reviewStatus = () => reviewStatusOf(props.checks);
  const ciStatus = () => ciStatusOf(props.checks);
  const hasConflicts = () => props.checks?.mergeable === 'CONFLICTING';
  const buttonTitle = () =>
    [
      reviewStatus()?.title,
      ciStatus()?.title,
      hasConflicts() ? 'Merge conflicts with the base branch' : null,
      props.url,
      props.onOpenPullRequest ? `${mod}+Click to open on GitHub` : null,
    ]
      .filter(Boolean)
      .join('\n');
  const buttonLabel = () =>
    [
      ['PR', props.repo, `#${prNumber()}`].filter(Boolean).join(' '),
      reviewStatus()?.accessibleLabel,
      ciStatus()?.label,
      hasConflicts() ? 'Conflicts' : null,
    ]
      .filter(Boolean)
      .join(', ');
  const openPr = (e: MouseEvent) => {
    if (props.onOpenPullRequest && !(e.metaKey || e.ctrlKey)) {
      props.onOpenPullRequest(props.url);
    } else {
      window.open(props.url, '_blank');
    }
  };
  return (
    <button
      type="button"
      class="task-branch-info-button task-pr-link"
      onClick={openPr}
      title={buttonTitle()}
      aria-label={buttonLabel()}
      style={props.style}
    >
      <Show when={ciStatus()}>
        {(ci) => (
          <span class="task-pr-ci-state">
            <Show
              when={props.checks?.overall === 'pending'}
              fallback={
                <span
                  style={{
                    width: '7px',
                    height: '7px',
                    'border-radius': '50%',
                    background: ci().color,
                  }}
                />
              }
            >
              <span
                class="inline-spinner"
                style={{ width: '10px', height: '10px', color: ci().color }}
              />
            </Show>
          </span>
        )}
      </Show>
      <span class="task-pr-label" style={{ color: theme.fgMuted, 'font-weight': '600' }}>
        <span class="task-pr-prefix">PR </span>
        <Show when={props.repo}>
          <span class="task-pr-repo">{props.repo} </span>
        </Show>
        <span class="task-pr-number">#{prNumber()}</span>
      </span>
      <Show when={reviewStatus()}>
        {(review) => (
          <span
            class="task-pr-review-status"
            style={review().kind === 'merged' ? mergedBadgeStyle : { color: review().color }}
          >
            <span class="task-pr-review-label">{review().label}</span>
            <span class={`task-pr-review-icon task-pr-review-icon--${review().kind}`}>
              <ReviewStatusIcon kind={review().kind} />
            </span>
          </span>
        )}
      </Show>
      <Show when={hasConflicts()}>
        <span class="task-pr-conflicts" style={{ color: theme.error }}>
          Conflicts
        </span>
      </Show>
    </button>
  );
}
