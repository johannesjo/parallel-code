import { createSignal, createMemo, createEffect, onCleanup, batch, Index, Show } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { getStatusColor } from '../lib/status-colors';
import { openFileInEditor } from '../lib/shell';
import { buildFileTree, flattenVisibleTree } from '../lib/file-tree';
import {
  buildCoverageComparison,
  formatCoverageDelta,
  isBaselineInformational,
  type CoverageComparison,
  type CoverageFileComparison,
  type CoverageValue,
} from '../lib/coverage-comparison';
import {
  type CommitSelection,
  isCommitHashSelection,
  isUncommittedSelection,
} from './CommitNavBar';
import type { ChangedFile, CoverageFileSummary, CoverageSummary } from '../ipc/types';

interface ChangedFilesListProps {
  worktreePath: string;
  isActive?: boolean;
  panelFocused?: boolean;
  onFileClick?: (file: ChangedFile) => void;
  /** Optional path to visually mark as the active/open diff target. */
  activeFilePath?: string | null;
  onOpenInEditorClick?: () => void;
  ref?: (el: HTMLDivElement) => void;
  /** Optional coverage artifact path relative to the repo root. */
  coverageReportPath?: string;
  /** Project root for branch-based fallback when worktree doesn't exist */
  projectRoot?: string;
  /** Branch name for branch-based fallback when worktree doesn't exist */
  branchName?: string | null;
  /** Base branch for diff comparison (e.g. 'main', 'develop'). Undefined = auto-detect. */
  baseBranch?: string;
  /** Reports coverage changes when task or base coverage data refreshes. */
  onCoverageComparisonChange?: (comparison: CoverageComparison | null) => void;
  /** Reports the number of listed files whenever the list refreshes. */
  onFileCountChange?: (count: number) => void;
  /**
   * Selection mode for the file list:
   * - undefined/null: all changes (committed + uncommitted)
   * - UNCOMMITTED_SELECTION: only currently uncommitted changes
   * - any commit hash: files for that single commit
   */
  selectedCommit?: CommitSelection;
}

const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/i;
const TEST_FILE_RE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i;

function isCoverageCandidate(file: ChangedFile): boolean {
  return (
    SOURCE_FILE_RE.test(file.path) && !TEST_FILE_RE.test(file.path) && !file.path.endsWith('.d.ts')
  );
}

export function isCoverageEligible(file: ChangedFile): boolean {
  return file.status !== 'D' && isCoverageCandidate(file);
}

function sameChangedFiles(left: ChangedFile[] | null, right: ChangedFile[] | null): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((file, index) => {
    const other = right[index];
    return (
      file.path === other.path &&
      file.previous_path === other.previous_path &&
      file.lines_added === other.lines_added &&
      file.lines_removed === other.lines_removed &&
      file.status === other.status &&
      file.committed === other.committed
    );
  });
}

function sameCoverageSummary(left: CoverageSummary | null, right: CoverageSummary | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.format === right.format &&
      left.reportPath === right.reportPath &&
      left.generatedAt === right.generatedAt)
  );
}

export function coverageFooterLabel(
  hasCoverageArtifact: boolean,
  touchedCoveragePct: number | null,
  hasMatchedCoverage: boolean,
): string {
  if (!hasCoverageArtifact) return '⊘';
  if (hasMatchedCoverage && touchedCoveragePct === null) return '◌';
  if (touchedCoveragePct === null) return '∅';
  return `◔ ${touchedCoveragePct}%`;
}

export function filesFooterLabel(fileCount: number, uncommittedCount: number): string {
  return uncommittedCount > 0 ? `▤ ${fileCount}·${uncommittedCount}u` : `▤ ${fileCount}`;
}

export function filesFooterTitle(fileCount: number, uncommittedCount: number): string {
  return uncommittedCount > 0
    ? `${fileCount} changed files, ${uncommittedCount} uncommitted.`
    : `${fileCount} changed files.`;
}

export function coverageFooterTitle(
  coverageSummary: CoverageSummary | null,
  touchedCoveragePct: number | null,
  hasMatchedCoverage: boolean,
): string {
  if (!coverageSummary) {
    return 'Run coverage and write either coverage/coverage-summary.json, coverage/lcov.info, or the configured project report path.';
  }
  if (hasMatchedCoverage && touchedCoveragePct === null) {
    return `${coverageSummary.format === 'lcov' ? 'LCOV' : 'Coverage summary'} loaded, but the matched changed files had no executable lines to measure.`;
  }
  if (touchedCoveragePct === null) {
    return `${coverageSummary.format === 'lcov' ? 'LCOV' : 'Coverage summary'} loaded, but none of the changed eligible files matched entries in the report.`;
  }
  return `${coverageSummary.format === 'lcov' ? 'LCOV' : 'Coverage summary'} updated ${coverageSummary.generatedAt ?? 'unknown time'}`;
}

function coverageColor(pct: number): string {
  if (pct >= 80) return theme.success;
  if (pct >= 60) return theme.warning;
  return theme.error;
}

function coverageBadgeTitle(summary: CoverageFileSummary): string {
  return `Lines ${summary.lines.pct}% · Branches ${summary.branches.pct}% · Functions ${summary.functions.pct}% · Statements ${summary.statements.pct}%`;
}

function coverageValueLabel(value: CoverageValue): string {
  if (value.state === 'available') return `${value.pct}%`;
  if (value.state === 'no-executable-lines') return 'no lines';
  if (value.state === 'file-not-present') return 'not present';
  return 'no report';
}

function deltaColor(delta: number): string {
  if (delta > 0) return theme.success;
  if (delta < 0) return theme.error;
  return theme.fgMuted;
}

function comparisonBadge(
  comparison: CoverageFileComparison,
  baseline: CoverageComparison['baseline'],
): { label: string; color: string; title: string } | null {
  const taskLabel = coverageValueLabel(comparison.task);
  const baseLabel = coverageValueLabel(comparison.base);
  const baselineInformational = isBaselineInformational(baseline);
  const baselineBranch = baseline?.baseBranch ?? 'base branch';
  const baselineDetail = baseline?.taskStale
    ? ' The task report predates task HEAD, so this delta is informational only.'
    : baseline?.taskUnanchored
      ? ' The task report cannot be anchored to task HEAD, so this delta is informational only.'
      : baseline?.stale
        ? ` The base report predates ${baselineBranch} as currently checked out, so this delta is informational only.`
        : baseline?.unanchored
          ? ` The base report cannot be anchored to ${baselineBranch} as currently checked out, so this delta is informational only.`
          : '';
  const renameDetail =
    comparison.kind === 'renamed' ? ` (${comparison.basePath} → ${comparison.path})` : '';

  if (comparison.kind === 'deleted') {
    if (comparison.base.state === 'no-report') return null;
    return {
      label: comparison.base.state === 'available' ? `del ${baseLabel}` : 'deleted',
      color: theme.fgMuted,
      title: `Deleted file${renameDetail}. Base: ${baseLabel}; task: not present.`,
    };
  }

  if (comparison.task.state === 'no-executable-lines') {
    return {
      label: 'no lines',
      color: theme.fgMuted,
      title: `Task: no executable lines; base: ${baseLabel}${renameDetail}.`,
    };
  }

  if (comparison.task.state === 'no-report' && comparison.base.state !== 'no-report') {
    return {
      label: 'no report',
      color: theme.fgMuted,
      title: `No task coverage report; base: ${baseLabel}${renameDetail}.`,
    };
  }

  if (comparison.task.state !== 'available') return null;

  if (comparison.delta !== null) {
    return {
      label: `${taskLabel} ${formatCoverageDelta(comparison.delta)}`,
      color: baselineInformational ? theme.fgMuted : deltaColor(comparison.delta),
      title: `Task: ${taskLabel}; base: ${baseLabel}; delta: ${formatCoverageDelta(comparison.delta)}${renameDetail}.${baselineDetail}`,
    };
  }

  const kindLabel =
    comparison.kind === 'new' ? ' new' : comparison.kind === 'renamed' ? ' renamed' : '';
  return {
    label: `${taskLabel}${kindLabel}`,
    color: coverageColor(comparison.task.pct ?? 0),
    title: `Task: ${taskLabel}; base: ${baseLabel}${renameDetail}.`,
  };
}

export function FileCoverageBadge(props: {
  file: ChangedFile;
  selectedCommit?: CommitSelection;
  summary?: CoverageFileSummary;
  comparison?: CoverageFileComparison;
  baseline?: CoverageComparison['baseline'];
  hasCoverageArtifact: boolean;
}) {
  const isCandidate = () =>
    !isCommitHashSelection(props.selectedCommit) && isCoverageCandidate(props.file);
  const summary = () => (isCandidate() ? props.summary : undefined);
  const badge = () =>
    isCandidate() && props.comparison ? comparisonBadge(props.comparison, props.baseline) : null;

  return (
    <>
      <Show when={badge()} keyed>
        {(coverageBadge) => (
          <span
            title={
              summary()
                ? `${coverageBadge.title} ${coverageBadgeTitle(summary() as CoverageFileSummary)}`
                : coverageBadge.title
            }
            style={{
              color: coverageBadge.color,
              'font-size': sf(11),
              'flex-shrink': '0',
              padding: '1px 5px',
              'border-radius': '999px',
              border: `1px solid color-mix(in srgb, ${coverageBadge.color} 30%, transparent)`,
              background: `color-mix(in srgb, ${coverageBadge.color} 12%, transparent)`,
            }}
          >
            {coverageBadge.label}
          </span>
        )}
      </Show>
      <Show when={!badge() && summary()} keyed>
        {(coverageSummary) => (
          <span
            title={coverageBadgeTitle(coverageSummary)}
            style={{
              color: coverageColor(coverageSummary.lines.pct),
              'font-size': sf(11),
              'flex-shrink': '0',
              padding: '1px 5px',
              'border-radius': '999px',
              border: `1px solid color-mix(in srgb, ${coverageColor(coverageSummary.lines.pct)} 30%, transparent)`,
              background: `color-mix(in srgb, ${coverageColor(coverageSummary.lines.pct)} 12%, transparent)`,
            }}
          >
            {coverageSummary.lines.pct}%
          </span>
        )}
      </Show>
      <Show
        when={
          props.hasCoverageArtifact &&
          isCandidate() &&
          props.file.status !== 'D' &&
          !badge() &&
          !props.summary
        }
      >
        <span
          title="No recent coverage data for this source file. Run npm run test:coverage to populate the radar."
          style={{
            color: theme.error,
            'font-size': sf(11),
            'flex-shrink': '0',
            padding: '1px 5px',
            'border-radius': '999px',
            border: `1px solid color-mix(in srgb, ${theme.error} 30%, transparent)`,
            background: `color-mix(in srgb, ${theme.error} 10%, transparent)`,
          }}
        >
          no cov
        </span>
      </Show>
    </>
  );
}

async function resolveCoverageWorktree(
  projectRoot: string | undefined,
  branchName: string,
): Promise<{ path: string; headCommittedAt: string | null } | null> {
  if (!projectRoot) return null;
  return invoke<{
    path: string;
    headCommittedAt: string | null;
  } | null>(IPC.GetBranchWorktreePath, {
    projectRoot,
    branchName,
  }).catch(() => null);
}

async function resolveBaseCoverageRoot(
  projectRoot: string | undefined,
  baseBranch: string,
  taskRoot: string,
): Promise<{ path: string; headCommittedAt: string | null } | null> {
  const baseWorktree = await resolveCoverageWorktree(projectRoot, baseBranch);
  if (!baseWorktree || baseWorktree.path === taskRoot) return null;
  return baseWorktree;
}

function OpenInEditorButton(props: {
  worktreePath: string;
  filePath: string;
  onOpenInEditorClick?: () => void;
}) {
  return (
    <button
      class="changed-files-open-editor-btn"
      onClick={(e) => {
        e.stopPropagation();
        props.onOpenInEditorClick?.();
        void openFileInEditor(props.worktreePath, props.filePath);
      }}
      onKeyDown={(e) => e.stopPropagation()}
      tabIndex={-1}
      disabled={!props.worktreePath}
      style={{
        background: `color-mix(in srgb, ${theme.bgElevated} 92%, transparent)`,
        border: 'none',
        color: theme.fgMuted,
        cursor: props.worktreePath ? 'pointer' : 'default',
        padding: '4px',
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        'border-radius': 'var(--radius-xs)',
      }}
      title="Open in editor"
      aria-label={`Open ${props.filePath} in editor`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M3.5 2a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3a.75.75 0 0 1 1.5 0v3A3 3 0 0 1 12.5 16h-9A3 3 0 0 1 0 12.5v-9A3 3 0 0 1 3.5 0h3a.75.75 0 0 1 0 1.5h-3ZM10 .75a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0V2.56L8.53 8.53a.75.75 0 0 1-1.06-1.06L13.44 1.5H10.75A.75.75 0 0 1 10 .75Z" />
      </svg>
    </button>
  );
}

export function ChangedFilesList(props: ChangedFilesListProps) {
  const [files, setFiles] = createSignal<ChangedFile[]>([]);
  createEffect(() => props.onFileCountChange?.(files().length));
  const [comparisonFiles, setComparisonFiles] = createSignal<ChangedFile[] | null>(null);
  const [coverage, setCoverage] = createSignal<CoverageSummary | null>(null);
  const [baseCoverage, setBaseCoverage] = createSignal<CoverageSummary | null>(null);
  const [baseHeadAt, setBaseHeadAt] = createSignal<string | null>(null);
  const [taskHeadAt, setTaskHeadAt] = createSignal<string | null>(null);
  const [baseBranchName, setBaseBranchName] = createSignal<string | undefined>();
  const [comparisonInventoryState, setComparisonInventoryState] =
    createSignal<NonNullable<CoverageComparison['inventoryState']>>('loading');
  const [canOpenFilesInEditor, setCanOpenFilesInEditor] = createSignal(false);
  const [selectedIndex, setSelectedIndex] = createSignal(-1);
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const rowRefs: HTMLDivElement[] = [];

  const tree = createMemo(() => buildFileTree(files()));
  const visibleRows = createMemo(() => flattenVisibleTree(tree(), collapsed()));
  const coverageFiles = createMemo(() => coverage()?.files ?? {});
  const hasCoverageArtifact = createMemo(() => coverage() !== null);
  const hasBaseCoverageArtifact = createMemo(() => baseCoverage() !== null);
  const eligibleFiles = createMemo(() => files().filter((file) => isCoverageEligible(file)));
  const showCoverageFooter = createMemo(
    () =>
      !isCommitHashSelection(props.selectedCommit) &&
      (files().some((file) => isCoverageCandidate(file)) ||
        hasCoverageArtifact() ||
        hasBaseCoverageArtifact()),
  );
  const coverageComparison = createMemo(() => {
    const inventory = comparisonFiles();
    const taskReport = coverage();
    const baseReport = baseCoverage();
    if (isCommitHashSelection(props.selectedCommit)) return null;
    if (!inventory && !taskReport && !baseReport) return null;
    const comparison = buildCoverageComparison(
      taskReport,
      baseReport,
      inventory ?? [],
      baseHeadAt(),
      baseBranchName(),
      taskHeadAt(),
    );
    const inventoryState = inventory ? 'available' : comparisonInventoryState();

    if (!inventory) {
      return {
        ...comparison,
        files: Object.create(null) as Record<string, CoverageFileComparison>,
        impactedUnchangedFiles: [],
        inventoryState,
      };
    }

    return {
      ...comparison,
      inventoryState,
    };
  });
  const coveredEligibleFiles = createMemo(() =>
    eligibleFiles().filter((file) => Boolean(coverageFiles()[file.path])),
  );
  const hasMatchedCoverage = createMemo(() => coveredEligibleFiles().length > 0);
  const missingCoverageCount = createMemo(() =>
    hasCoverageArtifact() ? eligibleFiles().length - coveredEligibleFiles().length : 0,
  );
  const lowCoverageCount = createMemo(
    () =>
      coveredEligibleFiles().filter((file) => (coverageFiles()[file.path]?.lines.pct ?? 0) < 60)
        .length,
  );
  const touchedCoveragePct = createMemo(() => {
    const covered = coveredEligibleFiles();
    let totalLines = 0;
    let coveredLines = 0;
    for (const file of covered) {
      const summary = coverageFiles()[file.path];
      if (!summary) continue;
      totalLines += summary.lines.total;
      coveredLines += summary.lines.covered;
    }
    if (totalLines === 0) return null;
    return Math.round((coveredLines / totalLines) * 100);
  });
  const aggregateCoverageLabel = createMemo(() => {
    const comparison = coverageComparison()?.aggregate;
    if (!comparison) return null;
    if (!hasBaseCoverageArtifact()) return null;
    const delta = comparison.delta === null ? '' : ` (${formatCoverageDelta(comparison.delta)})`;
    return `base ${coverageValueLabel(comparison.base)} → task ${coverageValueLabel(comparison.task)}${delta}`;
  });
  const aggregateCoverageTitle = createMemo(() => {
    const comparison = coverageComparison();
    const taskReport = coverage();
    const baseReport = baseCoverage();
    if (!baseReport || !comparison) return '';
    const lines = [
      `Base: ${coverageValueLabel(comparison.aggregate.base)} (${baseReport.reportPath}, updated ${baseReport.generatedAt ?? 'unknown time'}).`,
      taskReport
        ? `Task: ${coverageValueLabel(comparison.aggregate.task)} (${taskReport.reportPath}, updated ${taskReport.generatedAt ?? 'unknown time'}).`
        : 'Task: no coverage report.',
    ];
    if (comparison.aggregate.delta !== null) {
      lines.push(`Delta: ${formatCoverageDelta(comparison.aggregate.delta)}.`);
    }
    if (comparison.inventoryState === 'loading') {
      lines.push(
        'The changed-file inventory is still loading, so merge readiness ignores the comparison.',
      );
    } else if (comparison.inventoryState === 'failed') {
      lines.push(
        'The changed-file inventory is unavailable, so merge readiness ignores the comparison.',
      );
    }
    if (comparison.baseline?.taskUnanchored) {
      lines.push(
        'The task report cannot be anchored to task HEAD, so merge readiness ignores the delta.',
      );
    } else if (comparison.baseline?.taskStale) {
      lines.push('The task report predates task HEAD, so merge readiness ignores the delta.');
    }
    if (comparison.baseline?.unanchored) {
      lines.push(
        `The base report cannot be anchored to ${comparison.baseline.baseBranch ?? 'the base branch'} as currently checked out, so merge readiness ignores the delta.`,
      );
    } else if (comparison.baseline?.baseHeadAt) {
      lines.push(
        `Baseline: ${comparison.baseline.baseBranch ?? 'base branch'} as currently checked out (${comparison.baseline.baseHeadAt}).`,
      );
      lines.push(
        `This comparison may include changes merged into ${comparison.baseline.baseBranch ?? 'the base branch'} after the task branched.`,
      );
      if (comparison.baseline.stale) {
        lines.push(
          `The base report predates ${comparison.baseline.baseBranch ?? 'the base branch'} as currently checked out, so merge readiness ignores the delta.`,
        );
      }
    }
    if (comparison.impactedUnchangedFiles.length > 0) {
      const impacted = comparison.impactedUnchangedFiles
        .slice(0, 3)
        .map((file) =>
          file.delta === null
            ? `${file.path} ${coverageValueLabel(file.base)} → ${coverageValueLabel(file.task)}`
            : `${file.path} ${formatCoverageDelta(file.delta)}`,
        )
        .join(', ');
      lines.push(
        `${comparison.impactedUnchangedFiles.length} materially impacted unchanged file${comparison.impactedUnchangedFiles.length === 1 ? '' : 's'}: ${impacted}.`,
      );
    }
    return lines.join(' ');
  });

  createEffect(() => {
    if (!props.onCoverageComparisonChange) return;
    props.onCoverageComparisonChange(coverageComparison());
  });

  function toggleDir(path: string) {
    const isCollapsing = !collapsed().has(path);
    const rows = visibleRows();
    const dirIdx = isCollapsing ? rows.findIndex((r) => r.node.path === path) : -1;

    batch(() => {
      // When collapsing, snap selection to the directory if selected item is a child
      if (dirIdx >= 0) {
        const dirDepth = rows[dirIdx].depth;
        const sel = selectedIndex();
        let subtreeEnd = rows.length;
        for (let j = dirIdx + 1; j < rows.length; j++) {
          if (rows[j].depth <= dirDepth) {
            subtreeEnd = j;
            break;
          }
        }
        if (sel > dirIdx && sel < subtreeEnd) {
          setSelectedIndex(dirIdx);
        }
      }

      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    });
  }

  // Scroll selected item into view reactively
  createEffect(() => {
    const idx = selectedIndex();
    if (idx >= 0) rowRefs[idx]?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  });

  // Trim stale refs and clamp selection when visible rows change
  createEffect(() => {
    const len = visibleRows().length;
    rowRefs.length = len;
    setSelectedIndex((i) => (i >= len ? len - 1 : i));
  });

  function handleKeyDown(e: KeyboardEvent) {
    const rows = visibleRows();
    if (rows.length === 0) return;
    if (e.altKey) return;
    const idx = selectedIndex();

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (idx >= 0 && idx < rows.length) {
        const row = rows[idx];
        if (row.isDir && collapsed().has(row.node.path)) {
          toggleDir(row.node.path);
        } else if (row.isDir && idx + 1 < rows.length) {
          // Already expanded — move to first child
          setSelectedIndex(idx + 1);
        }
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (idx >= 0 && idx < rows.length) {
        const row = rows[idx];
        if (row.isDir && !collapsed().has(row.node.path)) {
          // Collapse this directory
          toggleDir(row.node.path);
        } else if (row.depth > 0) {
          // Move to parent directory
          for (let j = idx - 1; j >= 0; j--) {
            if (rows[j].isDir && rows[j].depth === row.depth - 1) {
              setSelectedIndex(j);
              break;
            }
          }
        }
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (idx >= 0 && idx < rows.length) {
        const row = rows[idx];
        if (row.isDir) {
          toggleDir(row.node.path);
        } else if (row.node.file) {
          props.onFileClick?.(row.node.file);
        }
      }
    }
  }

  // Falls back to branch-based diff when worktree path doesn't exist.
  // When selectedCommit is a hash, fetches files for that single commit (no polling).
  // When selectedCommit is the uncommitted sentinel, fetches HEAD-to-working-tree changes.
  // Always runs an initial fetch on mount/input change so non-active tasks have
  // populated data — CommitNavBar buttons stopPropagation, so navigating there
  // wouldn't otherwise activate the task and trigger a fetch. Polling at 5s
  // (matching git status) is still gated on isActive to avoid running git
  // pipelines for every off-screen task.
  createEffect(() => {
    void props.worktreePath;
    void props.projectRoot;
    void props.branchName;
    void props.baseBranch;
    void props.selectedCommit;
    batch(() => {
      setComparisonFiles(null);
      setComparisonInventoryState('loading');
    });
  });

  createEffect(() => {
    const path = props.worktreePath;
    const projectRoot = props.projectRoot;
    const branchName = props.branchName;
    const baseBranch = props.baseBranch;
    const selection = props.selectedCommit;
    const singleCommitHash = isCommitHashSelection(selection) ? selection : null;
    const uncommittedOnly = isUncommittedSelection(selection);
    const comparisonEnabled = hasCoverageArtifact() || hasBaseCoverageArtifact();
    let cancelled = false;
    let inFlight = false;
    let usingBranchFallback = false;
    setCanOpenFilesInEditor(false);

    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        // Single-commit mode: fetch files for that commit only
        if (singleCommitHash && path) {
          try {
            const result = await invoke<ChangedFile[]>(IPC.GetCommitChangedFiles, {
              worktreePath: path,
              commitHash: singleCommitHash,
            });
            if (!cancelled) {
              setFiles((current) => (sameChangedFiles(current, result) ? current : result));
              setCanOpenFilesInEditor(true);
            }
          } catch {
            if (!cancelled) {
              setFiles([]);
              setCanOpenFilesInEditor(false);
            }
          }
          return;
        }

        if (uncommittedOnly && path) {
          if (!comparisonEnabled && !cancelled) {
            batch(() => {
              setComparisonFiles(null);
              setComparisonInventoryState('loading');
            });
          }
          const comparisonRequest = comparisonEnabled
            ? invoke<ChangedFile[]>(IPC.GetChangedFiles, {
                worktreePath: path,
                baseBranch,
              })
                .then((result) => {
                  if (!cancelled) {
                    batch(() => {
                      setComparisonFiles((current) =>
                        sameChangedFiles(current, result) ? current : result,
                      );
                      setComparisonInventoryState('available');
                    });
                  }
                })
                .catch(() => {
                  if (!cancelled) {
                    batch(() => {
                      setComparisonFiles(null);
                      setComparisonInventoryState('failed');
                    });
                  }
                })
            : Promise.resolve();
          try {
            const result = await invoke<ChangedFile[]>(IPC.GetUncommittedChangedFiles, {
              worktreePath: path,
            });
            if (!cancelled) {
              setFiles((current) => (sameChangedFiles(current, result) ? current : result));
              setCanOpenFilesInEditor(true);
            }
          } catch {
            if (!cancelled) {
              setFiles([]);
              setCanOpenFilesInEditor(false);
            }
          }
          await comparisonRequest;
          return;
        }

        // Try worktree-based fetch first
        if (path && !usingBranchFallback) {
          try {
            const result = await invoke<ChangedFile[]>(IPC.GetChangedFiles, {
              worktreePath: path,
              baseBranch,
            });
            if (!cancelled) {
              batch(() => {
                setFiles((current) => (sameChangedFiles(current, result) ? current : result));
                setComparisonFiles((current) =>
                  sameChangedFiles(current, result) ? current : result,
                );
                setComparisonInventoryState('available');
                setCanOpenFilesInEditor(true);
              });
            }
            return;
          } catch {
            if (!cancelled) {
              batch(() => {
                setComparisonFiles(null);
                setComparisonInventoryState('failed');
                setCanOpenFilesInEditor(false);
              });
            }
            // Worktree may not exist — try branch fallback below
          }
        }

        // Branch-based fallback: static data, no need to re-poll
        if (!usingBranchFallback && projectRoot && branchName) {
          usingBranchFallback = true;
          try {
            const result = await invoke<ChangedFile[]>(IPC.GetChangedFilesFromBranch, {
              projectRoot,
              branchName,
              baseBranch,
            });
            if (!cancelled) {
              const displayedFiles = uncommittedOnly
                ? result.filter((file) => !file.committed)
                : result;
              batch(() => {
                setFiles((current) =>
                  sameChangedFiles(current, displayedFiles) ? current : displayedFiles,
                );
                setComparisonFiles((current) =>
                  sameChangedFiles(current, result) ? current : result,
                );
                setComparisonInventoryState('available');
                setCanOpenFilesInEditor(false);
              });
              return;
            }
          } catch {
            if (!cancelled) {
              batch(() => {
                setComparisonFiles(null);
                setComparisonInventoryState('failed');
                setCanOpenFilesInEditor(false);
              });
            }
            // Branch may no longer exist
          }
        }

        if (!cancelled && comparisonEnabled) {
          setComparisonInventoryState('failed');
        }
      } finally {
        inFlight = false;
      }
    }

    void refresh();
    // Polling: skip when inactive (off-screen tasks) and when viewing a single
    // commit (committed data is immutable).
    const shouldPoll = singleCommitHash === null && props.isActive;
    const timer = shouldPoll
      ? setInterval(() => {
          if (!usingBranchFallback) void refresh();
        }, 5000)
      : undefined;
    onCleanup(() => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    });
  });

  createEffect(() => {
    const repoRoot = props.worktreePath;
    const projectRoot = props.projectRoot;
    const taskBranch = props.branchName;
    const baseBranch = props.baseBranch;
    const selection = props.selectedCommit;
    if (!repoRoot || isCommitHashSelection(selection)) {
      batch(() => {
        setCoverage(null);
        setBaseCoverage(null);
        setBaseHeadAt(null);
        setTaskHeadAt(null);
        setBaseBranchName(undefined);
      });
      return;
    }
    if (!props.isActive) return;
    let cancelled = false;
    let inFlight = false;
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const taskResult = await invoke<CoverageSummary | null>(IPC.GetCoverageSummary, {
          repoRoot,
          reportPath: props.coverageReportPath,
        }).catch(() => null);
        let baseResult: CoverageSummary | null = null;
        let baseHeadResult: string | null = null;
        let taskHeadResult: string | null = null;
        let resolvedBaseBranch: string | null = null;
        if (taskResult) {
          const taskWorktree = taskBranch
            ? await resolveCoverageWorktree(projectRoot, taskBranch)
            : null;
          taskHeadResult = taskWorktree?.headCommittedAt ?? null;
          resolvedBaseBranch = baseBranch
            ? baseBranch
            : projectRoot
              ? await invoke<string>(IPC.GetMainBranch, { projectRoot }).catch(() => null)
              : null;
          const baseWorktree = resolvedBaseBranch
            ? await resolveBaseCoverageRoot(projectRoot, resolvedBaseBranch, repoRoot)
            : null;
          if (baseWorktree) {
            baseHeadResult = baseWorktree.headCommittedAt;
            baseResult = await invoke<CoverageSummary | null>(IPC.GetCoverageSummary, {
              repoRoot: baseWorktree.path,
              reportPath: props.coverageReportPath,
            }).catch(() => null);
          }
        }
        if (!cancelled) {
          batch(() => {
            setCoverage((current) =>
              sameCoverageSummary(current, taskResult) ? current : taskResult,
            );
            setBaseCoverage((current) =>
              sameCoverageSummary(current, baseResult) ? current : baseResult,
            );
            setBaseHeadAt(baseHeadResult);
            setTaskHeadAt(taskHeadResult);
            setBaseBranchName(resolvedBaseBranch ?? undefined);
          });
        }
      } finally {
        inFlight = false;
      }
    }

    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    onCleanup(() => {
      cancelled = true;
      clearInterval(timer);
    });
  });

  const totalAdded = createMemo(() => files().reduce((s, f) => s + f.lines_added, 0));
  const totalRemoved = createMemo(() => files().reduce((s, f) => s + f.lines_removed, 0));
  const uncommittedCount = createMemo(() => files().filter((f) => !f.committed).length);

  return (
    <div
      ref={props.ref}
      class="focusable-panel changed-files-list-panel"
      data-panel-focused={props.panelFocused ? 'true' : 'false'}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        overflow: 'hidden',
        'font-family': "'JetBrains Mono', monospace",
        'font-size': sf(12),
        outline: 'none',
        'user-select': 'none',
      }}
    >
      <div style={{ flex: '1', overflow: 'auto', padding: '4px 0' }}>
        <Index each={visibleRows()}>
          {(row, i) => (
            <div
              ref={(el) => (rowRefs[i] = el)}
              class="file-row"
              style={{
                position: 'relative',
                display: 'flex',
                'align-items': 'center',
                gap: '6px',
                padding: '2px 8px',
                'padding-left': `${8 + row().depth * 8}px`,
                'white-space': 'nowrap',
                cursor: 'pointer',
                'border-radius': 'var(--radius-xs)',
                opacity:
                  !isCommitHashSelection(props.selectedCommit) &&
                  (row().isDir || row().node.file?.committed)
                    ? '0.45'
                    : '1',
                background:
                  selectedIndex() === i
                    ? theme.bgHover
                    : row().node.file && row().node.path === props.activeFilePath
                      ? 'rgba(88, 166, 255, 0.16)'
                      : 'transparent',
              }}
              onClick={() => {
                setSelectedIndex(i);
                const r = row();
                if (r.isDir) {
                  toggleDir(r.node.path);
                } else if (r.node.file) {
                  props.onFileClick?.(r.node.file);
                }
              }}
            >
              {row().isDir ? (
                <>
                  <span
                    style={{
                      color: theme.fg,
                      width: '10px',
                      'text-align': 'center',
                      'flex-shrink': '0',
                      'font-size': sf(11),
                    }}
                  >
                    {collapsed().has(row().node.path) ? '\u25B8' : '\u25BE'}
                  </span>
                  <span
                    style={{
                      flex: '1',
                      overflow: 'hidden',
                      'text-overflow': 'ellipsis',
                      color: theme.fg,
                    }}
                    title={row().node.path}
                  >
                    {row().node.name}/
                  </span>
                  <Show when={collapsed().has(row().node.path)}>
                    <span
                      style={{
                        color: theme.fg,
                        'font-size': sf(11),
                        'flex-shrink': '0',
                      }}
                    >
                      {row().node.fileCount}
                    </span>
                    <Show when={row().node.linesAdded > 0 || row().node.linesRemoved > 0}>
                      <span style={{ color: theme.success, 'flex-shrink': '0' }}>
                        +{row().node.linesAdded}
                      </span>
                      <span style={{ color: theme.error, 'flex-shrink': '0' }}>
                        -{row().node.linesRemoved}
                      </span>
                    </Show>
                  </Show>
                </>
              ) : (
                <>
                  <span
                    style={{
                      color: getStatusColor(row().node.file?.status ?? ''),
                      'font-weight': '600',
                      width: '12px',
                      'text-align': 'center',
                      'flex-shrink': '0',
                    }}
                  >
                    {row().node.file?.status}
                  </span>
                  <span
                    style={{
                      flex: '1',
                      overflow: 'hidden',
                      'text-overflow': 'ellipsis',
                      color: theme.fg,
                    }}
                    title={row().node.path}
                  >
                    {row().node.name}
                  </span>
                  <Show when={row().node.file} keyed>
                    {(file) => (
                      <FileCoverageBadge
                        file={file}
                        selectedCommit={props.selectedCommit}
                        summary={coverageFiles()[row().node.path]}
                        comparison={coverageComparison()?.files[row().node.path]}
                        baseline={coverageComparison()?.baseline}
                        hasCoverageArtifact={hasCoverageArtifact()}
                      />
                    )}
                  </Show>
                  <Show
                    when={
                      (row().node.file?.lines_added ?? 0) > 0 ||
                      (row().node.file?.lines_removed ?? 0) > 0
                    }
                  >
                    <span style={{ color: theme.success, 'flex-shrink': '0' }}>
                      +{row().node.file?.lines_added}
                    </span>
                    <span style={{ color: theme.error, 'flex-shrink': '0' }}>
                      -{row().node.file?.lines_removed}
                    </span>
                  </Show>
                  <Show when={canOpenFilesInEditor()}>
                    <OpenInEditorButton
                      worktreePath={props.worktreePath}
                      filePath={row().node.file?.path ?? row().node.path}
                      onOpenInEditorClick={props.onOpenInEditorClick}
                    />
                  </Show>
                </>
              )}
            </div>
          )}
        </Index>
      </div>
      <Show when={files().length > 0}>
        <div
          style={{
            padding: '4px 8px',
            'border-top': `1px solid ${theme.border}`,
            color: theme.fgMuted,
            'flex-shrink': '0',
          }}
        >
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              'justify-content': 'flex-end',
              'flex-wrap': 'wrap',
            }}
          >
            <Show when={showCoverageFooter()}>
              <div
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '6px',
                  'margin-right': 'auto',
                }}
              >
                <Show when={aggregateCoverageLabel()}>
                  {(label) => (
                    <span
                      title={aggregateCoverageTitle()}
                      style={{
                        color:
                          coverageComparison()?.aggregate.delta === null ||
                          isBaselineInformational(coverageComparison()?.baseline)
                            ? theme.fgMuted
                            : deltaColor(coverageComparison()?.aggregate.delta ?? 0),
                        'font-weight': '600',
                      }}
                    >
                      {label()}
                    </span>
                  )}
                </Show>
                <Show when={touchedCoveragePct() !== null}>
                  <span
                    title={coverageFooterTitle(
                      coverage(),
                      touchedCoveragePct(),
                      hasMatchedCoverage(),
                    )}
                    style={{
                      color: coverageColor(touchedCoveragePct() ?? 0),
                      'font-weight': '600',
                    }}
                  >
                    {coverageFooterLabel(
                      hasCoverageArtifact(),
                      touchedCoveragePct(),
                      hasMatchedCoverage(),
                    )}
                  </span>
                </Show>
                <Show when={touchedCoveragePct() === null}>
                  <span
                    title={coverageFooterTitle(
                      coverage(),
                      touchedCoveragePct(),
                      hasMatchedCoverage(),
                    )}
                  >
                    {coverageFooterLabel(
                      hasCoverageArtifact(),
                      touchedCoveragePct(),
                      hasMatchedCoverage(),
                    )}
                  </span>
                </Show>
                <Show when={lowCoverageCount() > 0}>
                  <span
                    title={`${lowCoverageCount()} changed file${lowCoverageCount() === 1 ? '' : 's'} below 60% line coverage.`}
                    style={{ color: theme.warning, 'font-weight': '600' }}
                  >
                    △ {lowCoverageCount()}
                  </span>
                </Show>
                <Show when={missingCoverageCount() > 0}>
                  <span
                    title={`${missingCoverageCount()} changed file${missingCoverageCount() === 1 ? '' : 's'} missing from the loaded coverage report.`}
                    style={{ color: theme.error, 'font-weight': '600' }}
                  >
                    ∅ {missingCoverageCount()}
                  </span>
                </Show>
                <Show when={(coverageComparison()?.impactedUnchangedFiles.length ?? 0) > 0}>
                  <span
                    title={aggregateCoverageTitle()}
                    style={{
                      color: isBaselineInformational(coverageComparison()?.baseline)
                        ? theme.fgMuted
                        : theme.warning,
                      'font-weight': '600',
                    }}
                  >
                    ↕ {coverageComparison()?.impactedUnchangedFiles.length} other
                  </span>
                </Show>
              </div>
            </Show>
            <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
              <span
                title={filesFooterTitle(files().length, uncommittedCount())}
                style={{ color: uncommittedCount() > 0 ? theme.warning : theme.fgMuted }}
              >
                {filesFooterLabel(files().length, uncommittedCount())}
              </span>
              <span title={`${totalAdded()} added lines`} style={{ color: theme.success }}>
                +{totalAdded()}
              </span>
              <span title={`${totalRemoved()} removed lines`} style={{ color: theme.error }}>
                -{totalRemoved()}
              </span>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
