import { Show, createEffect, createSignal, on } from 'solid-js';
import type { ChangeTourController } from '../lib/create-change-tour';
import type { Task } from '../store/types';
import type { ChangedFile, WorktreeStatus } from '../ipc/types';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { ChangeTourButton } from './ChangeTourButton';
import { CompletionReport } from './CompletionReport';
import { ConfirmDialog } from './ConfirmDialog';
import { CreatePrDialog } from './CreatePrDialog';
import { DiffViewerDialog } from './DiffViewerDialog';
import { FeatureHint } from './FeatureHint';
import { MergeReadinessPanel } from './MergeReadinessPanel';
import { CreatePrEntry } from './CreatePrEntry';
import { FinishPrSection, PrMergeRoute } from './FinishPrSection';
import { CleanupOption, MergeBlockers, MergeChanges, MergeOptions } from './MergeSection';
import { closeTaskNow } from './CloseTaskDialog';
import { PushSection } from './PushSection';
import { ReadinessSection } from './ReadinessSection';
import { FollowUps } from './FollowUps';
import { ReviewSection } from './ReviewSection';
import { RetroButton } from './RetroButton';
import { ScreensFollowUp } from './ScreensSection';
import { createMergeState } from './merge-state';
import { PR_MERGE_ACTIONS, createFinishPr, taskPrUrl } from './pr-actions';
import { createPushRun } from './push-run';
import { backgroundVerifyEnabled, getProject, getTaskChecks } from '../store/store';
import { markFeatureHintSeen } from '../store/onboarding';
import { showNotification } from '../store/notification';
import { store } from '../store/core';
import { canCaptureScreens, taskScreens } from '../store/task-screens';
import { sectionLabelStyle } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { isVerificationStale, summarizeVerificationRun } from '../lib/verification-run';
import { isTourOutdated } from '../lib/finish-reports';
import { errMessage, warn as logWarn } from '../lib/log';
import { parseGitHubUrl } from '../lib/github-url';
import { refreshCodeFingerprint } from '../store/task-brief';
import { GitMergeIcon, SyncIcon, UploadIcon } from './icons';

export type FinishAction = 'merge' | 'push' | 'create-pr';

interface FinishDialogProps {
  open: boolean;
  task: Task;
  initialCleanup: boolean;
  /** Opens Create pull request on top, as the shortcut and the task menu do. */
  initialCreatePr: boolean;
  tour: ChangeTourController;
  /** Opens a ready tour, or starts generating one, like the Changed Files button. */
  onTourClick: () => void;
  onRegenerateTour: () => void;
  onOpenPullRequest: (url: string) => void;
  /** Starts closing the task, once its PR merged on GitHub. */
  onCloseTask: () => void;
  onPushStart: () => void;
  /** `keepOpen`: the push was the first step of creating a PR, which continues here. */
  onPushDone: (success: boolean, keepOpen: boolean) => void;
  onDiffFileClick: (file: ChangedFile) => void;
  /** Opens the project settings at the verify command and evidence checks. */
  onConfigureChecks: () => void;
  /** Closing never stops a running push; it finishes in the background. */
  onClose: () => void;
}

const SHOWN_ELSEWHERE = new Set(['Merge safety', 'Verify command', 'PR checks']);

/**
 * One place to wrap up a task. Reads top to bottom: what blocks the merge,
 * the changed files, then "Before you merge" (whether the checks back it,
 * then the optional tour and review), then how to merge. Merge and push are both footer actions, since pushing does not
 * exclude merging later.
 */
export function FinishDialog(props: FinishDialogProps) {
  const merge = createMergeState(props);
  let readinessAnchor: HTMLDivElement | undefined;
  const hasChecks = () => getTaskChecks(props.task.id).length > 0;
  // Nothing configured, run or reported leaves readiness only "No verify command";
  // the review line below covers that case.
  const showReadiness = () =>
    hasChecks() ||
    !!props.task.verificationRun ||
    !!props.task.evidence ||
    !!props.task.verification?.checks.length;
  const [reviewLocation, setReviewLocation] = createSignal<{
    file: string;
    line?: number;
    side?: 'old' | 'new';
  }>();
  createEffect(() => {
    if (!props.open) setReviewLocation(undefined);
  });
  // A tour is judged against the code as it is now, edits since the last turn included.
  createEffect(
    on(
      () => props.open && !!props.tour.basis(),
      (check) => {
        if (!check) return;
        refreshCodeFingerprint(props.task.id).catch((error: unknown) =>
          logWarn('changeTour', 'Reading the code failed', { error: errMessage(error) }),
        );
      },
    ),
  );
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
      props.onPushDone(success, createPrOpen());
    },
  });
  const [createPrOpen, setCreatePrOpen] = createSignal(false);
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
  // A PR merges on GitHub, so a base that moved on locally matters only where
  // it conflicts or GitHub asks for the branch to be updated.
  const showBaseSync = () => {
    const mode = pr.mode();
    if (mode !== 'pr') return mode === 'local';
    const details = pr.pr();
    return (
      merge.hasConflicts() ||
      details?.mergeStateStatus === 'BEHIND' ||
      details?.mergeable === 'CONFLICTING'
    );
  };
  // Only a failure on the current commit counts; an older run is said in readiness below.
  const verifyFailed = () => {
    const run = props.task.verificationRun;
    if (!run || merge.worktreeStatus.error) return false;
    const head = merge.worktreeStatus()?.head_sha;
    return summarizeVerificationRun(run, head).kind === 'failed' && !isVerificationStale(run, head);
  };
  // Not the local cleanup flag: that follows deleteBranchOnClose, which closeTask applies itself.
  const [closeAfterPrMerge, setCloseAfterPrMerge] = createSignal(true);

  // Tracks only `open`: reset reads `pushing`, and re-running when a push ends
  // would wipe the error it just reported.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        push.reset();
        setCloseAfterPrMerge(true);
        setCreatePrOpen(props.initialCreatePr);
      },
    ),
  );

  // Reading an errored resource throws; an unknown remote offers no push.
  const remote = () => (merge.mergeStatus.error ? undefined : merge.mergeStatus()?.remote);
  // Merging a PR is pinned to its head, so local commits must be pushed first.
  const pushFirst = () => pr.mode() === 'pr' && pr.headDiffers();
  // A local merge uses local commits, so pushing is only on offer, never required.
  const offerPush = () =>
    pr.mode() === 'local' && (remote() === 'unpushed' || remote() === 'differs');
  // Undefined while loading; a loaded status without a remote means there is no origin.
  const createPrRemote = () =>
    merge.mergeStatus.loading || merge.mergeStatus.error || !merge.mergeStatus()
      ? undefined
      : (remote() ?? 'none');
  const prCreated = (created: { url: string; existed: boolean; draft: boolean }) => {
    setCreatePrOpen(false);
    const number = parseGitHubUrl(created.url)?.number;
    const what = created.existed ? 'Linked' : created.draft ? 'Created draft' : 'Created';
    showNotification(`${what} pull request #${number}`, {
      tone: 'success',
      action: {
        label: 'Open on GitHub',
        run: () => void invoke(IPC.ShellOpenExternal, { url: created.url }),
      },
    });
    void pr.refetch();
  };

  const confirmLabel = () => {
    if (pushFirst()) return push.pushing() ? 'Pushing…' : 'Push';
    if (pr.mode() === 'merged') return 'Close task';
    if (merge.merging() || prMerging()) return 'Merging...';
    const method = pr.method();
    if (pr.mode() === 'pr') {
      // The PR number heads its section; the button names the action and where it runs.
      const action = `${method ? PR_MERGE_ACTIONS[method] : 'Merge'} on GitHub`;
      return pr.bypassing() ? `${action} as admin` : action;
    }
    // The target lives on the button, so the dialog needs no sentence restating it.
    // "local" because nothing is fetched before or pushed after this merge.
    return `${merge.squash() ? 'Squash merge' : 'Merge'} into local ${merge.baseBranchName()}`;
  };
  // Said elsewhere in this dialog: merge safety by the notices on top, the
  // verify command by the readiness line, PR checks by the PR section.
  const readinessRows = () =>
    merge.mergeReadiness().checks.filter((check) => !SHOWN_ELSEWHERE.has(check.label));
  const confirmDisabled = () => {
    if (push.pushing()) return true;
    if (pushFirst()) return pushDisabled() || !!pushBlocker();
    if (pr.mode() === 'merged') return false;
    if (pr.mode() === 'pr') return !!pr.busy() || !!pr.blocker();
    return !!pr.busy() || !merge.canMerge();
  };
  const footerNote = () => {
    if (merge.merging() || prMerging() || pr.mode() === 'merged') return undefined;
    if (pushFirst()) return pushBlocker() ?? 'The PR is missing your latest commits.';
    if (pr.mode() !== 'pr') return merge.mergeBlocker();
    return (
      pr.blocker() ?? (pr.pr()?.isDraft ? 'Marks the draft ready for review first.' : undefined)
    );
  };
  const pushDisabled = () => push.pushing() || merge.merging() || prMerging();
  /**
   * Why pushing would send the wrong thing. Merge-only blockers such as
   * conflicts stay out: pushing is how a PR gets them resolved. An unreadable
   * status blocks nothing; the push reports its own error.
   */
  const pushBlocker = (): string | undefined => {
    if (merge.worktreeStatus.error) return undefined;
    if (!merge.worktreeStatus()) return 'Checking the branch…';
    if (merge.hasBranchMismatch()) return "The worktree is not on this task's branch.";
    return undefined;
  };
  const mergeAndClose = async () => {
    if (await merge.merge()) props.onClose();
  };
  /** `asIs` merges the PR without the unpushed commits, so the task stays open for them. */
  const mergePr = async (asIs = false) => {
    const number = pr.number();
    const outcome = await pr.merge();
    if (outcome === 'failed') return;
    if (outcome === 'queued') {
      showNotification(`Merge requested for PR #${number}; GitHub has not merged it yet.`);
      props.onClose();
      return;
    }
    showNotification(`Merged PR #${number}`, { tone: 'success' });
    if (!asIs && !merge.requiresSeparateClose() && closeAfterPrMerge()) {
      const { id, worktreePath } = props.task;
      props.onClose();
      // Fetched now, not on open: a running agent may have written files since.
      const status = await invoke<WorktreeStatus>(IPC.GetWorktreeStatus, { worktreePath }).catch(
        (err: unknown) => {
          console.error('Worktree status before closing failed:', err);
          return undefined;
        },
      );
      // Unsaved edits would be lost silently, so those go through the close warning.
      if (status && !status.has_uncommitted_changes) closeTaskNow(id, 'merged');
      else props.onCloseTask();
      return;
    }
    // Stay open: the refetched PR flips the footer to Close task.
    void pr.refetch();
  };
  const confirm = () => {
    if (pushFirst()) void push.start();
    else if (pr.mode() === 'merged') {
      props.onClose();
      props.onCloseTask();
    } else if (pr.mode() === 'pr') void mergePr();
    else void mergeAndClose();
  };

  // Judged from the dialog's own status: the panel's file list may not be mounted.
  // Until the status arrives the tour counts as possible, so the row does not jump.
  const tourDisabled = () => {
    const status = merge.worktreeStatus();
    return !!status && !status.has_committed_changes && !status.has_uncommitted_changes;
  };
  const tourOutdated = () => {
    const basis = props.tour.basis();
    return !!basis && isTourOutdated(basis, props.task);
  };
  // A disabled tour with nothing to show or cancel would be an empty box.
  const tourShown = () => !tourDisabled() || props.tour.loading() || props.tour.stops().length > 0;
  const tourBox = () => (
    <div class="finish-followup">
      <ChangeTourButton
        tour={props.tour}
        onClick={props.onTourClick}
        disabled={tourDisabled()}
        outdated={tourOutdated()}
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
    </div>
  );

  // Screens of a change with no commits would show nothing; a past capture stays reachable.
  const screensShown = () =>
    (canCaptureScreens() && !tourDisabled()) || !!taskScreens(props.task.id);
  const retroBox = () => (
    <RetroButton
      task={props.task}
      // The retro happens in the agent's session, so Finish steps aside.
      onSent={() => props.onClose()}
    />
  );

  // The verify result, which leads "Before you merge". Opening its details or
  // running a check there is taking the tip.
  const readiness = () => (
    <Show when={showReadiness()}>
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
          hasDetails={readinessRows().length > 0}
        >
          <MergeReadinessPanel checks={readinessRows()} />
        </ReadinessSection>
      </div>
    </Show>
  );

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
              showBaseSync={showBaseSync()}
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
            />
            {/* A sub-task's own report is context for the review, so it starts folded. */}
            <Show when={props.task.coordinatedBy && props.task.completion}>
              <details style={{ 'margin-bottom': '20px', 'font-size': '13px' }}>
                <summary style={{ ...sectionLabelStyle, 'font-size': sf(11), cursor: 'pointer' }}>
                  Agent completion report
                </summary>
                <CompletionReport
                  task={props.task}
                  headSha={merge.worktreeStatus()?.head_sha ?? undefined}
                />
              </details>
            </Show>
            <FeatureHint
              id="finish-review"
              when={props.open && showReadiness()}
              anchor={() => readinessAnchor}
              title="Check what backs this change"
              actions={
                hasChecks()
                  ? undefined
                  : // It leaves this dialog for the project settings.
                    [{ label: 'Configure checks', run: props.onConfigureChecks, quiet: true }]
              }
            >
              Readiness says whether the verify command passed on this commit; Details holds the
              other checks, such as coverage.
              <Show when={backgroundVerifyEnabled(props.task.id)}>
                {' '}
                It runs in the background after agent turns.
              </Show>
              <Show when={!hasChecks()}> Add a verify command to have your tests run.</Show>
            </FeatureHint>
            {/* The verify result leads; each optional step's result opens right below it. The
                review comes first: with the verify result, it says whether the work is right. */}
            <FollowUps lead={readiness()}>
              <Show when={store.finishReview}>
                <ReviewSection
                  task={props.task}
                  verifyFailed={verifyFailed()}
                  onReworkStaged={() => {
                    showNotification(
                      'Rework prompt staged in the task input. Review it, then send.',
                    );
                    props.onClose();
                  }}
                  onOpenFile={(file, line) => setReviewLocation({ file, line, side: 'new' })}
                />
              </Show>
              <Show when={tourShown()}>{tourBox()}</Show>
              <Show when={screensShown()}>
                <ScreensFollowUp
                  taskId={props.task.id}
                  disabled={tourDisabled()}
                  headSha={merge.worktreeStatus()?.head_sha}
                />
              </Show>
              {retroBox()}
            </FollowUps>
            {/* Without a PR the section only offers one, where the PR shows once it exists;
                without an origin, local merging needs no word on PRs. */}
            <Show
              when={taskPrUrl(props.task)}
              fallback={
                <Show when={remote()}>
                  <CreatePrEntry
                    disabled={push.pushing() || merge.merging()}
                    onCreate={() => setCreatePrOpen(true)}
                  />
                </Show>
              }
            >
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
                <PrMergeRoute pr={pr} disabled={push.pushing() || merge.merging()} />
              </FinishPrSection>
            </Show>
            {/* Cleanup and squash mean nothing without commits; while that is unknown they stay, so nothing jumps. */}
            <Show
              when={
                pr.mode() === 'local' &&
                !(merge.worktreeStatus() && !merge.hasCommittedChangesToMerge())
              }
            >
              <div style={{ 'margin-top': '12px' }}>
                <MergeOptions task={props.task} state={merge} />
              </div>
            </Show>
            {/* Parents close separately to detach their children, so they get no opt-out. */}
            <Show when={pr.mode() === 'pr' && pr.pr() && !merge.requiresSeparateClose()}>
              <div style={{ 'margin-top': '12px' }}>
                <CleanupOption
                  task={props.task}
                  checked={closeAfterPrMerge()}
                  onChange={setCloseAfterPrMerge}
                >
                  Close task after merge
                </CleanupOption>
              </div>
            </Show>
            <Show when={push.pushing() || push.output() || push.error()}>
              <div style={{ 'margin-top': '12px' }}>
                <PushSection run={push} />
              </div>
            </Show>
          </div>
        }
        confirmDisabled={confirmDisabled()}
        footerNote={footerNote()}
        confirmLoading={merge.merging() || prMerging() || (pushFirst() && push.pushing())}
        confirmLabel={confirmLabel()}
        confirmIcon={
          pushFirst() ? (
            <UploadIcon size={14} />
          ) : pr.mode() === 'merged' ? undefined : (
            <GitMergeIcon size={14} />
          )
        }
        extraActions={
          <>
            <Show when={pushFirst()}>
              <button
                type="button"
                class="btn-secondary"
                disabled={pushDisabled() || !!pr.busy() || !!pr.blocker(true)}
                title={`Merge PR #${pr.number()} as it is on GitHub; the task stays open for the rest${pr.pr()?.isDraft ? '. Marks the draft ready for review first.' : ''}`}
                onClick={() => void mergePr(true)}
              >
                Merge as is
              </button>
            </Show>
            <Show when={offerPush() || (pr.mode() === 'local' && push.pushing())}>
              <button
                type="button"
                class="btn-secondary btn-with-icon"
                disabled={pushDisabled() || !!pushBlocker()}
                title={pushBlocker() ?? `Push ${props.task.branchName} to origin without merging`}
                onClick={() => void push.start()}
              >
                <UploadIcon size={12} />
                {push.pushing() ? 'Pushing…' : 'Push'}
              </button>
            </Show>
          </>
        }
        cancelLabel={push.pushing() ? 'Close' : 'Cancel'}
        onConfirm={confirm}
        onCancel={() => props.onClose()}
      />
      <CreatePrDialog
        open={props.open && createPrOpen()}
        task={props.task}
        base={merge.baseBranchName()}
        remote={createPrRemote()}
        commits={merge.branchCommits.error ? undefined : merge.branchCommits()}
        push={push}
        onCreated={prCreated}
        onClose={() => setCreatePrOpen(false)}
      />
      {/* Keep the review provider alive so returning to Finish preserves draft comments. */}
      <DiffViewerDialog
        scrollToFile={props.open ? (reviewLocation()?.file ?? null) : null}
        scrollToLine={reviewLocation()?.line}
        scrollToSide={reviewLocation()?.side}
        closeLabel="Back to Finish"
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
