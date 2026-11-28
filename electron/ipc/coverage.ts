import fs from 'fs';
import path from 'path';
import type {
  CoverageFileSummary,
  CoverageMetricSummary,
  CoverageSummary,
} from './shared-types.js';

export type {
  CoverageFileSummary,
  CoverageMetricSummary,
  CoverageSummary,
} from './shared-types.js';

interface RawCoverageMetric {
  total?: unknown;
  covered?: unknown;
  skipped?: unknown;
  pct?: unknown;
}

interface LcovFileCounts {
  linesFound: Set<number>;
  linesHit: Set<number>;
  functionsFound: Set<string>;
  functionsHit: Set<string>;
  branchesFound: Set<string>;
  branchesHit: Set<string>;
}

const DEFAULT_REPORT_PATHS = ['coverage/coverage-summary.json', 'coverage/lcov.info'] as const;
const NESTED_REPORT_FILENAMES = ['coverage-summary.json', 'lcov.info'] as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeSlashes(value: string): string {
  return value.split('\\').join('/');
}

function stripSourcePathPrefix(value: string): string {
  if (/^webpack:\/+/i.test(value)) return value.replace(/^webpack:\/+/i, '');
  return value.replace(/^file:\/+/i, '/').replace(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\/+/, '/');
}

function repoIdentityCandidates(repoRoot: string): string[] {
  const segments = normalizeSlashes(repoRoot).split('/').filter(Boolean);
  const candidates: string[] = [];
  const pushCandidate = (value?: string) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  pushCandidate(segments[segments.length - 1]);
  const worktreesIndex = segments.lastIndexOf('.worktrees');
  if (worktreesIndex > 0) pushCandidate(segments[worktreesIndex - 1]);

  return candidates;
}

function parseMetric(metric: unknown): CoverageMetricSummary | null {
  if (!metric || typeof metric !== 'object' || Array.isArray(metric)) return null;
  const raw = metric as RawCoverageMetric;
  if (
    !isFiniteNumber(raw.total) ||
    !isFiniteNumber(raw.covered) ||
    !isFiniteNumber(raw.skipped) ||
    !isFiniteNumber(raw.pct)
  ) {
    return null;
  }
  return {
    total: raw.total,
    covered: raw.covered,
    skipped: raw.skipped,
    pct: raw.pct,
  };
}

function metricFromCounts(covered: number, total: number): CoverageMetricSummary {
  return {
    total,
    covered,
    skipped: 0,
    pct: total === 0 ? 100 : Math.round((covered / total) * 10000) / 100,
  };
}

function parseEntry(filePath: string, entry: unknown): CoverageFileSummary | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const raw = entry as Record<string, unknown>;
  const lines = parseMetric(raw.lines);
  const statements = parseMetric(raw.statements);
  const functions = parseMetric(raw.functions);
  const branches = parseMetric(raw.branches);
  if (!lines || !statements || !functions || !branches) return null;
  return {
    path: filePath,
    lines,
    statements,
    functions,
    branches,
  };
}

function normalizeCoveragePath(
  repoRoot: string,
  key: string,
  exists: (filePath: string) => boolean,
): string | null {
  const normalizedKey = normalizeSlashes(stripSourcePathPrefix(key)).replace(/^\.\/+/, '');
  const relative = path.isAbsolute(normalizedKey)
    ? normalizeSlashes(path.relative(repoRoot, normalizedKey))
    : normalizedKey;
  const normalized = path.posix.normalize(relative).replace(/^\/+/, '');
  const direct =
    normalized && normalized !== '.' && !normalized.startsWith('../') ? normalized : null;

  const segments = normalizedKey.replace(/^\/+/, '').split('/').filter(Boolean);
  for (const repoName of repoIdentityCandidates(repoRoot)) {
    const repoNameIndex = segments.lastIndexOf(repoName);
    if (repoNameIndex < 0) continue;
    const repoRelative = path.posix
      .normalize(segments.slice(repoNameIndex + 1).join('/'))
      .replace(/^\/+/, '');
    if (!repoRelative || repoRelative.startsWith('../') || repoRelative === direct) continue;
    // Existence only matters when a different checkout-relative path could win.
    if (direct && exists(path.join(repoRoot, direct))) return direct;
    if (exists(path.join(repoRoot, repoRelative))) return repoRelative;
  }
  return direct;
}

function parseJsonSummary(
  normalizePath: (key: string) => string | null,
  reportPath: string,
  raw: string,
  stat: fs.Stats,
): CoverageSummary | null {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rawSummary = parsed as Record<string, unknown>;
  const totals = parseEntry('__total__', rawSummary.total);
  if (!totals) return null;

  const files: Record<string, CoverageFileSummary> = {};
  for (const [key, value] of Object.entries(rawSummary)) {
    if (key === 'total') continue;
    const normalizedPath = normalizePath(key);
    if (!normalizedPath) continue;
    const entry = parseEntry(normalizedPath, value);
    if (!entry) continue;
    files[normalizedPath] = entry;
  }

  return {
    format: 'istanbul-summary',
    generatedAt: stat.mtime.toISOString(),
    reportPath,
    totals: {
      lines: totals.lines,
      statements: totals.statements,
      functions: totals.functions,
      branches: totals.branches,
    },
    files,
  };
}

function emptyLcovCounts(): LcovFileCounts {
  return {
    linesFound: new Set(),
    linesHit: new Set(),
    functionsFound: new Set(),
    functionsHit: new Set(),
    branchesFound: new Set(),
    branchesHit: new Set(),
  };
}

function parseLcov(
  normalizePath: (key: string) => string | null,
  reportPath: string,
  raw: string,
  stat: fs.Stats,
): CoverageSummary {
  const perFile = new Map<string, LcovFileCounts>();
  let currentPath: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      currentPath = normalizePath(line.slice(3).trim());
      if (currentPath && !perFile.has(currentPath)) perFile.set(currentPath, emptyLcovCounts());
      continue;
    }
    if (!currentPath) continue;
    const counts = perFile.get(currentPath);
    if (!counts) continue;

    if (line.startsWith('DA:')) {
      const [lineNoRaw, hitsRaw] = line.slice(3).split(',');
      const lineNo = Number(lineNoRaw);
      const hits = Number(hitsRaw);
      if (Number.isFinite(lineNo) && lineNo > 0) counts.linesFound.add(lineNo);
      if (Number.isFinite(lineNo) && lineNo > 0 && Number.isFinite(hits) && hits > 0)
        counts.linesHit.add(lineNo);
      continue;
    }

    if (line.startsWith('FN:')) {
      const [, functionName = ''] = line.slice(3).split(',');
      if (functionName) counts.functionsFound.add(functionName);
      continue;
    }

    if (line.startsWith('FNDA:')) {
      const [hitsRaw, functionName = ''] = line.slice(5).split(',');
      const hits = Number(hitsRaw);
      if (functionName) counts.functionsFound.add(functionName);
      if (functionName && Number.isFinite(hits) && hits > 0) counts.functionsHit.add(functionName);
      continue;
    }

    if (line.startsWith('BRDA:')) {
      const [lineNo = '', blockNo = '', branchNo = '', takenRaw = ''] = line.slice(5).split(',');
      const branchId = `${lineNo},${blockNo},${branchNo}`;
      counts.branchesFound.add(branchId);
      if (takenRaw !== '-' && Number.isFinite(Number(takenRaw)) && Number(takenRaw) > 0) {
        counts.branchesHit.add(branchId);
      }
      continue;
    }

    if (line === 'end_of_record') currentPath = null;
  }

  const files: Record<string, CoverageFileSummary> = {};
  let totalLinesFound = 0;
  let totalLinesHit = 0;
  let totalFunctionsFound = 0;
  let totalFunctionsHit = 0;
  let totalBranchesFound = 0;
  let totalBranchesHit = 0;

  for (const [filePath, counts] of perFile) {
    const lines = metricFromCounts(counts.linesHit.size, counts.linesFound.size);
    const functions = metricFromCounts(counts.functionsHit.size, counts.functionsFound.size);
    const branches = metricFromCounts(counts.branchesHit.size, counts.branchesFound.size);
    const statements = lines;

    totalLinesFound += lines.total;
    totalLinesHit += lines.covered;
    totalFunctionsFound += functions.total;
    totalFunctionsHit += functions.covered;
    totalBranchesFound += branches.total;
    totalBranchesHit += branches.covered;

    files[filePath] = {
      path: filePath,
      lines,
      statements,
      functions,
      branches,
    };
  }

  return {
    format: 'lcov',
    generatedAt: stat.mtime.toISOString(),
    reportPath,
    totals: {
      lines: metricFromCounts(totalLinesHit, totalLinesFound),
      statements: metricFromCounts(totalLinesHit, totalLinesFound),
      functions: metricFromCounts(totalFunctionsHit, totalFunctionsFound),
      branches: metricFromCounts(totalBranchesHit, totalBranchesFound),
    },
    files,
  };
}

async function resolveReportCandidates(
  repoRoot: string,
  configuredPath?: string,
): Promise<string[]> {
  if (configuredPath) {
    const normalizedPath = configuredPath.split('\\').join('/');
    const resolved = path.resolve(repoRoot, normalizedPath);
    const relative = path.relative(repoRoot, resolved);
    if (
      relative === '' ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      normalizedPath.includes('..')
    ) {
      throw new Error('coverage report path must stay within the repo root');
    }
    return [resolved];
  }

  const candidates = DEFAULT_REPORT_PATHS.map((reportPath) => path.join(repoRoot, reportPath));
  const coverageDir = path.join(repoRoot, 'coverage');

  try {
    const entries = await fs.promises.readdir(coverageDir, { withFileTypes: true });
    const nestedCandidates = entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) =>
        NESTED_REPORT_FILENAMES.map((filename) => path.join(coverageDir, entry.name, filename)),
      );
    candidates.push(...nestedCandidates);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  return candidates;
}

interface CachedReport {
  repoRoot: string;
  stat: fs.Stats;
  sourceChecks: Map<string, boolean>;
  summary: CoverageSummary;
}

// A task can poll its own coverage and its base checkout's. Bound retained reports
// when the user moves between projects.
const reportCache = new Map<string, CachedReport>();
const MAX_CACHED_REPORTS = 8;

function matchesReport(entry: CachedReport, repoRoot: string, stat: fs.Stats): boolean {
  const previous = entry.stat;
  if (
    entry.repoRoot !== repoRoot ||
    previous.size !== stat.size ||
    previous.mtimeMs !== stat.mtimeMs ||
    previous.ctimeMs !== stat.ctimeMs ||
    previous.ino !== stat.ino ||
    previous.dev !== stat.dev
  )
    return false;
  // Paths recorded in a different checkout may start or stop resolving locally
  // even when the report itself is unchanged.
  for (const [filePath, existed] of entry.sourceChecks) {
    if (fs.existsSync(filePath) !== existed) return false;
  }
  return true;
}

export async function readCoverageSummary(
  repoRoot: string,
  configuredPath?: string,
): Promise<CoverageSummary | null> {
  for (const reportPath of await resolveReportCandidates(repoRoot, configuredPath)) {
    try {
      const stat = await fs.promises.stat(reportPath);
      const cached = reportCache.get(reportPath);
      if (cached && matchesReport(cached, repoRoot, stat)) return cached.summary;

      const raw = await fs.promises.readFile(reportPath, 'utf8');
      const sourceChecks = new Map<string, boolean>();
      const exists = (filePath: string) => {
        const existed = fs.existsSync(filePath);
        sourceChecks.set(filePath, existed);
        return existed;
      };
      const normalizePath = (key: string) => normalizeCoveragePath(repoRoot, key, exists);
      let summary: CoverageSummary | null = null;
      if (raw.trimStart().startsWith('{')) {
        summary = parseJsonSummary(normalizePath, reportPath, raw, stat);
      } else if (/(^|\n)(TN:|SF:)/.test(raw)) {
        summary = parseLcov(normalizePath, reportPath, raw, stat);
      }
      if (!summary) continue;
      if (reportCache.size >= MAX_CACHED_REPORTS && !reportCache.has(reportPath)) {
        const oldest = reportCache.keys().next();
        if (!oldest.done) reportCache.delete(oldest.value);
      }
      summary.revision = crypto.randomUUID();
      reportCache.set(reportPath, { repoRoot, stat, sourceChecks, summary });
      return summary;
    } catch (err) {
      if (err instanceof SyntaxError || (err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }

  return null;
}
