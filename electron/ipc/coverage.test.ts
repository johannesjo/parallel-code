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
      readFileSync: vi.fn(),
    },
  };
});

import fs from 'fs';
import { readCoverageSummary } from './coverage.js';

describe('readCoverageSummary', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

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
    vi.mocked(fs.promises.stat).mockResolvedValue({
      mtime: new Date('2026-04-22T15:00:00.000Z'),
    } as fs.Stats);

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
    vi.mocked(fs.promises.stat).mockResolvedValue({
      mtime: new Date('2026-04-22T15:05:00.000Z'),
    } as fs.Stats);

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
    vi.mocked(fs.promises.stat).mockResolvedValue({
      mtime: new Date('2026-04-23T10:00:00.000Z'),
    } as fs.Stats);

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
    vi.mocked(fs.promises.stat).mockResolvedValue({
      mtime: new Date('2026-04-23T10:05:00.000Z'),
    } as fs.Stats);

    const summary = await readCoverageSummary('/home/me/repo/.worktrees/task/w1');

    expect(summary?.files['src/lib/file.ts']?.lines.pct).toBe(100);
  });

  it('maps LCOV paths from the main checkout when the worktree lives outside the repo', async () => {
    mockNoNestedCoverageDir();
    mockFileExists('/home/me/worktrees/task/w2/src/lib/file.ts');
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (String(filePath) === '/home/me/worktrees/task/w2/.git')
        return 'gitdir: /home/me/repo/.git/worktrees/w2\n';
      throw new Error('missing');
    });
    vi.mocked(fs.promises.readFile).mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('coverage-summary.json')) {
        const err = new Error('missing') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return ['TN:', 'SF:/home/me/repo/src/lib/file.ts', 'DA:1,1', 'DA:2,0', 'end_of_record'].join(
        '\n',
      );
    });
    vi.mocked(fs.promises.stat).mockResolvedValue({
      mtime: new Date('2026-04-23T10:05:00.000Z'),
    } as fs.Stats);

    const summary = await readCoverageSummary('/home/me/worktrees/task/w2');

    expect(summary?.files['src/lib/file.ts']?.lines.pct).toBe(50);
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
    vi.mocked(fs.promises.stat).mockResolvedValue({
      mtime: new Date('2026-04-23T10:10:00.000Z'),
    } as fs.Stats);

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
    vi.mocked(fs.promises.stat).mockResolvedValue({
      mtime: new Date('2026-04-23T10:12:00.000Z'),
    } as fs.Stats);

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
    vi.mocked(fs.promises.stat).mockResolvedValue({
      mtime: new Date('2026-04-23T10:15:00.000Z'),
    } as fs.Stats);

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
    vi.mocked(fs.promises.stat).mockResolvedValue({
      mtime: new Date('2026-04-22T15:10:00.000Z'),
    } as fs.Stats);

    const summary = await readCoverageSummary('/repo', 'artifacts/custom-coverage.json');

    expect(summary?.reportPath).toBe('/repo/artifacts/custom-coverage.json');
  });

  it('returns null when every default report path is missing', async () => {
    mockNoNestedCoverageDir();
    mockFileExists();
    const err = new Error('missing') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    vi.mocked(fs.promises.readFile).mockRejectedValue(err);

    await expect(readCoverageSummary('/repo')).resolves.toBeNull();
  });

  it('returns null for malformed coverage payloads', async () => {
    mockNoNestedCoverageDir();
    mockFileExists();
    vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify({ nope: true }));
    vi.mocked(fs.promises.stat).mockResolvedValue({
      mtime: new Date('2026-04-22T15:00:00.000Z'),
    } as fs.Stats);

    await expect(readCoverageSummary('/repo')).resolves.toBeNull();
  });
});
