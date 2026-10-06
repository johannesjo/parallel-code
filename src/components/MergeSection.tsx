import { Show, type JSX } from 'solid-js';
import { getProject, getTaskChecks, updateTaskBranch } from '../store/store';
import { bannerStyle, theme } from '../lib/theme';
import type { Task } from '../store/types';
import type { ChangedFile } from '../ipc/types';
import { ChangedFilesList } from './ChangedFilesList';
import { MergeCommitList } from './MergeCommitList';
import { MergeConflictBanner } from './MergeConflictBanner';
import type { MergeState } from './merge-state';

interface MergeSectionProps {
  task: Task;
  state: MergeState;
  open: boolean;
  onDone: () => void;
  onDiffFileClick: (file: ChangedFile) => void;
}

const optionStyle = {
  display: 'flex',
  'align-items': 'center',
  gap: '8px',
  cursor: 'pointer',
  'font-size': '13px',
  color: theme.fg,
};
const commitLabel = (count: number) => `${count} commit${count === 1 ? '' : 's'}`;

/** What stops or changes a merge; shown first so it is read before anything else. */
export function MergeBlockers(props: MergeSectionProps) {
  return (
    <>
      <Show when={props.state.hasBranchMismatch()}>
        <div
          style={{
            ...bannerStyle(theme.error),
            'margin-bottom': '12px',
            'font-size': '13px',
          }}
        >
          <Show when={props.state.worktreeStatus()?.current_branch === null}>
            <div style={{ 'font-weight': '600' }}>
              Worktree has a detached HEAD — merging '{props.task.branchName}' would discard work.
            </div>
          </Show>
          <Show when={props.state.worktreeStatus()?.current_branch !== null}>
            <div style={{ 'font-weight': '600' }}>
              The worktree is on '{props.state.worktreeStatus()?.current_branch}' but this task
              tracks '{props.task.branchName}'.
            </div>
            <Show when={props.state.adoptableWorktreeBranch()}>
              {(branch) => (
                <div
                  style={{
                    'margin-top': '8px',
                    display: 'flex',
                    'align-items': 'center',
                    gap: '8px',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      updateTaskBranch(props.task.id, branch());
                      props.state.refetchAll();
                    }}
                    style={{
                      padding: '4px 12px',
                      background: theme.bgInput,
                      border: `1px solid ${theme.border}`,
                      'border-radius': 'var(--radius-sm)',
                      color: theme.fg,
                      cursor: 'pointer',
                      'font-size': '13px',
                    }}
                  >
                    Use '{branch()}'
                  </button>
                </div>
              )}
            </Show>
          </Show>
        </div>
      </Show>
      <Show when={props.state.worktreeStatus()?.has_uncommitted_changes}>
        <div
          style={{
            ...bannerStyle(theme.warning),
            'margin-bottom': '12px',
            'font-size': '13px',
          }}
        >
          Uncommitted changes in the worktree are not part of this merge.
        </div>
      </Show>
      <Show when={!props.state.worktreeStatus.loading && !props.state.hasCommittedChangesToMerge()}>
        <div
          style={{
            ...bannerStyle(theme.warning),
            'margin-bottom': '12px',
            'font-size': '13px',
          }}
        >
          Nothing to merge: this branch has no committed changes compared to{' '}
          {props.state.baseBranchName()}.
        </div>
      </Show>
      <MergeConflictBanner task={props.task} state={props.state} onDone={props.onDone} />
      {/* Outside the conflict banner: that one hides once the base is in. */}
      <Show when={props.state.syncDone()}>
        {(kind) => (
          <div
            role="status"
            style={{ ...bannerStyle(theme.success), 'margin-bottom': '12px', 'font-size': '13px' }}
          >
            {kind() === 'merge'
              ? `Merged ${props.state.baseBranchName()} into this branch.`
              : `Rebased onto ${props.state.baseBranchName()}.`}
            <Show when={getTaskChecks(props.task.id).length > 0}>
              {getProject(props.task.projectId)?.evidenceAutoBuild
                ? ' Re-running the checks.'
                : ' Refresh the checks to cover the new commits.'}
            </Show>
          </div>
        )}
      </Show>
    </>
  );
}

/**
 * What is being reviewed: open by default, since everything below judges it.
 * Children, such as the change tour, form a footer strip under the file list,
 * as in the task's changed-files panel.
 */
export function MergeChanges(props: MergeSectionProps & { children?: JSX.Element }) {
  return (
    <details open style={{ 'margin-bottom': '20px', 'font-size': '13px' }}>
      <summary style={{ cursor: 'pointer', color: theme.fgMuted }}>
        Commits and changed files
        <Show when={props.state.commitCount()}>{(count) => ` (${commitLabel(count())})`}</Show>
      </summary>
      <div style={{ 'margin-top': '8px' }}>
        <MergeCommitList state={props.state} />
        <div
          style={{
            border: `1px solid ${theme.border}`,
            'border-radius': 'var(--radius-md)',
            overflow: 'hidden',
            // About five rows plus the footer: the list scrolls itself so the
            // dialog does not.
            'max-height': '200px',
            display: 'flex',
            'flex-direction': 'column',
          }}
        >
          <ChangedFilesList
            worktreePath={props.task.worktreePath}
            projectRoot={getProject(props.task.projectId)?.path}
            branchName={props.task.branchName}
            isActive={props.open}
            onFileClick={props.onDiffFileClick}
            baseBranch={props.task.baseBranch}
            coverageReportPath={getProject(props.task.projectId)?.coverageReportPath}
            onCoverageComparisonChange={props.state.setCoverageComparison}
          />
          {props.children}
        </div>
      </div>
    </details>
  );
}

/** How to merge: cleanup, squash and its message, and the merge error. */
export function MergeOptions(props: Pick<MergeSectionProps, 'task' | 'state'>) {
  return (
    <>
      <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '6px 20px' }}>
        {/* Imported worktrees are user-owned — never offer to delete them or their branch. */}
        <Show when={!props.task.externalWorktree}>
          <label style={optionStyle}>
            <input
              type="checkbox"
              checked={!props.state.requiresSeparateClose() && props.state.cleanupAfterMerge()}
              disabled={props.state.requiresSeparateClose()}
              onChange={(e) => props.state.setCleanupAfterMerge(e.currentTarget.checked)}
              style={{ cursor: 'pointer' }}
            />
            Delete branch and worktree after merge
          </label>
        </Show>
        <label style={optionStyle}>
          <input
            type="checkbox"
            checked={props.state.squash()}
            onChange={(e) => props.state.enableSquash(e.currentTarget.checked)}
            style={{ cursor: 'pointer' }}
          />
          Squash commits
        </label>
      </div>
      <Show when={!props.task.externalWorktree && props.state.requiresSeparateClose()}>
        <p style={{ 'font-size': '12px', color: theme.fgMuted, margin: '6px 0 0' }}>
          Merge first, then close this task to detach its children safely.
        </p>
      </Show>
      <Show when={props.state.squash()}>
        <textarea
          value={props.state.squashMessage()}
          onInput={(e) => props.state.setSquashMessage(e.currentTarget.value)}
          placeholder="Commit message..."
          rows={3}
          style={{
            'margin-top': '8px',
            width: '100%',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            'border-radius': 'var(--radius-md)',
            padding: '8px 10px',
            color: theme.fg,
            'font-size': '13px',
            'font-family': "'JetBrains Mono', monospace",
            resize: 'vertical',
            outline: 'none',
            'box-sizing': 'border-box',
          }}
        />
      </Show>
      <Show when={props.state.mergeError()}>
        <div
          style={{
            ...bannerStyle(theme.error),
            'margin-top': '12px',
            'font-size': '13px',
          }}
        >
          {props.state.mergeError()}
        </div>
      </Show>
    </>
  );
}
