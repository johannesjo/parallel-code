import { Show, type JSX } from 'solid-js';
import { undoBranchAdoption, dismissBranchAdoptionNotice } from '../store/store';
import { theme } from '../lib/theme';
import type { Task } from '../store/types';

const bannerBtnStyle: JSX.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${theme.warning}`,
  'border-radius': 'var(--radius-xs)',
  padding: '1px 8px',
  color: theme.warning,
  cursor: 'pointer',
  'font-family': 'inherit',
  'font-size': '11px',
  'flex-shrink': '0',
};

/** Banner shown after the app auto-adopted the branch an agent switched the
 *  task's worktree to. Undo restores the previous task branch and keeps the
 *  adopted one dismissed, so detection doesn't immediately re-adopt it. */
export function TaskBranchAdoptionBanner(props: { task: Task }) {
  return (
    <Show when={props.task.branchAdoptedFrom}>
      {(previousBranch) => (
        <div
          class="task-branch-adoption-banner"
          role="status"
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '10px',
            'border-bottom': `1px solid ${theme.border}`,
            background: `color-mix(in srgb, ${theme.warning} 12%, transparent)`,
            padding: '5px 12px',
            'font-size': '11px',
            color: theme.warning,
          }}
        >
          <span style={{ flex: '1', 'min-width': '0' }}>
            This task's worktree switched to <strong>'{props.task.branchName}'</strong> — the task
            adopted it (was '{previousBranch()}'). Merge, diff and PR detection now use the new
            branch.
          </span>
          <button
            type="button"
            style={bannerBtnStyle}
            title={`Track '${previousBranch()}' again and stop offering '${props.task.branchName}'`}
            onClick={() => undoBranchAdoption(props.task.id)}
          >
            Undo
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            style={{ ...bannerBtnStyle, border: 'none', padding: '1px 4px', 'font-size': '13px' }}
            onClick={() => dismissBranchAdoptionNotice(props.task.id)}
          >
            ×
          </button>
        </div>
      )}
    </Show>
  );
}
