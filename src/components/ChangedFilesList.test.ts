import { renderToString } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import type { ChangedFile, CoverageFileSummary } from '../ipc/types';
import {
  coverageFooterLabel,
  coverageFooterTitle,
  FileCoverageBadge,
  isCoverageEligible,
} from './ChangedFilesList';

function changedFile(overrides: Partial<ChangedFile>): ChangedFile {
  return {
    path: 'src/example.ts',
    lines_added: 1,
    lines_removed: 0,
    status: 'M',
    committed: false,
    ...overrides,
  };
}

describe('isCoverageEligible', () => {
  it('accepts changed source files', () => {
    expect(isCoverageEligible(changedFile({ path: 'src/example.ts' }))).toBe(true);
  });

  it('rejects deleted files', () => {
    expect(isCoverageEligible(changedFile({ status: 'D' }))).toBe(false);
  });

  it('rejects test files', () => {
    expect(isCoverageEligible(changedFile({ path: 'src/example.test.ts' }))).toBe(false);
  });
});

describe('coverageFooterLabel', () => {
  it('explains when no coverage artifact is loaded', () => {
    expect(coverageFooterLabel(false, null, false)).toBe('⊘');
  });

  it('explains when a report is loaded but no changed file matches it', () => {
    expect(coverageFooterLabel(true, null, false)).toBe('∅');
  });

  it('distinguishes matched zero-line files from missing coverage', () => {
    expect(coverageFooterLabel(true, null, true)).toBe('◌');
    expect(
      coverageFooterTitle(
        {
          format: 'lcov',
          generatedAt: '2026-04-23T00:00:00.000Z',
          reportPath: '/repo/coverage/lcov.info',
          totals: {
            lines: { total: 0, covered: 0, skipped: 0, pct: 100 },
            statements: { total: 0, covered: 0, skipped: 0, pct: 100 },
            functions: { total: 0, covered: 0, skipped: 0, pct: 100 },
            branches: { total: 0, covered: 0, skipped: 0, pct: 100 },
          },
          files: {},
        },
        null,
        true,
      ),
    ).toContain('no executable lines');
  });

  it('shows the radar percentage when changed files are covered', () => {
    expect(coverageFooterLabel(true, 82, true)).toBe('◔ 82%');
  });
});

describe('FileCoverageBadge', () => {
  it('keeps task-only coverage visible while comparison inventory is unavailable', () => {
    const summary: CoverageFileSummary = {
      path: 'src/example.ts',
      lines: { total: 100, covered: 82, skipped: 0, pct: 82 },
      statements: { total: 100, covered: 81, skipped: 0, pct: 81 },
      functions: { total: 10, covered: 8, skipped: 0, pct: 80 },
      branches: { total: 20, covered: 15, skipped: 0, pct: 75 },
    };

    const html = renderToString(() =>
      FileCoverageBadge({
        file: changedFile({ path: summary.path }),
        summary,
        comparison: undefined,
        hasCoverageArtifact: true,
      }),
    );

    expect(html).toContain('82%');
    expect(html).toContain('Lines 82%');
    expect(html).not.toContain('No recent coverage data');
  });
});
