import { Show, onMount } from 'solid-js';
import { getProject, setActiveTask, setTaskFocusedPanel, isPanelFocused } from '../store/store';
import { ChangedFilesList } from './ChangedFilesList';
import { CommitTreeOverlay } from './CommitTreeOverlay';
import {
  CommitNavBar,
  isCommitHashSelection,
  isUncommittedSelection,
  type CommitSelection,
} from './CommitNavBar';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { useFocusRegistration } from '../lib/focus-registration';
import type { Task } from '../store/types';
import type { CommitInfo } from '../ipc/types';

interface TaskChangedFilesSectionProps {
  task: Task;
  isActive: boolean;
  commitList: CommitInfo[];
  selectedCommit: CommitSelection;
  onCommitNavigate: (selection: CommitSelection) => void;
  onDiffFileClick: (path: string) => void;
}

export function TaskChangedFilesSection(props: TaskChangedFilesSectionProps) {
  const coverageReportPath = () => getProject(props.task.projectId)?.coverageReportPath;
  const hasCommitNav = () =>
    props.task.gitIsolation === 'worktree' || props.task.gitIsolation === 'direct';
  // The tree button only earns its place once a branch has history to graph — a
  // single commit is already covered by the file list + nav bar.
  const canShowTree = () => hasCommitNav() && props.commitList.length > 1;
  const selectedCommitInfo = () =>
    isCommitHashSelection(props.selectedCommit) && hasCommitNav()
      ? props.commitList.find((c) => c.hash === props.selectedCommit)
      : undefined;
  const showUncommittedBanner = () =>
    isUncommittedSelection(props.selectedCommit) && hasCommitNav();
  const focusChangedFilesPanel = () => {
    setActiveTask(props.task.id);
    setTaskFocusedPanel(props.task.id, 'changed-files');
  };

  let changedFilesRef: HTMLDivElement | undefined;

  onMount(() => {
    const id = props.task.id;
    useFocusRegistration(`${id}:changed-files`, () => {
      changedFilesRef?.focus();
    });
  });

  return (
    <div
      class="task-changed-files-section focusable-panel"
      data-panel-focused={isPanelFocused(props.task.id, 'changed-files') ? 'true' : 'false'}
      style={{
        // `height: 100%` fills when the panel is an absorber (notes-split
        // horizontal, 50/50 with notes). `min-height` gives the content-sized
        // case (split-right vertical) a usable default, while `max-height`
        // keeps the panel from ballooning past ~40 % of the viewport when the
        // changed-file list is long. The ResizablePanel wrapper applies the
        // fixed 300 px cap for unpinned auto-growth.
        height: '100%',
        'min-height': '140px',
        'max-height': '40vh',
        'min-width': '200px',
        background: theme.taskPanelBg,
        display: 'flex',
        'flex-direction': 'column',
      }}
      onClick={focusChangedFilesPanel}
    >
      <div
        style={{
          padding: '4px 8px',
          'font-size': sf(11),
          'font-weight': '600',
          color: theme.fgMuted,
          'text-transform': 'uppercase',
          'letter-spacing': '0.05em',
          'border-bottom': `1px solid ${theme.border}`,
          'flex-shrink': '0',
          display: 'flex',
          'align-items': 'center',
          gap: '6px',
        }}
      >
        <span style={{ 'flex-shrink': '0' }}>Changed Files</span>
        <span style={{ flex: '1' }} />
        <Show when={hasCommitNav()}>
          <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
            <Show when={canShowTree()}>
              <CommitTreeOverlay
                commits={props.commitList}
                worktreePath={props.task.worktreePath}
                baseBranch={props.task.baseBranch}
                selectedCommit={props.selectedCommit}
                onSelectCommit={props.onCommitNavigate}
              />
            </Show>
            <CommitNavBar
              commits={props.commitList}
              selectedCommitHash={props.selectedCommit}
              onNavigate={props.onCommitNavigate}
              compact={true}
            />
          </div>
        </Show>
      </div>
      <Show when={selectedCommitInfo()}>
        {(commit) => (
          <div
            title={`${commit().hash.slice(0, 7)} ${commit().message}`}
            style={{
              padding: '4px 8px',
              'font-size': sf(11),
              'font-family': "'JetBrains Mono', monospace",
              color: theme.fgMuted,
              'border-bottom': `1px solid ${theme.border}`,
              'flex-shrink': '0',
              'white-space': 'nowrap',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
            }}
          >
            <span style={{ color: theme.accent, 'font-weight': '600' }}>
              {commit().hash.slice(0, 7)}
            </span>{' '}
            {commit().message}
          </div>
        )}
      </Show>
      <Show when={showUncommittedBanner()}>
        <div
          style={{
            padding: '4px 8px',
            'font-size': sf(11),
            'font-family': "'JetBrains Mono', monospace",
            color: theme.fgMuted,
            'border-bottom': `1px solid ${theme.border}`,
            'flex-shrink': '0',
            'white-space': 'nowrap',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
          }}
        >
          Uncommitted changes only
        </div>
      </Show>
      <div style={{ flex: '1', overflow: 'hidden' }}>
        <ChangedFilesList
          worktreePath={props.task.worktreePath}
          baseBranch={props.task.baseBranch}
          isActive={props.isActive}
          panelFocused={isPanelFocused(props.task.id, 'changed-files')}
          coverageReportPath={coverageReportPath()}
          selectedCommit={props.selectedCommit}
          onFileClick={(file) => props.onDiffFileClick(file.path)}
          onOpenInEditorClick={focusChangedFilesPanel}
          ref={(el) => (changedFilesRef = el)}
        />
      </div>
    </div>
  );
}
