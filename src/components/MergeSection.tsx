import { Show, type JSX } from 'solid-js';
import {
  backgroundVerifyEnabled,
  getProject,
  getTaskChecks,
  updateTaskBranch,
} from '../store/store';
import { bannerStyle, sectionLabelStyle, theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import type { Task } from '../store/types';
import type { ChangedFile } from '../ipc/types';
import { ChangedFilesList } from './ChangedFilesList';
import { MergeCommitList } from './MergeCommitList';
import { BaseUpstreamNotice } from './BaseUpstreamNotice';
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
const messageFieldStyle = {
  width: '100%',
  background: theme.bgInput,
  border: `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-md)',
  padding: '8px 10px',
  color: theme.fg,
  'font-size': '13px',
  'font-family': "'JetBrains Mono', monospace",
  outline: 'none',
  'box-sizing': 'border-box',
} as const;

const commitLabel = (count: number) => `${count} commit${count === 1 ? '' : 's'}`;

/** What stops or changes a merge; shown first so it is read before anything else. */
export function MergeBlockers(props: MergeSectionProps & { showBaseSync: boolean }) {
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
      <Show when={props.state.targetUncommitted()}>
        {(target) => (
          <div
            data-testid="target-uncommitted"
            style={{
              ...bannerStyle(theme.warning),
              'margin-bottom': '12px',
              'font-size': '13px',
            }}
          >
            <Show
              when={target().overlap.length > 0}
              fallback={
                <>
                  {target().path} has uncommitted changes in {target().files.length} file
                  {target().files.length > 1 ? 's' : ''}. Merging sets them aside and puts them back
                  afterwards.
                </>
              }
            >
              Uncommitted changes in {target().path} touch files this merge changes:{' '}
              {target().overlap.join(', ')}. Commit or stash them first.
            </Show>
          </div>
        )}
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
      {/* Before the conflict banner: it explains conflicts that banner lists. */}
      <BaseUpstreamNotice task={props.task} state={props.state} />
      <Show when={props.showBaseSync}>
        <MergeConflictBanner task={props.task} state={props.state} onDone={props.onDone} />
      </Show>
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
              {backgroundVerifyEnabled(props.task.id)
                ? ' Verify runs again in the background.'
                : ' Refresh the checks to cover the new commits.'}
            </Show>
          </div>
        )}
      </Show>
    </>
  );
}

/** What is being reviewed: open by default, since everything below judges it. */
export function MergeChanges(props: MergeSectionProps) {
  return (
    <details open style={{ 'margin-bottom': '20px', 'font-size': '13px' }}>
      <summary style={{ ...sectionLabelStyle, 'font-size': sf(11), cursor: 'pointer' }}>
        Commits and changed files
        <Show when={props.state.commitCount()}>{(count) => ` (${commitLabel(count())})`}</Show>
      </summary>
      <div style={{ 'margin-top': '8px' }}>
        <MergeCommitList state={props.state} />
        <div
          style={{
            // Square corners: rounded, the list reads like one of the buttons around it.
            border: `1px solid ${theme.border}`,
            overflow: 'hidden',
            // About five rows: the list scrolls itself so the dialog does not.
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
        </div>
      </div>
    </details>
  );
}

/** Opt-out of removing the task once it merged, locally or through its PR. */
export function CleanupOption(props: {
  task: Task;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children: JSX.Element;
}) {
  return (
    // Imported worktrees are user-owned — never offer to delete them or their branch.
    <Show when={!props.task.externalWorktree}>
      <label style={optionStyle}>
        <input
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.currentTarget.checked)}
          style={{ cursor: 'pointer' }}
        />
        {props.children}
      </label>
    </Show>
  );
}

/** How to merge: cleanup, squash and its message, and the merge error. */
export function MergeOptions(props: Pick<MergeSectionProps, 'task' | 'state'>) {
  return (
    <>
      <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '6px 20px' }}>
        <CleanupOption
          task={props.task}
          checked={!props.state.requiresSeparateClose() && props.state.cleanupAfterMerge()}
          disabled={props.state.requiresSeparateClose()}
          onChange={(checked) => props.state.setCleanupAfterMerge(checked)}
        >
          Delete branch and worktree after merge
        </CleanupOption>
        <label style={optionStyle}>
          <input
            type="checkbox"
            checked={props.state.squash()}
            onChange={(e) => props.state.setSquash(e.currentTarget.checked)}
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
        <input
          type="text"
          aria-label="Commit title"
          value={props.state.squashTitle()}
          onInput={(e) => props.state.setSquashTitle(e.currentTarget.value)}
          placeholder="Commit title"
          style={{ ...messageFieldStyle, 'margin-top': '8px' }}
        />
        <textarea
          aria-label="Commit description"
          value={props.state.squashBody()}
          onInput={(e) => props.state.setSquashBody(e.currentTarget.value)}
          placeholder="Add an optional extended description…"
          rows={5}
          style={{ ...messageFieldStyle, 'margin-top': '6px', resize: 'vertical' }}
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
