import { Show, createEffect, createSignal, on } from 'solid-js';
import type { ChangeTourController } from '../lib/create-change-tour';
import type { Task } from '../store/types';
import type { ChangedFile } from '../ipc/types';
import { ChangeTourButton } from './ChangeTourButton';
import { ConfirmDialog } from './ConfirmDialog';
import { DiffViewerDialog } from './DiffViewerDialog';
import { EvidencePanel } from './EvidencePanel';
import { MergeReadinessPanel } from './MergeReadinessPanel';
import { MergeBlockers, MergeChanges, MergeOptions } from './MergeSection';
import { PushSection } from './PushSection';
import { createMergeState } from './merge-state';
import { createPushRun } from './push-run';
import { getProject } from '../store/store';
import { theme } from '../lib/theme';

export type FinishAction = 'merge' | 'push';

interface FinishDialogProps {
  open: boolean;
  task: Task;
  initialCleanup: boolean;
  tour: ChangeTourController;
  tourDisabled: boolean;
  /** Opens a ready tour, or starts generating one, like the Changed Files button. */
  onTourClick: () => void;
  onRegenerateTour: () => void;
  /** Child tasks under review merge through the delegation review instead. */
  onDelegationReview: () => void;
  onPushStart: () => void;
  onPushDone: (success: boolean) => void;
  onDiffFileClick: (file: ChangedFile) => void;
  /** Opens the project settings at the verify command and evidence checks. */
  onConfigureChecks: () => void;
  /** Closing never stops a running push; it finishes in the background. */
  onClose: () => void;
}

const pushButtonStyle = {
  padding: '9px 18px',
  background: theme.bgInput,
  border: `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-md)',
  color: theme.fg,
  'font-size': '14px',
};

const SHOWN_ELSEWHERE = new Set(['Merge safety', 'Verify command', 'Evidence']);

/**
 * One place to wrap up a task. Reads top to bottom: what blocks the merge,
 * what changed, whether the checks back it, then how to merge. Merge and push
 * are both footer actions, since pushing does not exclude merging later.
 */
export function FinishDialog(props: FinishDialogProps) {
  const merge = createMergeState(props);
  const [reviewLocation, setReviewLocation] = createSignal<{
    file: string;
    line?: number;
    side?: 'old' | 'new';
  }>();
  createEffect(() => {
    if (!props.open) setReviewLocation(undefined);
  });
  const push = createPushRun({
    get task() {
      return props.task;
    },
    onStart: () => props.onPushStart(),
    onDone: (success) => props.onPushDone(success),
  });
  const viaReview = () => props.task.integrationPolicy === 'review';

  // Tracks only `open`: reset reads `pushing`, and re-running when a push ends
  // would wipe the error it just reported.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) push.reset();
      },
    ),
  );

  const confirmLabel = () => {
    if (viaReview()) return 'Review and merge…';
    if (merge.merging()) return 'Merging...';
    // The target lives on the button, so the dialog needs no sentence restating it.
    return `${merge.squash() ? 'Squash merge' : 'Merge'} into ${merge.baseBranchName()}`;
  };
  // Said elsewhere in this dialog: merge safety by the notices on top, the
  // verify command in the check list, evidence by the panel these rows sit in.
  const readinessRows = () =>
    merge.mergeReadiness().checks.filter((check) => !SHOWN_ELSEWHERE.has(check.label));
  const confirmDisabled = () => push.pushing() || (viaReview() ? false : !merge.canMerge());
  const mergeAndClose = async () => {
    if (await merge.merge()) props.onClose();
  };
  const confirm = () => {
    if (viaReview()) return props.onDelegationReview();
    void mergeAndClose();
  };

  return (
    <>
      <ConfirmDialog
        open={props.open}
        title="Finish task"
        width="560px"
        autoFocusCancel
        message={
          <div>
            <Show when={!viaReview()}>
              <MergeBlockers
                task={props.task}
                state={merge}
                open={props.open}
                onDone={() => props.onClose()}
                onDiffFileClick={props.onDiffFileClick}
              />
            </Show>
            <Show when={viaReview()}>
              <p style={{ margin: '0 0 12px', 'font-size': '13px' }}>
                This task merges through its parent's review. The worktree is kept.
              </p>
            </Show>
            <MergeChanges
              task={props.task}
              state={merge}
              open={props.open}
              onDone={() => props.onClose()}
              onDiffFileClick={props.onDiffFileClick}
            >
              <ChangeTourButton
                tour={props.tour}
                onClick={props.onTourClick}
                disabled={props.tourDisabled}
              >
                <Show when={props.tour.stops().length > 0 && !props.tour.loading()}>
                  <button
                    type="button"
                    class="change-tour-action change-tour-segment"
                    onClick={() => props.onRegenerateTour()}
                    title="Discard this tour and generate a new one"
                  >
                    Regenerate
                  </button>
                </Show>
              </ChangeTourButton>
            </MergeChanges>
            {/* Opens with every dialog and folds only on a click, never on a status change. */}
            <details open style={{ margin: '28px 0', 'font-size': '13px' }}>
              <summary style={{ cursor: 'pointer', color: theme.fgMuted }}>
                Readiness and checks
              </summary>
              <div style={{ 'margin-top': '8px' }}>
                <EvidencePanel
                  task={props.task}
                  agentId={merge.selectedAgentId()}
                  headSha={merge.worktreeStatus()?.head_sha}
                  dirty={merge.worktreeStatus()?.has_uncommitted_changes}
                  onConfigure={() => props.onConfigureChecks()}
                  onReviewFile={(file, line, side) => setReviewLocation({ file, line, side })}
                >
                  <MergeReadinessPanel checks={readinessRows()} />
                </EvidencePanel>
              </div>
            </details>
            <Show when={!viaReview()}>
              <MergeOptions task={props.task} state={merge} />
            </Show>
            <Show when={push.pushing() || push.output() || push.error()}>
              <div style={{ 'margin-top': '12px' }}>
                <PushSection run={push} />
              </div>
            </Show>
          </div>
        }
        extraActions={
          <button
            type="button"
            class="btn-secondary"
            disabled={push.pushing() || merge.merging()}
            onClick={() => void push.start()}
            title={`Push ${props.task.branchName} to origin; the task stays open`}
            style={{
              ...pushButtonStyle,
              cursor: push.pushing() || merge.merging() ? 'not-allowed' : 'pointer',
              opacity: merge.merging() ? '0.5' : '1',
            }}
          >
            {push.pushing() ? 'Pushing…' : 'Push branch'}
          </button>
        }
        confirmDisabled={confirmDisabled()}
        footerNote={viaReview() || merge.merging() ? undefined : merge.mergeBlocker()}
        confirmLoading={merge.merging()}
        confirmLabel={confirmLabel()}
        cancelLabel={push.pushing() ? 'Close' : 'Cancel'}
        onConfirm={confirm}
        onCancel={() => props.onClose()}
      />
      {/* Keep the review provider alive so returning to evidence preserves draft comments. */}
      <DiffViewerDialog
        scrollToFile={props.open ? (reviewLocation()?.file ?? null) : null}
        scrollToLine={reviewLocation()?.line}
        scrollToSide={reviewLocation()?.side}
        closeLabel="Back to evidence"
        taskName={props.task.name}
        worktreePath={props.task.worktreePath}
        baseBranch={props.task.baseBranch}
        branchName={props.task.branchName}
        projectRoot={getProject(props.task.projectId)?.path}
        coverageReportPath={getProject(props.task.projectId)?.coverageReportPath}
        taskId={props.task.id}
        agentId={merge.selectedAgentId()}
        gitIsolation={props.task.gitIsolation}
        onClose={() => setReviewLocation(undefined)}
      />
    </>
  );
}
