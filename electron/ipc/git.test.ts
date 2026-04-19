import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promisify } from 'util';

vi.mock('child_process', () => {
  const mockExecFile = vi.fn();
  // Attach custom promisify handler so promisify(execFile) resolves with
  // { stdout, stderr } rather than just the first callback argument.
  (mockExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: unknown,
    args: unknown,
    opts: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      mockExecFile(file, args, opts, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });

  return {
    execFile: mockExecFile,
    spawn: vi.fn(() => ({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    })),
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const mockStat = vi.fn().mockRejectedValue(new Error('ENOENT'));
  const mockReadFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
  const mockRealpath = vi.fn().mockImplementation((p: string) => Promise.resolve(p));
  return {
    ...actual,
    default: {
      ...actual,
      promises: {
        ...actual.promises,
        stat: mockStat,
        readFile: mockReadFile,
        realpath: mockRealpath,
      },
    },
  };
});

import fs from 'fs';
import { execFile } from 'child_process';
import {
  getAllFileDiffsFromBranch,
  getChangedFilesFromBranch,
  getFileDiffFromBranch,
  getChangedFiles,
  getAllFileDiffs,
  getFileDiff,
} from './git.js';

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;
type MockHandler = (args: string[], cb: ExecFileCallback) => void;

/** Configure the mocked execFile — double cast avoids execFile's 12 overloads */
function setupMock(calls: string[][], handler: MockHandler): void {
  const impl = (_cmd: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
    calls.push(args);
    handler(args, cb);
  };
  vi.mocked(execFile).mockImplementation(impl as unknown as typeof execFile);
}

describe('baseBranch fallback to detectMainBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getAllFileDiffsFromBranch', () => {
    it('falls back to detected main branch when baseBranch is undefined', async () => {
      const calls: string[][] = [];
      setupMock(calls, (argsArr, cb) => {
        const isDiff = argsArr[0] === 'diff';
        cb(isDiff ? null : new Error('no remote'), '', '');
      });

      await getAllFileDiffsFromBranch('/repo', 'feature', undefined);

      const diffCall = calls.find((a) => a[0] === 'diff');
      expect(diffCall).toBeDefined();
      const refSpec = diffCall?.[2] ?? '';
      expect(refSpec).toMatch(/^main\.\.\./);
    });

    it("uses the provided baseBranch when it is 'develop'", async () => {
      const calls: string[][] = [];
      setupMock(calls, (_argsArr, cb) => {
        cb(null, '', '');
      });

      await getAllFileDiffsFromBranch('/repo', 'feature', 'develop');

      const diffCall = calls.find((a) => a[0] === 'diff');
      expect(diffCall).toBeDefined();
      const refSpec = diffCall?.[2] ?? '';
      expect(refSpec).toBe('develop...feature');
    });
  });

  describe('getChangedFilesFromBranch', () => {
    it("uses 'develop' directly when baseBranch is 'develop'", async () => {
      const calls: string[][] = [];
      setupMock(calls, (_argsArr, cb) => {
        cb(null, '', '');
      });

      await getChangedFilesFromBranch('/repo', 'feature', 'develop');

      const diffCall = calls.find((a) => a[0] === 'diff');
      const tripleRef = diffCall?.find((arg) => arg.includes('...')) ?? '';
      expect(tripleRef).toBe('develop...feature');
    });
  });

  describe('getFileDiffFromBranch', () => {
    it("uses 'develop' directly when baseBranch is 'develop'", async () => {
      const calls: string[][] = [];
      setupMock(calls, (_argsArr, cb) => {
        cb(null, '', '');
      });

      await getFileDiffFromBranch('/repo', 'feature', 'src/foo.ts', 'develop');

      const diffCall = calls.find((a) => a[0] === 'diff');
      const tripleRef = diffCall?.find((arg) => arg.includes('...')) ?? '';
      expect(tripleRef).toBe('develop...feature');
    });
  });
});

// ---------------------------------------------------------------------------
// Worktree-based diff functions (merge-base one-way diffs)
// ---------------------------------------------------------------------------

const HEAD_HASH = 'abc123def456';
const MERGE_BASE = 'merge000base';

// Counter to generate unique worktree paths per test, avoiding cross-test
// cache pollution from the module-level mergeBaseCache/mainBranchCache
// which use cacheKey(worktreePath) as part of their key.
let worktreeCounter = 0;
function uniqueWorktreePath(): string {
  return `/worktree-${++worktreeCounter}`;
}

/**
 * Build a mock handler for worktree-based functions.
 *
 * No-remote scenario: detectMergeBase returns MERGE_BASE.  All diff commands
 * use the merge-base ref for one-way diffs (feature branch changes only).
 */
function buildWorktreeMockHandler(opts: {
  mergeBase?: string;
  committedRawNumstat?: string;
  uncommittedRawNumstat?: string;
  untrackedFiles?: string;
  showOutputs?: Record<string, string>;
  diffOutput?: string;
  statusPorcelain?: string;
}): MockHandler {
  const mergeBase = opts.mergeBase ?? MERGE_BASE;

  return (args, cb) => {
    const cmd = args[0];

    // pinHead: rev-parse HEAD
    if (cmd === 'rev-parse' && args[1] === 'HEAD') {
      cb(null, HEAD_HASH + '\n', '');
      return;
    }

    // rev-parse --git-common-dir (cache key helper)
    if (cmd === 'rev-parse' && args.includes('--git-common-dir')) {
      cb(null, '.git\n', '');
      return;
    }

    // remoteTrackingRefExists: rev-parse --verify refs/remotes/origin/<branch>
    if (cmd === 'rev-parse' && args[1] === '--verify' && args[2]?.startsWith('refs/remotes/')) {
      cb(new Error('no remote'), '', '');
      return;
    }

    // resolveOriginHead: symbolic-ref refs/remotes/origin/HEAD
    if (cmd === 'symbolic-ref') {
      cb(new Error('no remote'), '', '');
      return;
    }

    // merge-base
    if (cmd === 'merge-base') {
      cb(null, mergeBase + '\n', '');
      return;
    }

    // diff --raw --numstat <mergeBase> <head> — committed changes (one-way)
    if (
      cmd === 'diff' &&
      args.includes('--raw') &&
      args.includes('--numstat') &&
      args.includes(mergeBase) &&
      args.includes(HEAD_HASH)
    ) {
      cb(null, opts.committedRawNumstat ?? '', '');
      return;
    }

    // diff --raw --numstat <head> (no mergeBase) — uncommitted changes
    if (
      cmd === 'diff' &&
      args.includes('--raw') &&
      args.includes('--numstat') &&
      args.includes(HEAD_HASH) &&
      !args.includes(mergeBase)
    ) {
      cb(null, opts.uncommittedRawNumstat ?? '', '');
      return;
    }

    // diff -U3 <mergeBase> — getAllFileDiffs unified diff (one-way)
    if (cmd === 'diff' && args.includes('-U3') && args.includes(mergeBase)) {
      cb(null, opts.diffOutput ?? '', '');
      return;
    }

    // diff <mergeBase> <head> -- <path> — getFileDiff committed diff (one-way)
    if (
      cmd === 'diff' &&
      args.includes(mergeBase) &&
      args.includes(HEAD_HASH) &&
      args.includes('--')
    ) {
      cb(null, opts.diffOutput ?? '', '');
      return;
    }

    // ls-files --others --exclude-standard — untracked files
    if (cmd === 'ls-files') {
      cb(null, opts.untrackedFiles ?? '', '');
      return;
    }

    // git show <ref>:<path>
    if (cmd === 'show' && args[1]?.includes(':')) {
      const key = args[1];
      const content = opts.showOutputs?.[key];
      if (content !== undefined) {
        cb(null, content, '');
      } else {
        cb(new Error(`path not found: ${key}`), '', '');
      }
      return;
    }

    // git status --porcelain
    if (cmd === 'status' && args.includes('--porcelain')) {
      cb(null, opts.statusPorcelain ?? '', '');
      return;
    }

    // Default: succeed with empty output
    cb(null, '', '');
  };
}

/**
 * Build a raw+numstat combined output string for a single modified file.
 * Format matches `git diff --raw --numstat` output.
 */
function rawNumstatEntry(filePath: string, added: number, removed: number, status = 'M'): string {
  return [
    `:100644 100644 aaa111 bbb222 ${status}\t${filePath}`,
    `${added}\t${removed}\t${filePath}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// getChangedFiles — worktree-based
// ---------------------------------------------------------------------------

describe('getChangedFiles (worktree-based, merge-base diff)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('committed changes (merge-base → HEAD)', () => {
    it('should include a file changed on the feature branch', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: rawNumstatEntry('feature-file.ts', 10, 2),
        }),
      );

      const files = await getChangedFiles(uniqueWorktreePath(), 'main');

      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('feature-file.ts');
    });

    it('should report correct line counts', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: rawNumstatEntry('feature-file.ts', 10, 2),
        }),
      );

      const files = await getChangedFiles(uniqueWorktreePath(), 'main');

      expect(files[0].lines_added).toBe(10);
      expect(files[0].lines_removed).toBe(2);
    });

    it('should report correct status letter for an added file', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: rawNumstatEntry('new-file.ts', 20, 0, 'A'),
        }),
      );

      const files = await getChangedFiles(uniqueWorktreePath(), 'main');

      expect(files[0].status).toBe('A');
    });

    it('should return multiple committed files', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: [
            rawNumstatEntry('file-a.ts', 5, 2),
            rawNumstatEntry('file-b.ts', 3, 1),
          ].join('\n'),
        }),
      );

      const files = await getChangedFiles(uniqueWorktreePath(), 'main');

      const paths = files.map((f) => f.path);
      expect(paths).toContain('file-a.ts');
      expect(paths).toContain('file-b.ts');
    });

    it('should mark a committed file as committed when it has no uncommitted changes', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: rawNumstatEntry('clean.ts', 4, 1),
          uncommittedRawNumstat: '',
          untrackedFiles: '',
        }),
      );

      const files = await getChangedFiles(uniqueWorktreePath(), 'main');

      expect(files[0].committed).toBe(true);
    });

    it('should mark a committed file as uncommitted when it also has local changes', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: rawNumstatEntry('dirty.ts', 4, 1),
          uncommittedRawNumstat: rawNumstatEntry('dirty.ts', 1, 0),
        }),
      );

      const files = await getChangedFiles(uniqueWorktreePath(), 'main');

      expect(files[0].committed).toBe(false);
    });

    it('should return empty list when no changes since merge-base', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: '',
        }),
      );

      const files = await getChangedFiles(uniqueWorktreePath(), 'main');

      expect(files).toEqual([]);
    });

    it('should diff against merge-base, not branch tip', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: rawNumstatEntry('file.ts', 1, 0),
        }),
      );

      await getChangedFiles(uniqueWorktreePath(), 'main');

      // The committed diff should use MERGE_BASE, not MAIN_TIP
      const diffCall = calls.find(
        (a) =>
          a[0] === 'diff' &&
          a.includes('--raw') &&
          a.includes('--numstat') &&
          a.includes(HEAD_HASH),
      );
      expect(diffCall).toBeDefined();
      expect(diffCall).toContain(MERGE_BASE);
    });
  });

  describe('uncommitted changes', () => {
    it('should include an uncommitted-only file not in the committed diff', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: rawNumstatEntry('committed.ts', 5, 0),
          uncommittedRawNumstat: rawNumstatEntry('uncommitted-only.ts', 2, 1),
        }),
      );

      const files = await getChangedFiles(uniqueWorktreePath(), 'main');

      const uncommittedFile = files.find((f) => f.path === 'uncommitted-only.ts');
      expect(uncommittedFile).toBeDefined();
    });

    it('should mark uncommitted-only files as not committed', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: rawNumstatEntry('committed.ts', 5, 0),
          uncommittedRawNumstat: rawNumstatEntry('uncommitted-only.ts', 2, 1),
        }),
      );

      const files = await getChangedFiles(uniqueWorktreePath(), 'main');

      const uncommittedFile = files.find((f) => f.path === 'uncommitted-only.ts');
      expect(uncommittedFile).toBeDefined();
      expect(uncommittedFile?.committed).toBe(false);
    });

    it('should report correct line counts for uncommitted-only files', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: '',
          uncommittedRawNumstat: rawNumstatEntry('local.ts', 7, 3),
        }),
      );

      const files = await getChangedFiles(uniqueWorktreePath(), 'main');

      const localFile = files.find((f) => f.path === 'local.ts');
      expect(localFile).toBeDefined();
      expect(localFile?.lines_added).toBe(7);
      expect(localFile?.lines_removed).toBe(3);
    });
  });
});

// ---------------------------------------------------------------------------
// getAllFileDiffs — worktree-based
// ---------------------------------------------------------------------------

describe('getAllFileDiffs (worktree-based, merge-base diff)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should diff against merge-base without file filtering', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        diffOutput: 'diff --git a/feature.ts b/feature.ts\n',
        statusPorcelain: '',
      }),
    );

    await getAllFileDiffs(uniqueWorktreePath(), 'main');

    const u3Call = calls.find((a) => a[0] === 'diff' && a.includes('-U3'));
    expect(u3Call).toBeDefined();
    expect(u3Call).toContain(MERGE_BASE);
    // No file filter (no -- separator)
    expect(u3Call).not.toContain('--');
  });

  it('should return diff output from merge-base comparison', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        diffOutput: 'diff --git a/file.ts b/file.ts\nsome changes\n',
        statusPorcelain: '',
      }),
    );

    const result = await getAllFileDiffs(uniqueWorktreePath(), 'main');

    expect(result).toContain('diff --git a/file.ts b/file.ts');
  });

  it('should return empty string when there are no changes', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        diffOutput: '',
        statusPorcelain: '',
      }),
    );

    const result = await getAllFileDiffs(uniqueWorktreePath(), 'main');

    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getFileDiff — worktree-based
// ---------------------------------------------------------------------------

describe('getFileDiff (worktree-based, merge-base diff)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return old content from merge-base', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        showOutputs: {
          [`${MERGE_BASE}:src/app.ts`]: 'old merge-base content',
          [`${HEAD_HASH}:src/app.ts`]: 'new feature content',
        },
        diffOutput: 'diff --git a/src/app.ts b/src/app.ts\n',
      }),
    );

    const result = await getFileDiff(uniqueWorktreePath(), 'src/app.ts', 'main');

    expect(result.oldContent).toBe('old merge-base content');
  });

  it('should use committed content as newContent when disk matches committed', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        showOutputs: {
          [`${MERGE_BASE}:src/app.ts`]: 'old content',
          [`${HEAD_HASH}:src/app.ts`]: 'committed new content',
        },
        diffOutput: 'some diff',
      }),
    );

    vi.mocked(fs.promises.stat).mockResolvedValueOnce({
      isFile: () => true,
      size: 100,
    } as unknown as Awaited<ReturnType<typeof fs.promises.stat>>);
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce('committed new content');

    const result = await getFileDiff(uniqueWorktreePath(), 'src/app.ts', 'main');

    expect(result.newContent).toBe('committed new content');
  });

  it('should return empty oldContent for a new file not at merge-base', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        showOutputs: {
          // merge-base:new-file.ts intentionally missing -> old content empty
          [`${HEAD_HASH}:new-file.ts`]: 'brand new content',
        },
        diffOutput: '',
      }),
    );

    vi.mocked(fs.promises.stat).mockResolvedValueOnce({
      isFile: () => true,
      size: 100,
    } as unknown as Awaited<ReturnType<typeof fs.promises.stat>>);
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce('brand new content');

    const result = await getFileDiff(uniqueWorktreePath(), 'new-file.ts', 'main');

    expect(result.oldContent).toBe('');
  });

  it('should issue diff command against merge-base ref', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        showOutputs: {
          [`${MERGE_BASE}:file.ts`]: 'old',
          [`${HEAD_HASH}:file.ts`]: 'new',
        },
        diffOutput: 'diff output',
      }),
    );

    await getFileDiff(uniqueWorktreePath(), 'file.ts', 'main');

    const diffCall = calls.find((a) => a[0] === 'diff' && a.includes('--'));
    expect(diffCall).toBeDefined();
    expect(diffCall).toContain(MERGE_BASE);
  });

  it('should include HEAD hash in the diff command', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        showOutputs: {
          [`${MERGE_BASE}:file.ts`]: 'old',
          [`${HEAD_HASH}:file.ts`]: 'new',
        },
        diffOutput: 'diff output',
      }),
    );

    await getFileDiff(uniqueWorktreePath(), 'file.ts', 'main');

    const diffCall = calls.find((a) => a[0] === 'diff' && a.includes('--'));
    expect(diffCall).toContain(HEAD_HASH);
  });

  it('should return the diff output from the merge-base-to-HEAD diff', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        showOutputs: {
          [`${MERGE_BASE}:shared.ts`]: 'content at merge-base',
          [`${HEAD_HASH}:shared.ts`]: 'content on feature',
        },
        diffOutput: 'diff for shared.ts',
      }),
    );

    const result = await getFileDiff(uniqueWorktreePath(), 'shared.ts', 'main');

    expect(result.diff).toBe('diff for shared.ts');
  });

  it('should prefer disk content over committed content when they differ', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        showOutputs: {
          [`${MERGE_BASE}:file.ts`]: 'merge-base content',
          [`${HEAD_HASH}:file.ts`]: 'committed content',
        },
        diffOutput: 'some diff',
      }),
    );

    vi.mocked(fs.promises.stat).mockResolvedValueOnce({
      isFile: () => true,
      size: 100,
    } as unknown as Awaited<ReturnType<typeof fs.promises.stat>>);
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce('disk content with local edits');

    const result = await getFileDiff(uniqueWorktreePath(), 'file.ts', 'main');

    expect(result.newContent).toBe('disk content with local edits');
  });
});
