import type { ChangedFile, CoverageSummary } from '../ipc/types';

export type CoverageValueState =
  | 'available'
  | 'no-report'
  | 'file-not-present'
  | 'no-executable-lines';

export interface CoverageValue {
  state: CoverageValueState;
  pct: number | null;
}

export type CoverageFileChangeKind = 'changed' | 'new' | 'deleted' | 'renamed';

export interface CoverageFileComparison {
  path: string;
  basePath: string;
  kind: CoverageFileChangeKind;
  task: CoverageValue;
  base: CoverageValue;
  delta: number | null;
}

export interface ImpactedCoverageFile {
  path: string;
  task: CoverageValue;
  base: CoverageValue;
  delta: number | null;
}

export interface CoverageComparison {
  aggregate: {
    task: CoverageValue;
    base: CoverageValue;
    delta: number | null;
  };
  files: Record<string, CoverageFileComparison>;
  impactedUnchangedFiles: ImpactedCoverageFile[];
  inventoryState?: 'available' | 'loading' | 'failed';
  baseline?: {
    baseBranch?: string;
    baseHeadAt?: string;
    taskHeadAt?: string;
    stale: boolean;
    unanchored?: boolean;
    taskStale?: boolean;
    taskUnanchored?: boolean;
  };
}

export const MATERIAL_COVERAGE_DELTA = 1;

export function isBaselineInformational(baseline: CoverageComparison['baseline']): boolean {
  return Boolean(
    baseline?.stale || baseline?.unanchored || baseline?.taskStale || baseline?.taskUnanchored,
  );
}

function roundPercentage(value: number): number {
  return Math.round(value * 100) / 100;
}

function aggregateValue(summary: CoverageSummary | null): CoverageValue {
  if (!summary) return { state: 'no-report', pct: null };
  if (summary.totals.lines.total === 0) {
    return { state: 'no-executable-lines', pct: null };
  }
  return { state: 'available', pct: summary.totals.lines.pct };
}

function fileValue(
  summary: CoverageSummary | null,
  filePath: string,
  forceMissing = false,
): CoverageValue {
  if (!summary) return { state: 'no-report', pct: null };
  const file =
    forceMissing || !Object.hasOwn(summary.files, filePath) ? undefined : summary.files[filePath];
  if (!file) return { state: 'file-not-present', pct: null };
  if (file.lines.total === 0) return { state: 'no-executable-lines', pct: null };
  return { state: 'available', pct: file.lines.pct };
}

function coverageDelta(task: CoverageValue, base: CoverageValue): number | null {
  if (task.state !== 'available' || base.state !== 'available') return null;
  return roundPercentage((task.pct ?? 0) - (base.pct ?? 0));
}

function changeKind(file: ChangedFile): CoverageFileChangeKind {
  if (file.status === 'D') return 'deleted';
  if (file.status === 'R') return 'renamed';
  if (file.status === 'A' || file.status === '?' || file.status === 'C') return 'new';
  return 'changed';
}

export function formatCoverageDelta(delta: number): string {
  const rounded = roundPercentage(delta);
  if (rounded > 0) return `+${rounded}pp`;
  return `${rounded}pp`;
}

export function buildCoverageComparison(
  taskSummary: CoverageSummary | null,
  baseSummary: CoverageSummary | null,
  changedFiles: ChangedFile[],
  baseHeadAt?: string | null,
  baseBranch?: string,
  taskHeadAt?: string | null,
): CoverageComparison {
  const taskAggregate = aggregateValue(taskSummary);
  const baseAggregate = aggregateValue(baseSummary);
  const files = Object.create(null) as Record<string, CoverageFileComparison>;
  const changedPaths = new Set<string>();

  for (const file of changedFiles) {
    const kind = changeKind(file);
    const basePath = file.previous_path ?? file.path;
    changedPaths.add(file.path);
    changedPaths.add(basePath);

    const task = fileValue(taskSummary, file.path, kind === 'deleted');
    const base = fileValue(baseSummary, basePath, kind === 'new');
    files[file.path] = {
      path: file.path,
      basePath,
      kind,
      task,
      base,
      delta: coverageDelta(task, base),
    };
  }

  const impactedUnchangedFiles: ImpactedCoverageFile[] = [];
  if (taskSummary && baseSummary) {
    const reportPaths = new Set([
      ...Object.keys(taskSummary.files),
      ...Object.keys(baseSummary.files),
    ]);
    for (const filePath of reportPaths) {
      if (changedPaths.has(filePath)) continue;
      const task = fileValue(taskSummary, filePath);
      const base = fileValue(baseSummary, filePath);
      const delta = coverageDelta(task, base);
      if (task.state === base.state && delta === null) continue;
      if (delta !== null && Math.abs(delta) < MATERIAL_COVERAGE_DELTA) continue;
      impactedUnchangedFiles.push({
        path: filePath,
        task,
        base,
        delta,
      });
    }
  }

  impactedUnchangedFiles.sort(
    (a, b) =>
      Number(b.delta === null) - Number(a.delta === null) ||
      Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) ||
      a.path.localeCompare(b.path),
  );

  const baseHeadTime = baseHeadAt ? Date.parse(baseHeadAt) : Number.NaN;
  const baseGeneratedTime = baseSummary ? Date.parse(baseSummary.generatedAt) : Number.NaN;
  const taskHeadTime = taskHeadAt ? Date.parse(taskHeadAt) : Number.NaN;
  const taskGeneratedTime = taskSummary ? Date.parse(taskSummary.generatedAt) : Number.NaN;
  const taskAnchor =
    taskHeadAt === undefined
      ? {}
      : taskHeadAt && Number.isFinite(taskHeadTime) && Number.isFinite(taskGeneratedTime)
        ? {
            taskHeadAt,
            taskStale: taskGeneratedTime < taskHeadTime,
          }
        : {
            taskStale: false,
            taskUnanchored: true,
          };
  const baseline = !baseSummary
    ? undefined
    : baseHeadAt && Number.isFinite(baseHeadTime) && Number.isFinite(baseGeneratedTime)
      ? {
          ...(baseBranch ? { baseBranch } : {}),
          baseHeadAt,
          stale: baseGeneratedTime < baseHeadTime,
          ...taskAnchor,
        }
      : {
          ...(baseBranch ? { baseBranch } : {}),
          stale: false,
          unanchored: true,
          ...taskAnchor,
        };

  return {
    aggregate: {
      task: taskAggregate,
      base: baseAggregate,
      delta: coverageDelta(taskAggregate, baseAggregate),
    },
    files,
    impactedUnchangedFiles,
    baseline,
  };
}
