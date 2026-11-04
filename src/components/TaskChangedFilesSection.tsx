import { Show, createSignal, onMount } from 'solid-js';
import {
  getProject,
  setActiveTask,
  setTaskFocusedPanel,
  isPanelFocused,
  openCanvasDocument,
} from '../store/store';
import { isTaskWorking } from '../store/taskStatus';
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
import { SUPPORT_PANE_MIN_HEIGHT } from '../lib/layout-sizes';
import { useFocusRegistration } from '../lib/focus-registration';
import type { Task } from '../store/types';
import type { ChangedFile, CommitInfo } from '../ipc/types';
import type { ChangeTourController } from '../lib/create-change-tour';
import type { UnderstandingTourState } from '../lib/create-understanding-tour';
import { getTaskDiffBaseBranch } from '../lib/load-task-diff';
import { ChangeTourButton } from './ChangeTourButton';
import { FeatureHint } from './FeatureHint';
import { askCodeModelLabel } from './understanding/ask-code-label';

interface TaskChangedFilesSectionProps {
  tour?: ChangeTourController;
  onTourClick?: () => void;
  tourDisabled?: boolean;
  task: Task;
  isActive: boolean;
  commitList: CommitInfo[];
  selectedCommit: CommitSelection;
  onCommitNavigate: (selection: CommitSelection) => void;
  onDiffFileClick: (path: string) => void;
  onFilesChange?: (files: ChangedFile[]) => void;
  /** Starts a guided tour of a changed file; omit to hide the row action. */
  onUnderstandClick?: (file: ChangedFile) => void;
  /** Lets each row's tour button show its own generating/ready state. */
  understanding?: UnderstandingTourState;
}

export function TaskChangedFilesSection(props: TaskChangedFilesSectionProps) {
  const coverageReportPath = () => getProject(props.task.projectId)?.coverageReportPath;
  const diffBaseBranch = () =>
    getTaskDiffBaseBranch(props.task.gitIsolation, props.task.baseBranch);
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
  const openMarkdownInCanvas = (file: ChangedFile) => {
    setActiveTask(props.task.id);
    openCanvasDocument(props.task.id, file.path);
    setTaskFocusedPanel(props.task.id, 'canvas');
  };

  let changedFilesRef: HTMLDivElement | undefined;
  let tourAnchor: HTMLDivElement | undefined;

  onMount(() => {
    const id = props.task.id;
    useFocusRegistration(`${id}:changed-files`, () => {
      changedFilesRef?.focus();
    });
  });

  // The heading carries the summary, so the list drops its own totals footer.
  const [fileCount, setFileCount] = createSignal(0);
  const [totals, setTotals] = createSignal({ added: 0, removed: 0 });
  const [uncommittedCount, setUncommittedCount] = createSignal<number | null>(null);
  const headingLabel = () => {
    const count = fileCount();
    if (count === 0) return 'No changes yet';
    // The pane is the changed-files pane, so "changed" only cost room in narrow columns.
    return `${count} file${count === 1 ? '' : 's'}`;
  };

  return (
    <div
      class="task-changed-files-section focusable-panel"
      data-panel-focused={isPanelFocused(props.task.id, 'changed-files') ? 'true' : 'false'}
      style={{
        // `height: 100%` fills when the panel is an absorber (notes-split
        // horizontal, 50/50 with notes; split-right without shells). `min-height`
        // gives the content-sized case (split-right with shells) a usable
        // default. The ResizablePanel wrapper caps unpinned auto-growth, so no
        // cap here: it would stop an absorber or a dragged pin from growing.
        height: '100%',
        'min-height': `${SUPPORT_PANE_MIN_HEIGHT}px`,
        'min-width': '0',
        background: theme.taskPanelBg,
        display: 'flex',
        'flex-direction': 'column',
      }}
      onPointerDown={focusChangedFilesPanel}
    >
      <div class="task-pane-heading" style={{ 'font-size': sf(11) }}>
        <span
          title={headingLabel()}
          style={{
            flex: '1',
            'min-width': '0',
            overflow: 'hidden',
            'white-space': 'nowrap',
            'text-overflow': 'ellipsis',
          }}
        >
          {headingLabel()}
        </span>
        <Show when={fileCount() > 0}>
          <span style={{ display: 'flex', gap: '6px', 'flex-shrink': '0' }}>
            <span title={`${totals().added} added lines`} style={{ color: theme.success }}>
              +{totals().added}
            </span>
            <span title={`${totals().removed} removed lines`} style={{ color: theme.error }}>
              -{totals().removed}
            </span>
          </span>
        </Show>
        <Show when={hasCommitNav()}>
          <div style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'flex-shrink': '0' }}>
            <Show when={canShowTree()}>
              <CommitTreeOverlay
                commits={props.commitList}
                worktreePath={props.task.worktreePath}
                baseBranch={diffBaseBranch()}
                selectedCommit={props.selectedCommit}
                onSelectCommit={props.onCommitNavigate}
              />
            </Show>
            <CommitNavBar
              commits={props.commitList}
              selectedCommitHash={props.selectedCommit}
              onNavigate={props.onCommitNavigate}
              compact={true}
              uncommittedCount={uncommittedCount()}
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
      {/* A grid row gives the list's `height: 100%` a definite size even when
          the section is content-sized (focus-mode side column without shells);
          otherwise the list grows past the section and its footer is clipped. */}
      <div
        style={{
          flex: '1',
          overflow: 'hidden',
          display: 'grid',
          'grid-template-rows': 'minmax(0, 1fr)',
          'grid-template-columns': 'minmax(0, 1fr)',
        }}
      >
        <ChangedFilesList
          worktreePath={props.task.worktreePath}
          projectRoot={getProject(props.task.projectId)?.path}
          branchName={props.task.branchName}
          baseBranch={diffBaseBranch()}
          isActive={props.isActive}
          panelFocused={isPanelFocused(props.task.id, 'changed-files')}
          coverageReportPath={coverageReportPath()}
          selectedCommit={props.selectedCommit}
          onFileClick={(file) => props.onDiffFileClick(file.path)}
          onFilesChange={(files) => {
            setFileCount(files.length);
            props.onFilesChange?.(files);
          }}
          onTotalsChange={setTotals}
          onUncommittedCountChange={setUncommittedCount}
          hideTotals
          onOpenInEditorClick={focusChangedFilesPanel}
          onOpenMarkdownClick={openMarkdownInCanvas}
          onUnderstandClick={props.onUnderstandClick}
          understanding={props.understanding}
          ref={(el) => (changedFilesRef = el)}
        />
      </div>
      <Show when={props.tour}>
        {(tour) => (
          <div ref={tourAnchor} style={{ 'flex-shrink': '0' }}>
            <ChangeTourButton
              tour={tour()}
              disabled={props.tourDisabled}
              onClick={() => props.onTourClick?.()}
            />
            <FeatureHint
              id="change-tour"
              // A tour already generating or ready means the user found it, and
              // one of a diff the agent is still writing would soon be stale.
              when={
                props.isActive &&
                !props.tourDisabled &&
                !isTaskWorking(props.task.id) &&
                !tour().loading() &&
                tour().stops().length === 0
              }
              anchor={() => tourAnchor}
              title="Take a tour of these changes"
            >
              A short guided walkthrough of this task's diff, stop by stop. It generates in the
              background, so you can keep working, and sends the diff to {askCodeModelLabel()}.
            </FeatureHint>
          </div>
        )}
      </Show>
    </div>
  );
}
