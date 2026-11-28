import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      promises: {
        ...actual.promises,
        access: vi.fn(),
        readdir: vi.fn(),
        readFile: vi.fn(),
        stat: vi.fn(),
      },
      existsSync: vi.fn(),
    },
  };
});

import fs from 'fs';
import { readCoverageSummary } from './coverage.js';

describe('readCoverageSummary', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function reportStat(timestamp: string, size = 100): fs.Stats {
    const mtime = new Date(timestamp);
    return { mtime, mtimeMs: mtime.getTime(), ctimeMs: mtime.getTime(), size } as fs.Stats;
  }

  function mockNoNestedCoverageDir() {
    const err = new Error('missing') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    vi.mocked(fs.promises.readdir).mockRejectedValue(err);
  }

  function mockFileExists(...paths: string[]) {
    const normalizedPaths = new Set(
      paths.map((filePath) => String(filePath).split('\\').join('/')),
    );
    vi.mocked(fs.existsSync).mockImplementation((filePath) =>
      normalizedPaths.has(String(filePath).split('\\').join('/')),
    );
  }

  it('parses Istanbul summary coverage and normalizes file keys', async () => {
    mockNoNestedCoverageDir();
    mockFileExists('/repo/src/App.tsx', '/repo/src/lib/file.ts');
    vi.mocked(fs.promises.readFile).mockResolvedValue(
      JSON.stringify({
        total: {
          lines: { total: 10, covered: 8, skipped: 0, pct: 80 },
          statements: { total: 10, covered: 8, skipped: 0, pct: 80 },
          functions: { total: 4, covered: 3, skipped: 0, pct: 75 },
          branches: { total: 2, covered: 1, skipped: 0, pct: 50 },
        },
        './src/App.tsx': {
          lines: { total: 5, covered: 4, skipped: 0, pct: 80 },
          statements: { total: 5, covered: 4, skipped: 0, pct: 80 },
          functions: { total: 2, covered: 2, skipped: 0, pct: 100 },
          branches: { total: 1, covered: 1, skipped: 0, pct: 100 },
        },
        '/repo/src/lib/file.ts': {
          lines: { total: 5, covered: 4, skipped: 0, pct: 80 },
          statements: { total: 5, covered: 4, skipped: 0, pct: 80 },
          functions: { total: 2, covered: 1, skipped: 0, pct: 50 },
          branches: { total: 1, covered: 0, skipped: 0, pct: 0 },
        },
        '/outside/file.ts': {
          lines: { total: 1, covered: 1, skipped: 0, pct: 100 },
          statements: { total: 1, covered: 1, skipped: 0, pct: 100 },
          functions: { total: 1, covered: 1, skipped: 0, pct: 100 },
          branches: { total: 1, covered: 1, skipped: 0, pct: 100 },
        },
      }),
    );
    vi.mocked(fs.promises.stat).mockResolvedValue(reportStat('2026-04-22T15:00:00.000Z'));

    const summary = await readCoverageSummary('/repo');

    expect(summary?.format).toBe('istanbul-summary');
    expect(summary?.generatedAt).toBe('2026-04-22T15:00:00.000Z');
    expect(summary?.reportPath).toBe('/repo/coverage/coverage-summary.json');
    expect(summary?.totals.lines.pct).toBe(80);
    expect(summary?.files['src/App.tsx']?.functions.pct).toBe(100);
    expect(summary?.files['src/lib/file.ts']?.branches.pct).toBe(0);
    expect(summary?.files['outside/file.ts']).toBeUndefined();
  });

  it('falls back to lcov.info when the summary report is missing', async () => {
    mockNoNestedCoverageDir();
    mockFileExists('/repo/src/lib/file.ts');
    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('coverage-summary.json')) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return [
        'TN:',
        'SF:/repo/src/lib/file.ts',
        'DA:1,1',
        'DA:2,0',
        'FN:3,loadThing',
        'FNDA:1,loadThing',
        'BRDA:5,0,0,1',
        'BRDA:5,0,1,0',
        'end_of_record',
      ].join('\n');
    });
    vi.mocked(fs.promises.stat).mockResolvedValue(reportStat('2026-04-22T15:05:00.000Z'));

    const summary = await readCoverageSummary('/repo');

    expect(summary?.format).toBe('lcov');
    expect(summary?.reportPath).toBe('/repo/coverage/lcov.info');
    expect(summary?.totals.lines.pct).toBe(50);
    expect(summary?.totals.functions.pct).toBe(100);
    expect(summary?.totals.branches.pct).toBe(50);
    expect(summary?.files['src/lib/file.ts']?.branches.total).toBe(2);
  });

  it('discovers nested coverage outputs under coverage/* automatically', async () => {
    mockFileExists('/repo/src/lib/file.ts');
    const nestedEntries = [
      {
        name: 'sp2',
        isDirectory: () => true,
      },
      {
        name: 'html',
        isDirectory: () => true,
      },
      {
        name: 'lcov-report',
        isDirectory: () => true,
      },
      {
        name: 'lcov.info',
        isDirectory: () => false,
      },
    ] as unknown as Awaited<ReturnType<typeof fs.promises.readdir>>;
    vi.mocked(fs.promises.readdir).mockResolvedValue(nestedEntries);
    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
      const normalized = String(filePath).split('\\').join('/');
      if (normalized.endsWith('coverage/coverage-summary.json')) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      if (normalized.endsWith('coverage/lcov.info')) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      if (normalized.endsWith('coverage/sp2/coverage-summary.json')) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      if (normalized.endsWith('coverage/sp2/lcov.info')) {
        return ['TN:', 'SF:/repo/src/lib/file.ts', 'DA:1,1', 'DA:2,1', 'end_of_record'].join('\n');
      }
      const err = new Error(`unexpected read ${normalized}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    vi.mocked(fs.promises.stat).mockResolvedValue(reportStat('2026-04-23T10:00:00.000Z'));

    const summary = await readCoverageSummary('/repo');

    expect(summary?.format).toBe('lcov');
    expect(summary?.reportPath).toBe('/repo/coverage/sp2/lcov.info');
    expect(summary?.files['src/lib/file.ts']?.lines.pct).toBe(100);
  });

  it('maps LCOV paths from another checkout of the same repo back to repo-relative files', async () => {
    mockNoNestedCoverageDir();
    mockFileExists('/home/me/repo/.worktrees/task/w1/src/lib/file.ts');
    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('coverage-summary.json')) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return ['TN:', 'SF:/home/me/repo/src/lib/file.ts', 'DA:1,1', 'DA:2,1', 'end_of_record'].join(
        '\n',
      );
    });
    vi.mocked(fs.promises.stat).mockResolvedValue(reportStat('2026-04-23T10:05:00.000Z'));

    const summary = await readCoverageSummary('/home/me/repo/.worktrees/task/w1');

    expect(summary?.files['src/lib/file.ts']?.lines.pct).toBe(100);
  });

  it('maps webpack-style source URLs back to repo-relative files', async () => {
    mockNoNestedCoverageDir();
    mockFileExists('/repo/src/lib/file.ts');
    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('coverage-summary.json')) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return ['TN:', 'SF:webpack:///src/lib/file.ts', 'DA:1,1', 'DA:2,0', 'end_of_record'].join(
        '\n',
      );
    });
    vi.mocked(fs.promises.stat).mockResolvedValue(reportStat('2026-04-23T10:10:00.000Z'));

    const summary = await readCoverageSummary('/repo');

    expect(summary?.files['src/lib/file.ts']?.lines.pct).toBe(50);
  });

  it('does not remap foreign absolute paths that do not point at this repo', async () => {
    mockNoNestedCoverageDir();
    mockFileExists('/repo/src/index.ts');
    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('coverage-summary.json')) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return [
        'TN:',
        'SF:/tmp/other-service/src/index.ts',
        'DA:1,1',
        'DA:2,0',
        'end_of_record',
      ].join('\n');
    });
    vi.mocked(fs.promises.stat).mockResolvedValue(reportStat('2026-04-23T10:12:00.000Z'));

    const summary = await readCoverageSummary('/repo');

    expect(summary?.files['src/index.ts']).toBeUndefined();
  });

  it('skips malformed earlier nested reports and keeps scanning later valid candidates', async () => {
    mockFileExists('/repo/src/lib/file.ts');
    const nestedEntries = [
      { name: 'foo', isDirectory: () => true },
      { name: 'sp2', isDirectory: () => true },
    ] as unknown as Awaited<ReturnType<typeof fs.promises.readdir>>;
    vi.mocked(fs.promises.readdir).mockResolvedValue(nestedEntries);
    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
      const normalized = String(filePath).split('\\').join('/');
      if (normalized.endsWith('coverage/coverage-summary.json')) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      if (normalized.endsWith('coverage/lcov.info')) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      if (normalized.endsWith('coverage/foo/coverage-summary.json')) {
        return '{"total":';
      }
      if (normalized.endsWith('coverage/foo/lcov.info')) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      if (normalized.endsWith('coverage/sp2/coverage-summary.json')) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      if (normalized.endsWith('coverage/sp2/lcov.info')) {
        return ['TN:', 'SF:/repo/src/lib/file.ts', 'DA:1,1', 'DA:2,1', 'end_of_record'].join('\n');
      }
      const err = new Error(`unexpected read ${normalized}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    vi.mocked(fs.promises.stat).mockResolvedValue(reportStat('2026-04-23T10:15:00.000Z'));

    const summary = await readCoverageSummary('/repo');

    expect(summary?.reportPath).toBe('/repo/coverage/sp2/lcov.info');
    expect(summary?.files['src/lib/file.ts']?.lines.pct).toBe(100);
  });

  it('uses a configured relative report path when provided', async () => {
    mockFileExists();
    vi.mocked(fs.promises.readFile).mockResolvedValue(
      JSON.stringify({
        total: {
          lines: { total: 2, covered: 2, skipped: 0, pct: 100 },
          statements: { total: 2, covered: 2, skipped: 0, pct: 100 },
          functions: { total: 1, covered: 1, skipped: 0, pct: 100 },
          branches: { total: 0, covered: 0, skipped: 0, pct: 100 },
        },
      }),
    );
    vi.mocked(fs.promises.stat).mockResolvedValue(reportStat('2026-04-22T15:10:00.000Z'));

    const summary = await readCoverageSummary('/repo', 'artifacts/custom-coverage.json');

    expect(summary?.reportPath).toBe('/repo/artifacts/custom-coverage.json');
  });

  it('returns null when every default report path is missing', async () => {
    mockNoNestedCoverageDir();
    mockFileExists();
    const err = new Error('missing') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    vi.mocked(fs.promises.stat).mockRejectedValue(err);

    await expect(readCoverageSummary('/repo')).resolves.toBeNull();
  });

  it('reuses an unchanged report and reads a replacement with the same timestamp', async () => {
    mockNoNestedCoverageDir();
    mockFileExists();
    const read = vi.mocked(fs.promises.readFile);
    const stat = vi.mocked(fs.promises.stat);
    const timestamp = '2026-04-23T15:00:00.000Z';
    stat.mockResolvedValue(reportStat(timestamp, 30));
    read.mockResolvedValue('SF:src/file.ts\nDA:1,0\nend_of_record');
    const first = await readCoverageSummary('/cache-test');
    expect(first?.totals.lines.covered).toBe(0);
    expect(await readCoverageSummary('/cache-test')).toEqual(first);
    expect(read).toHaveBeenCalledTimes(1);

    stat.mockResolvedValue(reportStat(timestamp, 40));
    read.mockResolvedValue('SF:src/file.ts\nDA:1,1\nDA:2,1\nend_of_record');
    expect((await readCoverageSummary('/cache-test'))?.totals.lines.covered).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('switches from cached LCOV to a newly created preferred report and back on deletion', async () => {
    mockNoNestedCoverageDir();
    mockFileExists();
    const root = '/report-priority';
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const stat = reportStat('2026-04-23T15:00:00.000Z');
    let hasPreferred = false;
    vi.mocked(fs.promises.stat).mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('.json') && !hasPreferred) throw missing;
      return stat;
    });
    const metric = { total: 2, covered: 1, skipped: 0, pct: 50 };
    const total = { lines: metric, statements: metric, functions: metric, branches: metric };
    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) =>
      String(filePath).endsWith('.json') ? JSON.stringify({ total }) : 'SF:a.ts\nDA:1,1',
    );

    expect((await readCoverageSummary(root))?.format).toBe('lcov');
    hasPreferred = true;
    expect((await readCoverageSummary(root))?.format).toBe('istanbul-summary');
    hasPreferred = false;
    expect((await readCoverageSummary(root))?.format).toBe('lcov');
    expect(fs.promises.readFile).toHaveBeenCalledTimes(2);
  });

  it('rechecks cross-checkout path mappings while the report stays unchanged', async () => {
    const root = '/home/me/repo/.worktrees/other';
    mockFileExists();
    vi.mocked(fs.promises.stat).mockResolvedValue(reportStat('2026-04-23T15:00:00.000Z'));
    vi.mocked(fs.promises.readFile).mockResolvedValue('SF:/elsewhere/repo/src/a.ts\nDA:1,1');
    expect((await readCoverageSummary(root, 'lcov.info'))?.files).toEqual({});
    mockFileExists(root + '/src/a.ts');
    expect((await readCoverageSummary(root, 'lcov.info'))?.files['src/a.ts']).toBeDefined();
  });

  it('returns null for malformed coverage payloads', async () => {
    mockNoNestedCoverageDir();
    mockFileExists();
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({ nope: true }));
    vi.mocked(fs.promises.stat).mockResolvedValue(reportStat('2026-04-22T15:01:00.000Z'));

    await expect(readCoverageSummary('/repo')).resolves.toBeNull();
  });
});
