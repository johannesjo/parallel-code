import { Show, createSignal, createEffect, createUniqueId, onCleanup } from 'solid-js';
import { Dialog } from './Dialog';
import { errMessage } from '../lib/log';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { createDialogScroll } from '../lib/dialog-scroll';
import {
  createDiffIdentity,
  createRequestGenerationGuard,
  createReviewIdentity,
} from '../lib/diff-review-lifecycle';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { parseUnifiedDiff } from '../lib/unified-diff-parser';
import { countSearchMatches } from '../lib/diff-collapse';
import { type QualityFindingProvider } from '../lib/quality-findings';
import { windowChromeTopInset } from '../lib/platform';
import { ScrollingDiffView } from './ScrollingDiffView';
import {
  CommitNavBar,
  type CommitSelection,
  isCommitHashSelection,
  isUncommittedSelection,
} from './CommitNavBar';
import {
  ReviewCommentsButton,
  ReviewFindingsRefreshButton,
  ReviewSidebarPanel,
} from './ReviewSidebarPanel';
import { ReviewProvider, useReview } from './ReviewProvider';
import { ChangedFilesList } from './ChangedFilesList';
import { CloseIcon } from './icons';
import type { FileDiff } from '../lib/unified-diff-parser';
import type { ReviewAnnotation } from './review-types';
import type { CommitInfo } from '../ipc/types';
import type { GitIsolationMode } from '../store/types';

interface DiffViewerDialogProps {
  /** Which file to auto-scroll to (the one the user clicked). Null = closed. */
  scrollToFile: string | null;
  /** Visible task title shown while reviewing changes. */
  taskName?: string;
  worktreePath: string;
  onClose: () => void;
  /** Optional coverage artifact path relative to the repo root. */
  coverageReportPath?: string;
  /** Project root for branch-based fallback when worktree doesn't exist */
  projectRoot?: string;
  /** Branch name for branch-based fallback when worktree doesn't exist */
  branchName?: string | null;
  /** Base branch for diff comparison (e.g. 'main', 'develop'). Undefined = auto-detect. */
  baseBranch?: string;
  taskId?: string;
  agentId?: string;
  /** List of commits on this branch (oldest first) for commit navigation */
  commitList?: CommitInfo[];
  /** Current selection: null = all changes, sentinel = uncommitted-only, hash = single commit */
  selectedCommit?: CommitSelection;
  /** Callback to navigate to a different selection */
  onCommitNavigate?: (selection: CommitSelection) => void;
  /** Git isolation mode — CommitNavBar is only shown for worktree-isolated tasks */
  gitIsolation?: GitIsolationMode;
  /** Optional structured-finding source. Providers capture their own repository context. */
  findingProvider?: QualityFindingProvider;
}

/** Compile review annotations into a prompt string for the agent. */
export function compileDiffReview(annotations: ReviewAnnotation[]): string {
  const lines = ['Code review feedback for your changes:\n'];
  for (const a of annotations) {
    lines.push(`## ${a.filePath} (lines ${a.startLine}-${a.endLine})`);
    lines.push('```');
    lines.push(a.selectedText);
    lines.push('```');
    lines.push(a.comment);
    lines.push('');
  }
  return lines.join('\n');
}

export function DiffViewerDialog(props: DiffViewerDialogProps) {
  const titleId = createUniqueId();
  const reviewIdentity = () =>
    createReviewIdentity({
      taskId: props.taskId,
      worktreePath: props.worktreePath,
      projectRoot: props.projectRoot,
      branchName: props.branchName,
    });
  return (
    <ReviewProvider
      taskId={props.taskId}
      agentId={props.agentId}
      findingProvider={props.findingProvider}
      reviewIdentity={reviewIdentity()}
      open={props.scrollToFile !== null}
      compilePrompt={compileDiffReview}
      onSubmitted={props.onClose}
    >
      <Dialog
        open={props.scrollToFile !== null}
        onClose={props.onClose}
        width="100vw"
        labelledBy={titleId}
        panelStyle={{
          height: '100vh',
          'max-height': 'none',
          'max-width': 'none',
          'border-radius': '0',
          border: 'none',
          overflow: 'hidden',
          padding: '0',
          gap: '0',
        }}
      >
        <h2 id={titleId} class="dialog-sr-only">
          Diff viewer for {props.taskName ?? 'task'}: {props.scrollToFile ?? 'all changes'}
        </h2>
        <Show when={props.scrollToFile !== null}>
          <DiffViewerContent
            scrollToFile={props.scrollToFile}
            taskName={props.taskName}
            worktreePath={props.worktreePath}
            onClose={props.onClose}
            coverageReportPath={props.coverageReportPath}
            projectRoot={props.projectRoot}
            branchName={props.branchName}
            baseBranch={props.baseBranch}
            taskId={props.taskId}
            agentId={props.agentId}
            commitList={props.commitList}
            selectedCommit={props.selectedCommit}
            onCommitNavigate={props.onCommitNavigate}
            gitIsolation={props.gitIsolation}
            findingProvider={props.findingProvider}
          />
        </Show>
      </Dialog>
    </ReviewProvider>
  );
}

/** Inner content rendered inside ReviewProvider so it can call useReview(). */
function DiffViewerContent(props: DiffViewerDialogProps) {
  const review = useReview();
  const headerPaddingTop = `${windowChromeTopInset + 12}px`;

  const [parsedFiles, setParsedFiles] = createSignal<FileDiff[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [searchQuery, setSearchQuery] = createSignal('');
  const [activeFilePath, setActiveFilePath] = createSignal<string | null>(null);

  const fetchGeneration = createRequestGenerationGuard();
  let searchInputRef: HTMLInputElement | undefined;
  let diffScrollRef: HTMLDivElement | undefined;
  let containerRef: HTMLDivElement | undefined;

  createDialogScroll(
    () => diffScrollRef,
    () => props.scrollToFile !== null,
  );

  // Ctrl+F / Cmd+F handler to focus the search input
  createEffect(() => {
    if (props.scrollToFile === null) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchInputRef?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    onCleanup(() => document.removeEventListener('keydown', handler));
  });

  createEffect(() => {
    setActiveFilePath(props.scrollToFile);
  });

  createEffect(() => {
    const scrollTarget = props.scrollToFile;
    // Access selectedCommit before the early return so the effect tracks it
    // even when the dialog is closed — ensures we re-run on reopen.
    const selection = props.selectedCommit;
    if (!scrollTarget) return;

    const worktreePath = props.worktreePath;
    const projectRoot = props.projectRoot;
    const branchName = props.branchName;
    const baseBranch = props.baseBranch;
    const reviewIdentity = createReviewIdentity({
      taskId: props.taskId,
      worktreePath,
      projectRoot,
      branchName,
    });
    const thisGen = fetchGeneration.begin();

    onCleanup(() => {
      fetchGeneration.invalidate();
      review.suspendDiffLoad();
    });

    review.beginDiffLoad();
    setSearchQuery('');
    setLoading(true);
    setError('');
    setParsedFiles([]);

    let diffPromise: Promise<string>;

    if (isCommitHashSelection(selection) && worktreePath) {
      // Single-commit mode
      diffPromise = invoke<string>(IPC.GetCommitDiffs, {
        worktreePath,
        commitHash: selection,
      });
    } else if (isUncommittedSelection(selection) && worktreePath) {
      // Uncommitted-only mode (worktree only — branch fallback has no working tree)
      diffPromise = invoke<string>(IPC.GetUncommittedFileDiffs, { worktreePath });
    } else {
      // All-changes mode (existing behavior)
      const worktreePromise = worktreePath
        ? invoke<string>(IPC.GetAllFileDiffs, { worktreePath, baseBranch })
        : Promise.reject(new Error('no worktree'));

      diffPromise = worktreePromise.catch((err: unknown) => {
        if (projectRoot && branchName) {
          return invoke<string>(IPC.GetAllFileDiffsFromBranch, {
            projectRoot,
            branchName,
            baseBranch,
          });
        }
        const msg = errMessage(err);
        throw new Error(`Could not load diffs: ${msg}`);
      });
    }

    diffPromise
      .then(async (rawDiff) => {
        if (!fetchGeneration.isCurrent(thisGen)) return;
        const newFiles = parseUnifiedDiff(rawDiff);
        const diffIdentity = await createDiffIdentity(reviewIdentity, rawDiff);
        if (!fetchGeneration.isCurrent(thisGen)) return;
        setParsedFiles(newFiles);
        review.completeDiffLoad(diffIdentity, newFiles);
      })
      .catch((err) => {
        if (!fetchGeneration.isCurrent(thisGen)) return;
        setError(errMessage(err));
      })
      .finally(() => {
        if (fetchGeneration.isCurrent(thisGen)) setLoading(false);
      });
  });

  const totalAdded = () =>
    parsedFiles().reduce(
      (sum, f) =>
        sum + f.hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === 'add').length, 0),
      0,
    );

  const totalRemoved = () =>
    parsedFiles().reduce(
      (sum, f) =>
        sum + f.hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === 'remove').length, 0),
      0,
    );

  const countMatches = () => countSearchMatches(parsedFiles(), searchQuery());

  return (
    <div ref={containerRef} style={{ display: 'flex', 'flex-direction': 'column', height: '100%' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '10px',
          padding: `${headerPaddingTop} 20px 12px`,
          'border-bottom': `1px solid ${theme.border}`,
          'flex-shrink': '0',
          'user-select': 'none',
        }}
      >
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '8px',
            'min-width': '180px',
            'max-width': '32vw',
            overflow: 'hidden',
            'flex-shrink': '1',
          }}
          title={props.taskName ?? 'Changes'}
        >
          <span
            style={{
              'font-size': sf(12),
              color: theme.fgMuted,
              'text-transform': 'uppercase',
              'letter-spacing': '0.06em',
              'flex-shrink': '0',
            }}
          >
            Changes
          </span>
          <span
            style={{
              'font-size': sf(14),
              color: theme.fg,
              'font-weight': '700',
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
            }}
          >
            {props.taskName ?? 'Untitled task'}
          </span>
        </div>

        <Show
          when={
            props.worktreePath &&
            (props.gitIsolation === 'worktree' || props.gitIsolation === 'direct')
          }
        >
          <CommitNavBar
            commits={props.commitList ?? []}
            selectedCommitHash={props.selectedCommit ?? null}
            onNavigate={(hash) => props.onCommitNavigate?.(hash)}
            showMessage={true}
          />
          <span
            style={{
              width: '1px',
              height: '16px',
              background: theme.border,
              'flex-shrink': '0',
              margin: '0 4px',
            }}
          />
        </Show>

        <span
          style={{
            'font-size': sf(14),
            color: theme.fg,
            'font-weight': '600',
          }}
        >
          {parsedFiles().length} files changed
        </span>
        <span
          style={{
            'font-size': sf(13),
            color: theme.success,
            'font-family': "'JetBrains Mono', monospace",
          }}
        >
          +{totalAdded()}
        </span>
        <span
          style={{
            'font-size': sf(13),
            color: theme.error,
            'font-family': "'JetBrains Mono', monospace",
          }}
        >
          -{totalRemoved()}
        </span>

        <ReviewCommentsButton />
        <Show when={props.findingProvider}>
          <ReviewFindingsRefreshButton />
        </Show>

        <span style={{ flex: '1' }} />

        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search..."
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
          style={{
            background: 'color-mix(in srgb, var(--fg) 6%, transparent)',
            border: `1px solid ${theme.borderSubtle}`,
            'border-radius': 'var(--radius-xs)',
            color: theme.fg,
            'font-size': sf(13),
            'font-family': "'JetBrains Mono', monospace",
            padding: '3px 8px',
            width: '200px',
            outline: 'none',
          }}
        />
        <Show when={searchQuery().length > 0}>
          <span style={{ 'font-size': sf(12), color: theme.fgSubtle, 'white-space': 'nowrap' }}>
            {countMatches()} matches
          </span>
        </Show>

        <button
          onClick={() => props.onClose()}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: 'pointer',
            padding: '4px',
            display: 'flex',
            'align-items': 'center',
            'border-radius': 'var(--radius-xs)',
          }}
          title="Close"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: '1', overflow: 'hidden', display: 'flex' }}>
        <aside
          style={{
            width: '300px',
            'min-width': '240px',
            'max-width': '34vw',
            display: 'flex',
            'flex-direction': 'column',
            background: theme.taskPanelBg,
            'border-right': `1px solid ${theme.border}`,
            'flex-shrink': '0',
          }}
        >
          <div
            style={{
              padding: '8px 10px',
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
              'user-select': 'none',
            }}
          >
            Changed Files
          </div>
          <div style={{ flex: '1', overflow: 'hidden' }}>
            <ChangedFilesList
              worktreePath={props.worktreePath}
              baseBranch={props.baseBranch}
              isActive={props.scrollToFile !== null}
              panelFocused={false}
              coverageReportPath={props.coverageReportPath}
              projectRoot={props.projectRoot}
              branchName={props.branchName}
              selectedCommit={props.selectedCommit}
              activeFilePath={activeFilePath()}
              onFileClick={(file) => setActiveFilePath(file.path)}
            />
          </div>
        </aside>

        <div style={{ flex: '1', overflow: 'hidden' }}>
          <Show when={loading()}>
            <div
              style={{
                padding: '40px',
                'text-align': 'center',
                color: theme.fgMuted,
                'font-size': sf(14),
              }}
            >
              Loading diffs...
            </div>
          </Show>

          <Show when={error()}>
            <div
              style={{
                padding: '40px',
                'text-align': 'center',
                color: theme.error,
                'font-size': sf(14),
              }}
            >
              {error()}
            </div>
          </Show>

          <Show when={!loading() && !error()}>
            <ScrollingDiffView
              files={parsedFiles()}
              scrollToPath={activeFilePath()}
              worktreePath={props.worktreePath}
              baseBranch={props.baseBranch}
              searchQuery={searchQuery()}
              scrollToAnnotation={review.scrollTarget()}
              onScrollRef={(el) => {
                diffScrollRef = el;
              }}
            />
          </Show>
        </div>

        <ReviewSidebarPanel />
      </div>
    </div>
  );
}
