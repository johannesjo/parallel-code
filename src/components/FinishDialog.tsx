import { Show, createEffect, createSignal, on } from 'solid-js';
import type { ChangeTourController } from '../lib/create-change-tour';
import type { Task } from '../store/types';
import type { ChangedFile } from '../ipc/types';
import { ChangeTourButton } from './ChangeTourButton';
import { CompletionReport } from './CompletionReport';
import { ConfirmDialog } from './ConfirmDialog';
import { DiffViewerDialog } from './DiffViewerDialog';
import { EvidencePanel } from './EvidencePanel';
import { FeatureHint } from './FeatureHint';
import { MergeReadinessPanel } from './MergeReadinessPanel';
import { FinishPrSection, PrMergeRoute } from './FinishPrSection';
import { MergeBlockers, MergeChanges, MergeOptions } from './MergeSection';
import { PushSection } from './PushSection';
import { ReadinessSection } from './ReadinessSection';
import { createMergeState } from './merge-state';
import { PR_MERGE_ACTIONS, createFinishPr, taskPrUrl } from './pr-actions';
import { createPushRun } from './push-run';
import { getProject, getTaskChecks } from '../store/store';
import { markFeatureHintSeen } from '../store/onboarding';
import { showNotification } from '../store/notification';
import { dialogButtonStyle, theme } from '../lib/theme';
import { GitMergeIcon, SyncIcon, UploadIcon } from './icons';

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
  onOpenPullRequest: (url: string) => void;
  /** Starts closing the task, once its PR merged on GitHub. */
  onCloseTask: () => void;
  onPushStart: () => void;
  onPushDone: (success: boolean) => void;
  onDiffFileClick: (file: ChangedFile) => void;
  /** Opens the project settings at the verify command and evidence checks. */
  onConfigureChecks: () => void;
  /** Closing never stops a running push; it finishes in the background. */
  onClose: () => void;
}

const SHOWN_ELSEWHERE = new Set(['Merge safety', 'Verify command', 'Evidence', 'PR checks']);

/**
 * One place to wrap up a task. Reads top to bottom: what blocks the merge,
 * what changed, whether the checks back it, then how to merge. Merge and push
 * are both footer actions, since pushing does not exclude merging later.
 */
export function FinishDialog(props: FinishDialogProps) {
  const merge = createMergeState(props);
  let readinessAnchor: HTMLDivElement | undefined;
  // The same test the evidence panel uses to offer Configure checks.
  const hasChecks = () => getTaskChecks(props.task.id).length > 0;
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
    onDone: (success) => {
      // Both heads may have moved; the push-first blocker compares them.
      if (success) {
        merge.refetchAll();
        void pr.refetch();
      }
      props.onPushDone(success);
    },
  });
  const pr = createFinishPr({
    get open() {
      return props.open;
    },
    get task() {
      return props.task;
    },
    // Reading an errored resource throws; treat it as an unreadable HEAD.
    headSha: () => (merge.worktreeStatus.error ? null : merge.worktreeStatus()?.head_sha),
  });
  const prMerging = () => pr.busy() === 'merge';

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
    if (pr.mode() === 'merged') return 'Close task';
    if (merge.merging() || prMerging()) return 'Merging...';
    const method = pr.method();
    if (pr.mode() === 'pr') {
      // The PR number heads its section; the button names only the action.
      const action = method ? PR_MERGE_ACTIONS[method] : 'Merge';
      return pr.bypassing() ? `${action} as admin` : action;
    }
    // The target lives on the button, so the dialog needs no sentence restating it.
    return `${merge.squash() ? 'Squash merge' : 'Merge'} into ${merge.baseBranchName()}`;
  };
  // Said elsewhere in this dialog: merge safety by the notices on top, the
  // verify command in the check list, evidence by the panel these rows sit in.
  const readinessRows = () =>
    merge.mergeReadiness().checks.filter((check) => !SHOWN_ELSEWHERE.has(check.label));
  const confirmDisabled = () => {
    if (push.pushing()) return true;
    if (pr.mode() === 'merged') return false;
    if (pr.mode() === 'pr') return !!pr.busy() || !!pr.blocker();
    return !!pr.busy() || !merge.canMerge();
  };
  const footerNote = () => {
    if (merge.merging() || prMerging() || pr.mode() === 'merged') return undefined;
    return pr.mode() === 'pr' ? pr.blocker() : merge.mergeBlocker();
  };
  const pushDisabled = () => push.pushing() || merge.merging() || prMerging();
  const mergeAndClose = async () => {
    if (await merge.merge()) props.onClose();
  };
  const mergePr = async () => {
    const number = pr.number();
    const outcome = await pr.merge();
    if (outcome === 'failed') return;
    if (outcome === 'queued') {
      showNotification(`Merge requested for PR #${number}; GitHub has not merged it yet.`);
      props.onClose();
      return;
    }
    showNotification(`Merged PR #${number}`);
    // Stay open: the refetched PR flips the footer to Close task.
    void pr.refetch();
  };
  const confirm = () => {
    if (pr.mode() === 'merged') {
      props.onClose();
      props.onCloseTask();
    } else if (pr.mode() === 'pr') void mergePr();
    else void mergeAndClose();
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
            <MergeBlockers
              task={props.task}
              state={merge}
              open={props.open}
              onDone={() => props.onClose()}
              onDiffFileClick={props.onDiffFileClick}
            />
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
                    <SyncIcon size={12} />
                    Regenerate
                  </button>
                </Show>
              </ChangeTourButton>
            </MergeChanges>
            {/* A sub-task's own report is context for the review, so it starts folded. */}
            <Show when={props.task.coordinatedBy && props.task.completion}>
              <details style={{ 'margin-bottom': '20px', 'font-size': '13px' }}>
                <summary style={{ cursor: 'pointer', color: theme.fgMuted }}>
                  Agent completion report
                </summary>
                <CompletionReport
                  task={props.task}
                  headSha={merge.worktreeStatus()?.head_sha ?? undefined}
                />
              </details>
            </Show>
            {/* Opening the section or running a check there is taking the tip. */}
            <div ref={readinessAnchor} onClick={() => markFeatureHintSeen('finish-review')}>
              <ReadinessSection
                task={props.task}
                headSha={merge.worktreeStatus()?.head_sha}
                // Reading an errored resource throws; the line then omits "N commits ago".
                branchCommits={
                  merge.branchCommits.error
                    ? undefined
                    : merge.branchCommits()?.map((commit) => commit.hash)
                }
                onConfigure={() => props.onConfigureChecks()}
                onStaged={() => {
                  showNotification('Fix prompt staged in the task input. Review it, then send.');
                  props.onClose();
                }}
                onReviewFile={(file, line, side) => setReviewLocation({ file, line, side })}
              >
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
              </ReadinessSection>
            </div>
            <FeatureHint
              id="finish-review"
              when={props.open}
              anchor={() => readinessAnchor}
              title="Check what backs this change"
              actions={
                hasChecks()
                  ? undefined
                  : // It leaves this dialog for the project settings.
                    [{ label: 'Configure checks', run: props.onConfigureChecks, quiet: true }]
              }
            >
              Readiness says whether the verify command passed on this commit. It runs in the
              background after each agent turn; Details holds the full evidence.
              <Show when={!hasChecks()}> Add a verify command to have your tests run.</Show>
            </FeatureHint>
            <FinishPrSection
              task={props.task}
              pr={pr}
              disabled={push.pushing() || merge.merging()}
              onOpenPullRequest={(url) => props.onOpenPullRequest(url)}
              onStaged={() => {
                showNotification('Prompt staged in the task input. Review it, then send.');
                props.onClose();
              }}
            >
              <Show when={taskPrUrl(props.task)}>
                <PrMergeRoute pr={pr} disabled={push.pushing() || merge.merging()} />
              </Show>
            </FinishPrSection>
            <Show when={pr.mode() === 'local'}>
              <div style={{ 'margin-top': '12px' }}>
                <MergeOptions task={props.task} state={merge} />
              </div>
            </Show>
            {/* Pushing does not finish the task, so it sits with the content, not the footer. */}
            <div
              style={{
                display: 'flex',
                'flex-wrap': 'wrap',
                gap: '8px',
                'align-items': 'center',
                'margin-top': '12px',
                'font-size': '12px',
                color: theme.fgMuted,
              }}
            >
              <button
                type="button"
                class="btn-secondary btn-with-icon"
                disabled={pushDisabled()}
                onClick={() => void push.start()}
                title={`Push ${props.task.branchName} to origin`}
                style={dialogButtonStyle(false, pushDisabled() && !push.pushing())}
              >
                <UploadIcon size={14} />
                {push.pushing() ? 'Pushing…' : 'Push branch'}
              </button>
              {pr.mode() === 'pr' ? 'Updates the PR; the task stays open.' : 'The task stays open.'}
            </div>
            <Show when={push.pushing() || push.output() || push.error()}>
              <div style={{ 'margin-top': '12px' }}>
                <PushSection run={push} />
              </div>
            </Show>
          </div>
        }
        confirmDisabled={confirmDisabled()}
        footerNote={footerNote()}
        confirmLoading={merge.merging() || prMerging()}
        confirmLabel={confirmLabel()}
        confirmIcon={pr.mode() === 'merged' ? undefined : <GitMergeIcon size={14} />}
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
