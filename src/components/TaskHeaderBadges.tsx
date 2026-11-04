import { Show } from 'solid-js';
import {
  store,
  getTaskDotStatus,
  getTaskAttentionState,
  clearTaskLandingReview,
  getVerifyCommand,
} from '../store/store';
import { theme } from '../lib/theme';
import { badgeStyle, neutralBadgeStyle, rowChipBox } from '../lib/badgeStyle';
import { taskCheckSignal, type CheckSignal } from '../lib/task-check-signal';
import { getTaskDockerBadgeLabel } from '../lib/docker';
import type { Task } from '../store/types';
import {
  getTaskSnoozedUntil,
  isTaskBackgrounded,
  isTaskSnoozedUntilCi,
} from '../store/background-tasks';

const tinted = (color: string) => ({ ...badgeStyle(color), ...rowChipBox });
const neutral = { ...neutralBadgeStyle, ...rowChipBox };
// Only a failure earns the tint; warnings stay plain status text.
const signalStyle = (signal: CheckSignal) =>
  signal.urgent ? tinted(signal.color) : { color: signal.color };

function landingBadge(task: Task) {
  switch (task.landingState) {
    case 'landed_pending_review':
      return { label: 'Merged', color: undefined, title: 'Merged — pending review' };
    case 'landed_cleanup_failed':
      return {
        label: 'Cleanup failed',
        color: theme.warning,
        title: task.landingReason ?? 'Merged, but cleanup failed',
      };
    case 'landing_escalated':
      return {
        label: 'Merge blocked',
        color: theme.warning,
        title: task.landingReason ?? 'Merge needs attention',
      };
    case 'landing_failed':
      return {
        label: 'Merge failed',
        color: theme.error,
        title: task.landingReason ?? 'Merge failed',
      };
    case 'reviewed':
      return { label: 'Reviewed', color: undefined, title: 'Merge reviewed' };
    default:
      return null;
  }
}

/**
 * Items that need attention: open check flags, review, failed landings. They
 * lead the branch row so a narrow column cuts them last.
 */
export function TaskAttentionBadges(props: {
  task: Task;
  /** Opens Finish, where flags are accepted and checks rerun; absent when the task cannot finish. */
  onFinish?: () => void;
}) {
  // Hidden while the agent works: the result is about to change anyway. A busy
  // shell (dev server, watcher) is not agent work and must not hide a failure.
  const checkSignal = () => {
    const attention = getTaskAttentionState(props.task.id);
    if (attention === 'active' || (!attention && getTaskDotStatus(props.task.id) === 'busy'))
      return undefined;
    const git = store.taskGitStatus[props.task.id];
    return taskCheckSignal({
      verificationRun: props.task.verificationRun,
      verification: props.task.verification,
      verifyCommandConfigured: Boolean(getVerifyCommand(props.task.id)),
      headSha: git?.head_sha,
      lastVerifyPass: props.task.lastVerifyPass,
    });
  };
  const tintedLanding = () => {
    const badge = landingBadge(props.task);
    return badge?.color ? { ...badge, color: badge.color } : null;
  };

  return (
    <span class="task-header-badges">
      <Show when={checkSignal()}>
        {(signal) => (
          <Show
            when={props.onFinish}
            fallback={
              <span style={signalStyle(signal())} title={signal().title}>
                {signal().label}
              </span>
            }
          >
            {(finish) => (
              <button
                type="button"
                class="task-check-signal"
                style={signalStyle(signal())}
                title={`${signal().title}\n\nOpen Finish to review.`}
                onClick={(e) => {
                  e.stopPropagation();
                  finish()();
                }}
              >
                {signal().label}
              </button>
            )}
          </Show>
        )}
      </Show>
      <Show when={props.task.needsReview}>
        <span style={tinted(theme.warning)} title={props.task.landingReason ?? 'Review this task'}>
          Review
        </span>
      </Show>
      <Show when={tintedLanding()}>
        {(badge) => (
          <span style={tinted(badge().color)} title={badge().title}>
            {badge().label}
          </span>
        )}
      </Show>
    </span>
  );
}

/** Routine facts about the task. They close the branch row and are the first to be cut. */
export function TaskRoutineBadges(props: { task: Task }) {
  const snoozedUntil = () => getTaskSnoozedUntil(props.task.id);
  const neutralLanding = () => {
    const badge = landingBadge(props.task);
    return badge && !badge.color ? badge : null;
  };

  return (
    <span class="task-header-badges task-header-badges--routine">
      <Show when={props.task.gitIsolation === 'none'}>
        <span style={neutral}>no git</span>
      </Show>
      <Show when={props.task.dockerMode}>
        <span style={neutral} title={props.task.dockerImage}>
          {getTaskDockerBadgeLabel(props.task.dockerSource)}
        </span>
      </Show>
      <Show when={props.task.externalWorktree}>
        <span style={neutral}>Imported</span>
      </Show>
      <Show when={isTaskBackgrounded(props.task.id)}>
        <span style={neutral}>
          {isTaskSnoozedUntilCi(props.task.id)
            ? 'Snoozed until CI finishes'
            : snoozedUntil() === undefined
              ? 'Snoozed until new activity'
              : `Snoozed until ${new Date(snoozedUntil() ?? 0).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`}
        </span>
      </Show>
      <Show when={neutralLanding()}>
        {(badge) => (
          // Only a merge awaiting review has an action; a reviewed one is plain status.
          <Show
            when={props.task.landingState === 'landed_pending_review'}
            fallback={
              <span style={neutral} title={badge().title}>
                {badge().label}
              </span>
            }
          >
            <button
              type="button"
              class="task-badge-action"
              style={neutral}
              title={`${badge().title}. Click to mark reviewed.`}
              onClick={(e) => {
                e.stopPropagation();
                clearTaskLandingReview(props.task.id);
              }}
            >
              {badge().label}
            </button>
          </Show>
        )}
      </Show>
    </span>
  );
}
