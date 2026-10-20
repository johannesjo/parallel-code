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
  const mockOpen = vi.fn().mockRejectedValue(new Error('ENOENT'));
  const mockRealpath = vi.fn().mockImplementation((p: string) => Promise.resolve(p));
  return {
    ...actual,
    default: {
      ...actual,
      promises: {
        ...actual.promises,
        stat: mockStat,
        readFile: mockReadFile,
        open: mockOpen,
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
  getUncommittedChangedFiles,
  checkMergeStatus,
  getBranchWorktreePath,
  listImportableWorktrees,
  mergeTask,
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

// Unique repo paths per test so the module-level mergeBaseCache and
// mainBranchCache (keyed by repoRoot) do not bleed state across tests.
let repoCounter = 0;
function uniqueRepoPath(): string {
  return `/repo-${++repoCounter}`;
}

const SHA_LOCAL = 'sha000local';
const SHA_ORIGIN = 'sha000origin';

interface FromBranchMockOpts {
  branch: string;
  hasLocal?: boolean;
  hasOrigin?: boolean;
  localMb?: string;
  originMb?: string;
  // Outcome of `merge-base --is-ancestor <originMb> <localMb>` (origin's mb
  // is an ancestor of local's mb → local mb is closer to HEAD).
  originIsAncestorOfLocal?: boolean;
  // Outcome of `merge-base --is-ancestor <localMb> <originMb>`.
  localIsAncestorOfOrigin?: boolean;
}

/** Mock handler for getXxxFromBranch tests covering pickMergeBase paths. */
function fromBranchMockHandler(opts: FromBranchMockOpts): MockHandler {
  const hasLocal = opts.hasLocal ?? true;
  const hasOrigin = opts.hasOrigin ?? true;
  return (args, cb) => {
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      const ref = args[2];
      if (ref === `refs/heads/${opts.branch}`) {
        return cb(hasLocal ? null : new Error('no local'), 'exists\n', '');
      }
      if (ref === `refs/remotes/origin/${opts.branch}`) {
        return cb(hasOrigin ? null : new Error('no remote'), 'exists\n', '');
      }
      return cb(new Error('unexpected ref'), '', '');
    }
    if (args[0] === 'symbolic-ref') {
      return cb(new Error('no origin HEAD'), '', '');
    }
    if (args[0] === 'merge-base') {
      if (args[1] === '--is-ancestor') {
        const anc = args[2];
        const desc = args[3];
        if (anc === opts.originMb && desc === opts.localMb) {
          return cb(opts.originIsAncestorOfLocal ? null : new Error('no'), '', '');
        }
        if (anc === opts.localMb && desc === opts.originMb) {
          return cb(opts.localIsAncestorOfOrigin ? null : new Error('no'), '', '');
        }
        return cb(new Error('unexpected ancestor pair'), '', '');
      }
      const ref = args[1];
      if (ref === opts.branch) {
        if (opts.localMb === undefined) return cb(new Error('failed'), '', '');
        return cb(null, opts.localMb + '\n', '');
      }
      if (ref === `origin/${opts.branch}`) {
        if (opts.originMb === undefined) return cb(new Error('failed'), '', '');
        return cb(null, opts.originMb + '\n', '');
      }
      return cb(new Error('unknown ref'), '', '');
    }
    if (args[0] === 'diff') {
      return cb(null, '', '');
    }
    if (args[0] === 'show') {
      return cb(new Error('not found'), '', '');
    }
    return cb(new Error(`unhandled ${args.join(' ')}`), '', '');
  };
}

describe('from-branch diff helpers (pickMergeBase wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getAllFileDiffsFromBranch', () => {
    it('falls back to detected main branch when baseBranch is undefined', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        fromBranchMockHandler({
          branch: 'main',
          hasLocal: true,
          hasOrigin: false,
          localMb: SHA_LOCAL,
        }),
      );

      await getAllFileDiffsFromBranch(uniqueRepoPath(), 'feature', undefined);

      const mergeBaseCall = calls.find((a) => a[0] === 'merge-base' && a[1] !== '--is-ancestor');
      expect(mergeBaseCall).toBeDefined();
      expect(mergeBaseCall).toContain('main');
    });

    it('feeds the picked base ref into the one-way diff command', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        fromBranchMockHandler({
          branch: 'develop',
          hasLocal: true,
          hasOrigin: false,
          localMb: SHA_LOCAL,
        }),
      );

      await getAllFileDiffsFromBranch(uniqueRepoPath(), 'feature', 'develop');

      const diffCall = calls.find((a) => a[0] === 'diff');
      expect(diffCall).toBeDefined();
      expect(diffCall).toContain('develop...feature');
    });
  });

  describe('getChangedFilesFromBranch', () => {
    it('falls back to detected main branch when baseBranch is undefined', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        fromBranchMockHandler({
          branch: 'main',
          hasLocal: true,
          hasOrigin: false,
          localMb: SHA_LOCAL,
        }),
      );

      await getChangedFilesFromBranch(uniqueRepoPath(), 'feature', undefined);

      const mergeBaseCall = calls.find((a) => a[0] === 'merge-base' && a[1] !== '--is-ancestor');
      expect(mergeBaseCall).toBeDefined();
      expect(mergeBaseCall).toContain('main');
    });

    it('feeds the picked base ref into the one-way diff command', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        fromBranchMockHandler({
          branch: 'develop',
          hasLocal: true,
          hasOrigin: false,
          localMb: SHA_LOCAL,
        }),
      );

      await getChangedFilesFromBranch(uniqueRepoPath(), 'feature', 'develop');

      const diffCall = calls.find((a) => a[0] === 'diff');
      expect(diffCall).toBeDefined();
      expect(diffCall).toContain('develop...feature');
    });
  });

  describe('getFileDiffFromBranch', () => {
    it('feeds the picked base ref into the diff and the merge-base SHA into the show command', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        fromBranchMockHandler({
          branch: 'develop',
          hasLocal: true,
          hasOrigin: false,
          localMb: SHA_LOCAL,
        }),
      );

      await getFileDiffFromBranch(uniqueRepoPath(), 'feature', 'src/foo.ts', 'develop');

      const diffCall = calls.find((a) => a[0] === 'diff');
      expect(diffCall).toBeDefined();
      expect(diffCall).toContain('develop...feature');

      // The redundant inline `git merge-base baseRef branchName` is gone — the
      // only merge-base calls should be the picker's two probes plus optional
      // is-ancestor checks.
      const mergeBaseCalls = calls.filter((a) => a[0] === 'merge-base');
      const ancestorCalls = mergeBaseCalls.filter((a) => a[1] === '--is-ancestor');
      const probeCalls = mergeBaseCalls.filter((a) => a[1] !== '--is-ancestor');
      expect(probeCalls.length).toBeLessThanOrEqual(2);
      expect(ancestorCalls.length).toBeLessThanOrEqual(2);
    });
  });
});

describe('pickMergeBase (via getChangedFilesFromBranch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('picks local merge-base when origin merge-base is its ancestor', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      fromBranchMockHandler({
        branch: 'main',
        hasLocal: true,
        hasOrigin: true,
        localMb: SHA_LOCAL,
        originMb: SHA_ORIGIN,
        originIsAncestorOfLocal: true,
      }),
    );

    await getChangedFilesFromBranch(uniqueRepoPath(), 'feature', 'main');

    const diffCall = calls.find((a) => a[0] === 'diff');
    expect(diffCall).toContain('main...feature');
    expect(diffCall).not.toContain('origin/main...feature');
  });

  it('picks origin merge-base when local merge-base is its ancestor', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      fromBranchMockHandler({
        branch: 'main',
        hasLocal: true,
        hasOrigin: true,
        localMb: SHA_LOCAL,
        originMb: SHA_ORIGIN,
        originIsAncestorOfLocal: false,
        localIsAncestorOfOrigin: true,
      }),
    );

    await getChangedFilesFromBranch(uniqueRepoPath(), 'feature', 'main');

    const diffCall = calls.find((a) => a[0] === 'diff');
    expect(diffCall).toContain('origin/main...feature');
    expect(diffCall).not.toContain('main...feature');
  });

  it('prefers local on divergence (neither merge-base is an ancestor of the other)', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      fromBranchMockHandler({
        branch: 'main',
        hasLocal: true,
        hasOrigin: true,
        localMb: SHA_LOCAL,
        originMb: SHA_ORIGIN,
        originIsAncestorOfLocal: false,
        localIsAncestorOfOrigin: false,
      }),
    );

    await getChangedFilesFromBranch(uniqueRepoPath(), 'feature', 'main');

    const diffCall = calls.find((a) => a[0] === 'diff');
    expect(diffCall).toContain('main...feature');
    expect(diffCall).not.toContain('origin/main...feature');
  });

  it('uses local merge-base when only the local ref exists', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      fromBranchMockHandler({
        branch: 'main',
        hasLocal: true,
        hasOrigin: false,
        localMb: SHA_LOCAL,
      }),
    );

    await getChangedFilesFromBranch(uniqueRepoPath(), 'feature', 'main');

    const diffCall = calls.find((a) => a[0] === 'diff');
    expect(diffCall).toContain('main...feature');

    const ancestorCalls = calls.filter((a) => a[0] === 'merge-base' && a[1] === '--is-ancestor');
    expect(ancestorCalls.length).toBe(0);
  });

  it('uses origin merge-base when only the remote ref exists', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      fromBranchMockHandler({
        branch: 'main',
        hasLocal: false,
        hasOrigin: true,
        originMb: SHA_ORIGIN,
      }),
    );

    await getChangedFilesFromBranch(uniqueRepoPath(), 'feature', 'main');

    const diffCall = calls.find((a) => a[0] === 'diff');
    expect(diffCall).toContain('origin/main...feature');
  });

  it('returns no committed diff when neither ref resolves', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      fromBranchMockHandler({
        branch: 'gone',
        hasLocal: false,
        hasOrigin: false,
      }),
    );

    const result = await getChangedFilesFromBranch(uniqueRepoPath(), 'feature', 'gone');

    // detectOneWayDiffRange falls back to feature...feature → empty.
    expect(result).toEqual([]);

    const ancestorCalls = calls.filter((a) => a[0] === 'merge-base' && a[1] === '--is-ancestor');
    expect(ancestorCalls.length).toBe(0);
  });

  it('uses the shared SHA when local and origin merge-bases are identical', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      fromBranchMockHandler({
        branch: 'main',
        hasLocal: true,
        hasOrigin: true,
        localMb: SHA_LOCAL,
        originMb: SHA_LOCAL, // identical
      }),
    );

    await getChangedFilesFromBranch(uniqueRepoPath(), 'feature', 'main');

    const diffCall = calls.find((a) => a[0] === 'diff');
    expect(diffCall).toContain('main...feature');

    // Identical SHAs short-circuit before any --is-ancestor probe.
    const ancestorCalls = calls.filter((a) => a[0] === 'merge-base' && a[1] === '--is-ancestor');
    expect(ancestorCalls.length).toBe(0);
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
 * No-remote scenario: detectMergeBase returns MERGE_BASE. Committed snapshot
 * diffs use the ordered local base ref range (`base...head`); dirty worktree
 * diffs use the merge-base SHA directly so tracked local edits are included.
 */
function buildWorktreeMockHandler(opts: {
  mergeBase?: string;
  mergeBaseTimestamp?: string;
  finalRawNumstat?: string;
  committedRawNumstat?: string;
  uncommittedRawNumstat?: string;
  untrackedFiles?: string;
  showOutputs?: Record<string, string>;
  diffOutput?: string;
  statusPorcelain?: string;
  /**
   * Output of `git log --cherry-pick --right-only --reverse --pretty='%H %P'` —
   * newline-separated `<sha> <parent_sha>` pairs (one per unique commit, in
   * chronological order; the first line's parent SHA is what refinement
   * uses as the new base).
   */
  cherryPickUnique?: string;
  /** Output of `git rev-list --count` for the refined range. */
  refinedRangeCount?: string;
}): MockHandler {
  const mergeBase = opts.mergeBase ?? MERGE_BASE;
  let singlePointRawNumstatCalls = 0;

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

    // log --cherry-pick --right-only — refinement's unique-commit list.
    // Default produces an interleaved-fallback so existing tests (which
    // assert behavior against the picked merge-base) keep passing without
    // having to opt in to refinement defaults. New tests opt in by setting
    // `cherryPickUnique` (and matching `refinedRangeCount` for contiguity).
    if (cmd === 'log' && args.includes('--cherry-pick')) {
      const out =
        opts.cherryPickUnique !== undefined
          ? opts.cherryPickUnique
          : '__test_unique__ __test_parent__';
      cb(null, out, '');
      return;
    }

    // rev-list --count <parent>..<head> — refinement's contiguity check.
    // Default returns 999 (non-matching) → triggers interleaved fallback.
    if (cmd === 'rev-list' && args.includes('--count')) {
      cb(null, (opts.refinedRangeCount ?? '999') + '\n', '');
      return;
    }

    // diff --raw --numstat <base>...<head> — committed changes (one-way)
    if (
      cmd === 'diff' &&
      args.includes('--raw') &&
      args.includes('--numstat') &&
      args.some((arg) => arg.endsWith(`...${HEAD_HASH}`))
    ) {
      cb(null, opts.committedRawNumstat ?? '', '');
      return;
    }

    // diff --raw --numstat <baseSha> — final working tree changes against base.
    // In getChangedFiles this is the first single-point raw+numstat diff;
    // the later HEAD single-point raw+numstat diff detects local dirtiness.
    if (
      cmd === 'diff' &&
      args.includes('--raw') &&
      args.includes('--numstat') &&
      !args.some((arg) => arg.includes('...')) &&
      !args.includes(HEAD_HASH) &&
      singlePointRawNumstatCalls++ === 0
    ) {
      const fallback = [opts.committedRawNumstat, opts.uncommittedRawNumstat]
        .filter((part) => part && part.length > 0)
        .join('');
      cb(null, opts.finalRawNumstat ?? fallback, '');
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

    // diff -U3 <mergeBase> — getAllFileDiffs unified diff including tracked local edits
    if (cmd === 'diff' && args.includes('-U3') && args.includes(mergeBase)) {
      cb(null, opts.diffOutput ?? '', '');
      return;
    }

    // diff <base>...<head> -- <path> — getFileDiff committed diff (one-way)
    if (
      cmd === 'diff' &&
      args.some((arg) => arg.endsWith(`...${HEAD_HASH}`)) &&
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

    if (cmd === 'show' && args.includes('--format=%cI')) {
      cb(null, `${opts.mergeBaseTimestamp ?? ''}\n`, '');
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
 * Format matches `git diff --raw --numstat -z` output.
 */
function rawNumstatEntry(filePath: string, added: number, removed: number, status = 'M'): string {
  return `:100644 100644 aaa111 bbb222 ${status}\0${filePath}\0${added}\t${removed}\t${filePath}\0`;
}

function rawNumstatRenameEntry(
  previousPath: string,
  path: string,
  added: number,
  removed: number,
): string {
  return `:100644 100644 aaa111 bbb222 R100\0${previousPath}\0${path}\0${added}\t${removed}\t\0${previousPath}\0${path}\0`;
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

    it('should preserve the original path for renamed files', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: rawNumstatRenameEntry('src/old-name.ts', 'src/new-name.ts', 0, 0),
        }),
      );

      const files = await getChangedFiles(uniqueWorktreePath(), 'main');

      expect(files).toEqual([
        expect.objectContaining({
          path: 'src/new-name.ts',
          previous_path: 'src/old-name.ts',
          status: 'R',
        }),
      ]);
    });

    it.each([
      ['dir/old => literal.ts', 'dir/new.ts'],
      ['dir/{old}.ts', 'dir/{new}.ts'],
    ])('should preserve exact Git paths when renaming %s', async (previousPath, path) => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: rawNumstatRenameEntry(previousPath, path, 4, 2),
        }),
      );

      const files = await getChangedFiles(uniqueWorktreePath(), 'main');

      expect(files).toEqual([
        expect.objectContaining({
          path,
          previous_path: previousPath,
          lines_added: 4,
          lines_removed: 2,
          status: 'R',
        }),
      ]);
      expect(
        calls.some((args) => args[0] === 'diff' && args.includes('--raw') && args.includes('-z')),
      ).toBe(true);
    });

    it('should preserve a literal arrow in an ordinary modified filename', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: rawNumstatEntry('ordinary => modified.txt', 3, 1),
        }),
      );

      const files = await getChangedFiles(uniqueWorktreePath(), 'main');

      expect(files).toEqual([
        expect.objectContaining({
          path: 'ordinary => modified.txt',
          lines_added: 3,
          lines_removed: 1,
          status: 'M',
        }),
      ]);
    });

    it('should return multiple committed files', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: [
            rawNumstatEntry('file-a.ts', 5, 2),
            rawNumstatEntry('file-b.ts', 3, 1),
          ].join(''),
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
          finalRawNumstat: rawNumstatEntry('dirty.ts', 5, 1),
          committedRawNumstat: rawNumstatEntry('dirty.ts', 4, 1),
          uncommittedRawNumstat: rawNumstatEntry('dirty.ts', 1, 0),
        }),
      );

      const files = await getChangedFiles(uniqueWorktreePath(), 'main');

      expect(files[0].committed).toBe(false);
    });

    it('should report final line counts when committed files also have local changes', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          finalRawNumstat: rawNumstatEntry('dirty.ts', 7, 2),
          committedRawNumstat: rawNumstatEntry('dirty.ts', 4, 1),
          uncommittedRawNumstat: rawNumstatEntry('dirty.ts', 10, 9),
        }),
      );

      const files = await getChangedFiles(uniqueWorktreePath(), 'main');

      expect(files[0].path).toBe('dirty.ts');
      expect(files[0].lines_added).toBe(7);
      expect(files[0].lines_removed).toBe(2);
      expect(files[0].committed).toBe(false);
    });

    it('should compare changed-file stats from merge-base to the working tree', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          finalRawNumstat: rawNumstatEntry('file.ts', 1, 0),
        }),
      );

      await getChangedFiles(uniqueWorktreePath(), 'main');

      const diffCall = calls.find(
        (a) =>
          a[0] === 'diff' &&
          a.includes('--raw') &&
          a.includes('--numstat') &&
          a.includes(MERGE_BASE),
      );
      expect(diffCall).toBeDefined();
      expect(diffCall).toContain(MERGE_BASE);
      expect(diffCall).not.toContain('main...');
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

    it('should not use a branch-tip-to-base range for changed-file stats', async () => {
      const calls: string[][] = [];
      setupMock(
        calls,
        buildWorktreeMockHandler({
          committedRawNumstat: rawNumstatEntry('file.ts', 1, 0),
        }),
      );

      await getChangedFiles(uniqueWorktreePath(), 'main');

      // Diff-base detection/refinement may inspect base...head ranges, but
      // changed-file counts use the picked base SHA against the working tree.
      const statsCall = calls.find(
        (a) =>
          a[0] === 'diff' &&
          a.includes('--raw') &&
          a.includes('--numstat') &&
          a.includes(MERGE_BASE),
      );
      expect(statsCall).toBeDefined();
      expect(statsCall).not.toContain(`${HEAD_HASH}...main`);
    });

    it('probes both local and origin refs when both exist', async () => {
      // The picker must consult both candidate refs so it can compare which
      // merge-base is closer to HEAD; a regression that always preferred one
      // side (the previous bug) would only invoke merge-base for that side.
      const calls: string[][] = [];
      const baseHandler = buildWorktreeMockHandler({
        committedRawNumstat: rawNumstatEntry('feat.ts', 1, 0),
      });
      setupMock(calls, (args, cb) => {
        if (
          args[0] === 'rev-parse' &&
          args[1] === '--verify' &&
          (args[2] === 'refs/remotes/origin/main' || args[2] === 'refs/heads/main')
        ) {
          cb(null, 'ref-exists\n', '');
          return;
        }
        baseHandler(args, cb);
      });

      await getChangedFiles(uniqueWorktreePath(), 'main');

      const mergeBaseProbes = calls.filter(
        (a) => a[0] === 'merge-base' && a[1] !== '--is-ancestor',
      );
      const probedRefs = mergeBaseProbes.map((a) => a[1]);
      expect(probedRefs).toContain('main');
      expect(probedRefs).toContain('origin/main');
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

  it('should diff the working tree from the merge-base without file filtering', async () => {
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
    expect(u3Call).not.toContain('main...');
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

  it('should issue diff command as a one-way base-to-head range', async () => {
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
    expect(diffCall).toContain(`main...${HEAD_HASH}`);
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
    expect(diffCall?.some((arg) => arg.includes(HEAD_HASH))).toBe(true);
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

  it('should not add a phantom line in pseudo-diffs for new files ending in a newline', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        showOutputs: {},
        diffOutput: '',
      }),
    );

    vi.mocked(fs.promises.stat).mockResolvedValueOnce({
      isFile: () => true,
      size: 100,
    } as unknown as Awaited<ReturnType<typeof fs.promises.stat>>);
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce('one\ntwo\n');
    vi.mocked(fs.promises.open).mockResolvedValueOnce({
      read: vi.fn(async (buffer: Buffer) => {
        buffer.write('one');
        return { bytesRead: 3, buffer };
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<typeof fs.promises.open>>);

    const result = await getFileDiff(uniqueWorktreePath(), 'new-file.ts', 'main');

    expect(result.diff).toContain('@@ -0,0 +1,2 @@');
    expect(result.diff).toContain('+one\n+two\n');
    expect(result.diff).not.toContain('+two\n+\n');
  });
});

// ---------------------------------------------------------------------------
// getUncommittedChangedFiles — HEAD-to-working-tree file stats
// ---------------------------------------------------------------------------

describe('getUncommittedChangedFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports tracked local edits with HEAD-to-working-tree line counts', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        finalRawNumstat: rawNumstatEntry('dirty.ts', 7, 2),
        uncommittedRawNumstat: rawNumstatEntry('dirty.ts', 10, 9),
      }),
    );

    const files = await getUncommittedChangedFiles(uniqueWorktreePath());

    expect(files).toEqual([
      {
        path: 'dirty.ts',
        lines_added: 10,
        lines_removed: 9,
        status: 'M',
        committed: false,
      },
    ]);
  });

  it('reports local reverts even when the final merge-base diff would be empty', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        finalRawNumstat: '',
        uncommittedRawNumstat: rawNumstatEntry('reverted-to-base.ts', 4, 4),
      }),
    );

    const files = await getUncommittedChangedFiles(uniqueWorktreePath());

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('reverted-to-base.ts');
    expect(files[0].lines_added).toBe(4);
    expect(files[0].lines_removed).toBe(4);
  });

  it('includes untracked files with added line counts', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        untrackedFiles: 'new-file.ts\n',
      }),
    );
    vi.mocked(fs.promises.stat).mockResolvedValueOnce({
      isFile: () => true,
      size: 100,
    } as unknown as Awaited<ReturnType<typeof fs.promises.stat>>);
    vi.mocked(fs.promises.readFile).mockResolvedValueOnce(Buffer.from('one\ntwo\n'));

    const files = await getUncommittedChangedFiles(uniqueWorktreePath());

    expect(files).toEqual([
      {
        path: 'new-file.ts',
        lines_added: 2,
        lines_removed: 0,
        status: '?',
        committed: false,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Cherry-pick refinement: drops rebased patch-equivalent commits from the
// diff range when the unique commits are contiguous at the tip.
// ---------------------------------------------------------------------------

describe('refineDiffBaseWithCherryPick (via getChangedFiles)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const UNIQUE_COMMIT = 'unique000abc';
  const UNIQUE_PARENT = 'parent00xyz';

  it('refines diff base to oldest unique commit parent when commits are contiguous at tip', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        committedRawNumstat: rawNumstatEntry('feat.ts', 5, 1),
        cherryPickUnique: `${UNIQUE_COMMIT} ${UNIQUE_PARENT}`,
        refinedRangeCount: '1',
      }),
    );

    await getChangedFiles(uniqueWorktreePath(), 'main');

    const statsCall = calls.find(
      (a) =>
        a[0] === 'diff' &&
        a.includes('--raw') &&
        a.includes('--numstat') &&
        a.includes(UNIQUE_PARENT),
    );
    expect(statsCall).toBeDefined();
    expect(statsCall).toContain(UNIQUE_PARENT);
    expect(statsCall).not.toContain(MERGE_BASE);
  });

  it('refines correctly with multiple contiguous unique commits', async () => {
    const calls: string[][] = [];
    const sha2 = 'unique000def';
    const sha3 = 'unique000ghi';
    setupMock(
      calls,
      buildWorktreeMockHandler({
        committedRawNumstat: rawNumstatEntry('feat.ts', 5, 1),
        // --reverse order: oldest first. Refinement keys off line[0]'s parent.
        cherryPickUnique: [
          `${UNIQUE_COMMIT} ${UNIQUE_PARENT}`,
          `${sha2} ${UNIQUE_COMMIT}`,
          `${sha3} ${sha2}`,
        ].join('\n'),
        refinedRangeCount: '3', // 3 commits in (parent..HEAD], 3 unique → contiguous
      }),
    );

    await getChangedFiles(uniqueWorktreePath(), 'main');

    const statsCall = calls.find(
      (a) =>
        a[0] === 'diff' &&
        a.includes('--raw') &&
        a.includes('--numstat') &&
        a.includes(UNIQUE_PARENT),
    );
    expect(statsCall).toBeDefined();
    expect(statsCall).toContain(UNIQUE_PARENT);
    expect(statsCall).not.toContain(MERGE_BASE);
  });

  it('falls back to picked base when unique commits are interleaved with patch-equivalent ones', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        committedRawNumstat: rawNumstatEntry('feat.ts', 5, 1),
        cherryPickUnique: `${UNIQUE_COMMIT} ${UNIQUE_PARENT}`, // 1 unique
        refinedRangeCount: '5', // 5 commits in the range → 4 are patch-equivalent
      }),
    );

    await getChangedFiles(uniqueWorktreePath(), 'main');

    const statsCall = calls.find(
      (a) =>
        a[0] === 'diff' && a.includes('--raw') && a.includes('--numstat') && a.includes(MERGE_BASE),
    );
    expect(statsCall).toBeDefined();
    // Falls back to the original picked merge-base, not the refined SHA.
    expect(statsCall).toContain(MERGE_BASE);
    expect(statsCall).not.toContain(UNIQUE_PARENT);
  });

  it('collapses diff range to head...head when branch is fully merged upstream', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        committedRawNumstat: '',
        cherryPickUnique: '', // fully merged — no unique commits
      }),
    );

    await getChangedFiles(uniqueWorktreePath(), 'main');

    const statsCall = calls.find(
      (a) =>
        a[0] === 'diff' &&
        a.includes('--raw') &&
        a.includes('--numstat') &&
        !a.some((arg) => arg.includes('...')),
    );
    expect(statsCall).toBeDefined();
    // Stats anchor collapses to HEAD — no patch-equivalent noise.
    expect(statsCall).toContain(HEAD_HASH);
    expect(statsCall).not.toContain(MERGE_BASE);

    // Refinement short-circuits: no rev-list count needed.
    const revListCounts = calls.filter((a) => a[0] === 'rev-list' && a.includes('--count'));
    expect(revListCounts).toHaveLength(0);
  });

  it('uses refined SHA for the working-tree single-point diff (getAllFileDiffs)', async () => {
    const calls: string[][] = [];
    setupMock(
      calls,
      buildWorktreeMockHandler({
        diffOutput: 'diff --git a/file.ts b/file.ts\n',
        cherryPickUnique: `${UNIQUE_COMMIT} ${UNIQUE_PARENT}`,
        refinedRangeCount: '1',
      }),
    );

    await getAllFileDiffs(uniqueWorktreePath(), 'main');

    const u3Call = calls.find((a) => a[0] === 'diff' && a.includes('-U3'));
    expect(u3Call).toBeDefined();
    // After refinement, single-point diff anchors on the refined parent SHA,
    // not the original merge-base.
    expect(u3Call).toContain(UNIQUE_PARENT);
    expect(u3Call).not.toContain(MERGE_BASE);
  });
});

// ---------------------------------------------------------------------------
// Refinement applies on the from-branch path too (getChangedFilesFromBranch),
// not just the worktree-based path.
// ---------------------------------------------------------------------------

describe('refineDiffBaseWithCherryPick (via getChangedFilesFromBranch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refines diff range when called with a branch name (not HEAD)', async () => {
    const calls: string[][] = [];
    const SHA = 'br000sha';
    const PARENT = 'br000par';

    setupMock(calls, (args, cb) => {
      const [cmd] = args;
      if (cmd === 'rev-parse' && args[1] === '--verify') {
        const ref = args[2];
        if (ref === 'refs/heads/main') return cb(null, 'exists\n', '');
        return cb(new Error('no remote'), '', '');
      }
      if (cmd === 'symbolic-ref') return cb(new Error('no remote'), '', '');
      if (cmd === 'merge-base') return cb(null, MERGE_BASE + '\n', '');
      if (cmd === 'log' && args.includes('--cherry-pick')) {
        return cb(null, `${SHA} ${PARENT}\n`, '');
      }
      if (cmd === 'rev-list' && args.includes('--count')) {
        return cb(null, '1\n', '');
      }
      if (cmd === 'diff') return cb(null, '', '');
      return cb(null, '', '');
    });

    await getChangedFilesFromBranch(uniqueRepoPath(), 'feature', 'main');

    const diffCall = calls.find((a) => a[0] === 'diff');
    expect(diffCall).toBeDefined();
    // Range uses the refined parent SHA against the branch ref (not HEAD).
    expect(diffCall).toContain(`${PARENT}..feature`);
  });
});

// ---------------------------------------------------------------------------
// listImportableWorktrees — importing existing worktrees is git-only, so plain
// folders should not surface raw git errors in the renderer.
// ---------------------------------------------------------------------------

describe('listImportableWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no candidates for non-git project roots', async () => {
    const calls: string[][] = [];
    setupMock(calls, (args, cb) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return cb(new Error('not a git repository'), '', 'fatal: not a git repository');
      }
      return cb(new Error(`unexpected git call: ${args.join(' ')}`), '', '');
    });

    await expect(listImportableWorktrees('/home/me/.codex')).resolves.toEqual([]);
    expect(calls).toEqual([['rev-parse', '--show-toplevel']]);
  });
});

describe('getBranchWorktreePath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns only an existing worktree on the requested branch', async () => {
    const calls: string[][] = [];
    setupMock(calls, (args, cb) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return cb(
          null,
          [
            'worktree /repo',
            'HEAD aaa111',
            'branch refs/heads/main',
            '',
            'worktree /repo-task',
            'HEAD bbb222',
            'branch refs/heads/task/coverage',
            '',
          ].join('\n'),
          '',
        );
      }
      if (args[0] === 'show') {
        return cb(null, '2026-07-25T12:00:00-04:00\n', '');
      }
      return cb(new Error(`unexpected git call: ${args.join(' ')}`), '', '');
    });

    await expect(getBranchWorktreePath('/repo', 'main')).resolves.toEqual({
      path: '/repo',
      head: 'aaa111',
      headCommittedAt: '2026-07-25T16:00:00.000Z',
    });
    await expect(getBranchWorktreePath('/repo', 'missing')).resolves.toBeNull();
    expect(calls).toEqual([
      ['worktree', 'list', '--porcelain'],
      ['show', '-s', '--format=%cI', 'aaa111'],
      ['worktree', 'list', '--porcelain'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// checkMergeStatus — main-ahead count uses cherry-pick filtering so rebased
// patch-equivalent commits in main don't trigger a needless rebase prompt.
// ---------------------------------------------------------------------------

describe('checkMergeStatus (cherry-pick filtered ahead count)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks rev-list to count with --cherry-pick --right-only against HEAD...mainBranch', async () => {
    const calls: string[][] = [];
    setupMock(calls, (args, cb) => {
      const [cmd] = args;
      if (cmd === 'rev-list' && args.includes('--count')) {
        return cb(null, '0\n', '');
      }
      return cb(null, '', '');
    });

    await checkMergeStatus(uniqueWorktreePath(), 'main');

    const revListCall = calls.find((a) => a[0] === 'rev-list' && a.includes('--count'));
    expect(revListCall).toBeDefined();
    expect(revListCall).toContain('--cherry-pick');
    expect(revListCall).toContain('--right-only');
    expect(revListCall).toContain('HEAD...main');
    // --no-merges would silently drop merge commits with unique content
    // (evil merges) and undercount truly-ahead main, so it must not be set.
    expect(revListCall).not.toContain('--no-merges');
  });

  it('reports zero ahead when every main commit is patch-equivalent to one in HEAD', async () => {
    const calls: string[][] = [];
    setupMock(calls, (args, cb) => {
      const [cmd] = args;
      if (cmd === 'rev-list' && args.includes('--count')) {
        // --cherry-pick filters patch-equivalents → none unique on the right.
        return cb(null, '0\n', '');
      }
      return cb(null, '', '');
    });

    const result = await checkMergeStatus(uniqueWorktreePath(), 'main');

    expect(result.main_ahead_count).toBe(0);
    expect(result.conflicting_files).toEqual([]);
    // Conflict probe must be skipped when ahead count is zero.
    const mergeTreeCall = calls.find((a) => a[0] === 'merge-tree');
    expect(mergeTreeCall).toBeUndefined();
  });

  it('runs the conflict probe and surfaces conflicting files when main is genuinely ahead', async () => {
    const calls: string[][] = [];
    setupMock(calls, (args, cb) => {
      const [cmd] = args;
      if (cmd === 'rev-list' && args.includes('--count')) {
        // 2 commits in main are unique after cherry-pick filtering.
        return cb(null, '2\n', '');
      }
      if (cmd === 'merge-tree') {
        // git merge-tree exits non-zero and emits conflict info on stderr/stdout
        // when the trial merge fails — checkMergeStatus parses the rejection.
        const err = new Error(
          'CONFLICT (content): Merge conflict in src/foo.ts\nCONFLICT (content): Merge conflict in src/bar.ts',
        );
        return cb(err, '', '');
      }
      return cb(null, '', '');
    });

    const result = await checkMergeStatus(uniqueWorktreePath(), 'main');

    expect(result.main_ahead_count).toBe(2);
    const mergeTreeCall = calls.find((a) => a[0] === 'merge-tree');
    expect(mergeTreeCall).toBeDefined();
    expect(mergeTreeCall).toContain('HEAD');
    expect(mergeTreeCall).toContain('main');
    expect(result.conflicting_files).toEqual(['src/foo.ts', 'src/bar.ts']);
  });
});

// ---------------------------------------------------------------------------
// mergeTask — mergeWorktreePath skips checkout and routes ops to that path
// ---------------------------------------------------------------------------

describe('mergeTask (mergeWorktreePath)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips git checkout and routes status/merge ops through mergeWorktreePath', async () => {
    type CallRecord = { args: string[]; cwd: string | undefined };
    const callRecords: CallRecord[] = [];

    vi.mocked(execFile).mockImplementation(((
      _cmd: string,
      args: string[],
      opts: unknown,
      cb: ExecFileCallback,
    ) => {
      callRecords.push({ args, cwd: (opts as { cwd?: string } | null)?.cwd });

      const [cmd] = args;
      // Repo lock key
      if (cmd === 'rev-parse' && args.includes('--git-common-dir')) return cb(null, '.git\n', '');
      // localBranchExists('main') → true; all other --verify refs → false
      if (cmd === 'rev-parse' && args[1] === '--verify' && args[2] === 'refs/heads/main')
        return cb(null, 'sha\n', '');
      if (cmd === 'rev-parse' && args[1] === '--verify') return cb(new Error('no ref'), '', '');
      // No remote HEAD
      if (cmd === 'symbolic-ref') return cb(new Error('no remote'), '', '');
      // merge-base for diff-base detection
      if (cmd === 'merge-base') return cb(null, 'mergebase000\n', '');
      // cherry-pick unique-commit list — empty means fully merged (→ no rev-list call)
      if (cmd === 'log' && args.includes('--cherry-pick')) return cb(null, '', '');
      // diff stats
      if (cmd === 'diff') return cb(null, '', '');
      // status --porcelain — clean working tree
      if (cmd === 'status') return cb(null, '', '');
      // merge
      if (cmd === 'merge') return cb(null, '', '');
      return cb(null, '', '');
    }) as unknown as typeof execFile);

    const projectRoot = uniqueRepoPath();
    const mergeWorktreePath = uniqueRepoPath();
    const branchName = 'feature/test-branch';

    await mergeTask(
      projectRoot,
      branchName,
      false, // squash
      null, // message
      false, // cleanup
      'main', // baseBranch
      undefined,
      mergeWorktreePath,
    );

    // git checkout must never be called when mergeWorktreePath is supplied
    expect(callRecords.some((r) => r.args[0] === 'checkout')).toBe(false);

    // git merge must be called, and every such call must use mergeWorktreePath as cwd
    const mergeCalls = callRecords.filter((r) => r.args[0] === 'merge');
    expect(mergeCalls.length).toBeGreaterThan(0);
    for (const r of mergeCalls) {
      expect(r.cwd).toBe(mergeWorktreePath);
    }

    // git status --porcelain must be called with mergeWorktreePath as cwd
    const statusCalls = callRecords.filter(
      (r) => r.args[0] === 'status' && r.args.includes('--porcelain'),
    );
    expect(statusCalls.length).toBeGreaterThan(0);
    for (const r of statusCalls) {
      expect(r.cwd).toBe(mergeWorktreePath);
    }
  });
});
