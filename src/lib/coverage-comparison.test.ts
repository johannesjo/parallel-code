import { describe, expect, it } from 'vitest';
import type {
  ChangedFile,
  CoverageFileSummary,
  CoverageMetricSummary,
  CoverageSummary,
} from '../ipc/types';
import {
  buildCoverageComparison,
  formatCoverageDelta,
  MATERIAL_COVERAGE_DELTA,
} from './coverage-comparison';

function metric(pct: number, total = 100): CoverageMetricSummary {
  return {
    total,
    covered: total === 0 ? 0 : Math.round((pct / 100) * total),
    skipped: 0,
    pct,
  };
}

function file(path: string, pct: number, total = 100): CoverageFileSummary {
  const value = metric(pct, total);
  return {
    path,
    lines: value,
    statements: value,
    functions: value,
    branches: value,
  };
}

function report(
  totalPct: number,
  files: CoverageFileSummary[],
  generatedAt = '2026-07-25T00:00:00.000Z',
): CoverageSummary {
  const total = metric(totalPct);
  return {
    format: 'istanbul-summary',
    generatedAt,
    reportPath: '/repo/coverage/coverage-summary.json',
    totals: {
      lines: total,
      statements: total,
      functions: total,
      branches: total,
    },
    files: Object.fromEntries(files.map((entry) => [entry.path, entry])),
  };
}

function changed(path: string, status = 'M', previousPath?: string): ChangedFile {
  return {
    path,
    previous_path: previousPath,
    lines_added: 1,
    lines_removed: 1,
    status,
    committed: true,
  };
}

describe('buildCoverageComparison', () => {
  it('calculates aggregate and per-file positive, negative, and zero deltas', () => {
    const base = report(80, [
      file('src/up.ts', 70),
      file('src/down.ts', 90),
      file('src/same.ts', 75),
    ]);
    const task = report(82.25, [
      file('src/up.ts', 80),
      file('src/down.ts', 85),
      file('src/same.ts', 75),
    ]);

    const result = buildCoverageComparison(task, base, [
      changed('src/up.ts'),
      changed('src/down.ts'),
      changed('src/same.ts'),
    ]);

    expect(result.aggregate.delta).toBe(2.25);
    expect(result.files['src/up.ts'].delta).toBe(10);
    expect(result.files['src/down.ts'].delta).toBe(-5);
    expect(result.files['src/same.ts'].delta).toBe(0);
  });

  it('defines new, deleted, and renamed file behavior', () => {
    const base = report(80, [file('src/deleted.ts', 70), file('src/old-name.ts', 60)]);
    const task = report(82, [file('src/new.ts', 90), file('src/new-name.ts', 75)]);

    const result = buildCoverageComparison(task, base, [
      changed('src/new.ts', 'A'),
      changed('src/deleted.ts', 'D'),
      changed('src/new-name.ts', 'R', 'src/old-name.ts'),
    ]);

    expect(result.files['src/new.ts']).toMatchObject({
      kind: 'new',
      task: { state: 'available', pct: 90 },
      base: { state: 'file-not-present', pct: null },
      delta: null,
    });
    expect(result.files['src/deleted.ts']).toMatchObject({
      kind: 'deleted',
      task: { state: 'file-not-present', pct: null },
      base: { state: 'available', pct: 70 },
      delta: null,
    });
    expect(result.files['src/new-name.ts']).toMatchObject({
      kind: 'renamed',
      basePath: 'src/old-name.ts',
      delta: 15,
    });
  });

  it('distinguishes no report, file absence, and no executable lines', () => {
    const noLines = file('src/no-lines.ts', 100, 0);
    const task = report(80, [noLines]);

    const noBase = buildCoverageComparison(task, null, [changed('src/no-lines.ts')]);
    expect(noBase.aggregate.base.state).toBe('no-report');
    expect(noBase.files['src/no-lines.ts'].task.state).toBe('no-executable-lines');
    expect(noBase.files['src/no-lines.ts'].base.state).toBe('no-report');

    const missing = buildCoverageComparison(task, report(75, []), [changed('src/missing.ts')]);
    expect(missing.files['src/missing.ts'].task.state).toBe('file-not-present');
    expect(missing.files['src/missing.ts'].base.state).toBe('file-not-present');
  });

  it('reports materially impacted unchanged files without duplicating changed paths', () => {
    const base = report(80, [
      file('src/changed.ts', 80),
      file('src/regressed.ts', 90),
      file('src/noise.ts', 80),
    ]);
    const task = report(78, [
      file('src/changed.ts', 70),
      file('src/regressed.ts', 82),
      file('src/noise.ts', 80 + MATERIAL_COVERAGE_DELTA / 2),
    ]);

    const result = buildCoverageComparison(task, base, [changed('src/changed.ts')]);

    expect(result.impactedUnchangedFiles).toEqual([
      {
        path: 'src/regressed.ts',
        task: { state: 'available', pct: 82 },
        base: { state: 'available', pct: 90 },
        delta: -8,
      },
    ]);
  });

  it('retains base-only unchanged files as unavailable task coverage', () => {
    const base = report(80, [file('src/base-only.ts', 40)]);
    const task = report(85, []);

    const result = buildCoverageComparison(task, base, []);

    expect(result.impactedUnchangedFiles).toEqual([
      {
        path: 'src/base-only.ts',
        task: { state: 'file-not-present', pct: null },
        base: { state: 'available', pct: 40 },
        delta: null,
      },
    ]);
  });

  it('retains available-to-no-lines transitions for unchanged files', () => {
    const base = report(80, [file('src/no-lines-now.ts', 75)]);
    const task = report(85, [file('src/no-lines-now.ts', 100, 0)]);

    const result = buildCoverageComparison(task, base, []);

    expect(result.impactedUnchangedFiles).toEqual([
      {
        path: 'src/no-lines-now.ts',
        task: { state: 'no-executable-lines', pct: null },
        base: { state: 'available', pct: 75 },
        delta: null,
      },
    ]);
  });

  it('does not classify non-source Git-changed paths as unchanged coverage impacts', () => {
    const base = report(80, [file('src/example.test.ts', 90)]);
    const task = report(80, [file('src/example.test.ts', 60)]);

    const result = buildCoverageComparison(task, base, [changed('src/example.test.ts')]);

    expect(result.files['src/example.test.ts'].delta).toBe(-30);
    expect(result.impactedUnchangedFiles).toEqual([]);
  });

  it('marks a base report older than the base branch HEAD as stale', () => {
    const result = buildCoverageComparison(
      report(82, []),
      report(80, []),
      [],
      '2026-07-26T00:00:00.000Z',
      'main',
    );

    expect(result.baseline).toEqual({
      baseBranch: 'main',
      baseHeadAt: '2026-07-26T00:00:00.000Z',
      stale: true,
    });
  });

  it('accepts a base report generated after the base branch HEAD', () => {
    const result = buildCoverageComparison(
      report(82, []),
      report(80, []),
      [],
      '2026-07-24T00:00:00.000Z',
      'main',
    );

    expect(result.baseline).toEqual({
      baseBranch: 'main',
      baseHeadAt: '2026-07-24T00:00:00.000Z',
      stale: false,
    });
  });

  it('marks a present base report with an unknown base branch HEAD as unanchored', () => {
    const result = buildCoverageComparison(report(82, []), report(80, []), [], null, 'main');

    expect(result.baseline).toEqual({
      baseBranch: 'main',
      stale: false,
      unanchored: true,
    });
  });

  it('marks a task report older than task HEAD as stale', () => {
    const result = buildCoverageComparison(
      report(82, [], '2026-07-25T00:00:00.000Z'),
      report(80, []),
      [],
      '2026-07-24T00:00:00.000Z',
      'main',
      '2026-07-26T00:00:00.000Z',
    );

    expect(result.baseline).toMatchObject({
      taskHeadAt: '2026-07-26T00:00:00.000Z',
      taskStale: true,
    });
  });

  it('marks a task report with an unknown task HEAD as unanchored', () => {
    const result = buildCoverageComparison(
      report(82, []),
      report(80, []),
      [],
      '2026-07-24T00:00:00.000Z',
      'main',
      null,
    );

    expect(result.baseline).toMatchObject({
      taskStale: false,
      taskUnanchored: true,
    });
  });

  it.each(['toString', 'constructor', '__proto__'])(
    'treats a missing report entry named %s as absent instead of reading Object.prototype',
    (path) => {
      const result = buildCoverageComparison(report(80, []), report(80, []), [changed(path)]);

      expect(Object.getPrototypeOf(result.files)).toBeNull();
      expect(result.files[path]).toMatchObject({
        path,
        task: { state: 'file-not-present', pct: null },
        base: { state: 'file-not-present', pct: null },
      });
    },
  );
});

describe('formatCoverageDelta', () => {
  it('formats signed percentage-point values', () => {
    expect(formatCoverageDelta(2.345)).toBe('+2.35pp');
    expect(formatCoverageDelta(-1.2)).toBe('-1.2pp');
    expect(formatCoverageDelta(0)).toBe('0pp');
  });
});
