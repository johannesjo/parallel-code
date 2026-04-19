import { Show, createSignal, createEffect, onCleanup } from 'solid-js';
import { Dialog } from './Dialog';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { createDialogScroll } from '../lib/dialog-scroll';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { parseUnifiedDiff } from '../lib/unified-diff-parser';
import { evictStaleAnnotations } from '../lib/review-eviction';
import { ScrollingDiffView } from './ScrollingDiffView';
import { CommitNavBar } from './CommitNavBar';
import { ReviewCommentsButton, ReviewSidebarPanel } from './ReviewSidebarPanel';
import { ReviewProvider, useReview } from './ReviewProvider';
import type { FileDiff } from '../lib/unified-diff-parser';
import type { ReviewAnnotation } from './review-types';
import type { CommitInfo } from '../ipc/types';
import type { GitIsolationMode } from '../store/types';

interface DiffViewerDialogProps {
  /** Which file to auto-scroll to (the one the user clicked). Null = closed. */
  scrollToFile: string | null;
  worktreePath: string;
  onClose: () => void;
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
  /** Currently selected commit hash, or null for "all changes" mode */
  selectedCommit?: string | null;
  /** Callback to navigate to a different commit or null for all changes */
  onCommitNavigate?: (hash: string | null) => void;
  /** Git isolation mode — CommitNavBar is only shown for worktree-isolated tasks */
  gitIsolation?: GitIsolationMode;
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
  return (
    <Dialog
      open={props.scrollToFile !== null}
      onClose={props.onClose}
      width="90vw"
      panelStyle={{
        height: '85vh',
        'max-width': '1400px',
        overflow: 'hidden',
        padding: '0',
        gap: '0',
      }}
    >
      <Show when={props.scrollToFile !== null}>
        <ReviewProvider
          taskId={props.taskId}
          agentId={props.agentId}
          compilePrompt={compileDiffReview}
          onSubmitted={props.onClose}
        >
          <DiffViewerContent
            scrollToFile={props.scrollToFile}
            worktreePath={props.worktreePath}
            onClose={props.onClose}
            projectRoot={props.projectRoot}
            branchName={props.branchName}
            baseBranch={props.baseBranch}
            taskId={props.taskId}
            agentId={props.agentId}
            commitList={props.commitList}
            selectedCommit={props.selectedCommit}
            onCommitNavigate={props.onCommitNavigate}
            gitIsolation={props.gitIsolation}
          />
        </ReviewProvider>
      </Show>
    </Dialog>
  );
}

/** Inner content rendered inside ReviewProvider so it can call useReview(). */
function DiffViewerContent(props: DiffViewerDialogProps) {
  const review = useReview();

  const [parsedFiles, setParsedFiles] = createSignal<FileDiff[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [searchQuery, setSearchQuery] = createSignal('');

  let fetchGeneration = 0;
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
    const scrollTarget = props.scrollToFile;
    // Access selectedCommit before the early return so the effect tracks it
    // even when the dialog is closed — ensures we re-run on reopen.
    const commitHash = props.selectedCommit;
    if (!scrollTarget) return;

    const worktreePath = props.worktreePath;
    const projectRoot = props.projectRoot;
    const branchName = props.branchName;
    const baseBranch = props.baseBranch;
    const thisGen = ++fetchGeneration;

    setSearchQuery('');
    setLoading(true);
    setError('');
    setParsedFiles([]);

    let diffPromise: Promise<string>;

    if (commitHash && worktreePath) {
      // Single-commit mode
      diffPromise = invoke<string>(IPC.GetCommitDiffs, { worktreePath, commitHash });
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
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not load diffs: ${msg}`);
      });
    }

    diffPromise
      .then((rawDiff) => {
        if (thisGen !== fetchGeneration) return;
        const newFiles = parseUnifiedDiff(rawDiff);
        setParsedFiles(newFiles);
        review.replaceAnnotations((prev) => evictStaleAnnotations(prev, newFiles));
      })
      .catch((err) => {
        if (thisGen !== fetchGeneration) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (thisGen === fetchGeneration) setLoading(false);
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

  const countMatches = () => {
    const q = searchQuery().toLowerCase();
    if (!q) return 0;
    let count = 0;
    for (const file of parsedFiles()) {
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          let idx = 0;
          const lower = line.content.toLowerCase();
          while ((idx = lower.indexOf(q, idx)) !== -1) {
            count++;
            idx += q.length;
          }
        }
      }
    }
    return count;
  };

  return (
    <div ref={containerRef} style={{ display: 'flex', 'flex-direction': 'column', height: '100%' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '10px',
          padding: '12px 20px',
          'border-bottom': `1px solid ${theme.border}`,
          'flex-shrink': '0',
        }}
      >
        <Show when={props.worktreePath && props.gitIsolation === 'worktree'}>
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

        <span style={{ flex: '1' }} />

        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search..."
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
          style={{
            background: 'rgba(255,255,255,0.06)',
            border: `1px solid ${theme.borderSubtle}`,
            'border-radius': '4px',
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
            'border-radius': '4px',
          }}
          title="Close"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: '1', overflow: 'hidden', display: 'flex' }}>
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
              scrollToPath={props.scrollToFile}
              worktreePath={props.worktreePath}
              baseBranch={props.baseBranch}
              searchQuery={searchQuery()}
              reviewAnnotations={review.annotations()}
              onAnnotationAdd={review.addAnnotation}
              onAnnotationDismiss={review.dismissAnnotation}
              onAnnotationUpdate={review.updateAnnotation}
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
