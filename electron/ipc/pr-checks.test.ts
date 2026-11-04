import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promisify } from 'util';

const { mockStat } = vi.hoisted(() => ({
  mockStat: vi.fn(),
}));

vi.mock('child_process', () => {
  const mockExecFile = vi.fn();
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
  return { execFile: mockExecFile };
});

vi.mock('fs/promises', () => ({
  stat: mockStat,
}));

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
    on(): void {}
    show(): void {}
    close(): void {}
  },
}));

import { execFile } from 'child_process';
import {
  summarize,
  rollupBucket,
  isPrUrl,
  fetchPrStatus,
  listOpenPrUrlsForBranch,
  __resetForTests,
  __getStateForTests,
  __runTickForTests,
  initPrChecks,
  refreshPrChecksWatcher,
  startPrChecksWatcher,
  stopPrChecksWatcher,
  type PrCheckRun,
} from './pr-checks.js';

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
type GhHandler = (args: string[], cb: ExecCb, cmd: string) => void;

function stubGh(handler: GhHandler): string[][] {
  const calls: string[][] = [];
  const impl = (cmd: string, args: string[], _opts: unknown, cb: ExecCb) => {
    if (cmd === 'git' && args[0] === 'remote') {
      cb(null, 'origin\n', '');
      return;
    }
    calls.push(args);
    handler(args, cb, cmd);
  };
  vi.mocked(execFile).mockImplementation(impl as unknown as typeof execFile);
  return calls;
}

const run = (name: string, bucket: PrCheckRun['bucket']): PrCheckRun => ({
  name,
  bucket,
});

const flushPromises = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fakeWindow(send: ReturnType<typeof vi.fn>): Parameters<typeof initPrChecks>[0] {
  return {
    on: vi.fn(),
    isDestroyed: () => false,
    isVisible: () => false,
    webContents: { send },
    show: vi.fn(),
    focus: vi.fn(),
  } as unknown as Parameters<typeof initPrChecks>[0];
}

beforeEach(() => {
  mockStat.mockResolvedValue({ isDirectory: () => true });
});

describe('summarize', () => {
  it('empty list is none with zero counts', () => {
    expect(summarize([])).toEqual({ overall: 'none', passing: 0, pending: 0, failing: 0 });
  });
  it('any pending wins over fail', () => {
    expect(summarize([run('a', 'pending'), run('b', 'fail')])).toEqual({
      overall: 'pending',
      passing: 0,
      pending: 1,
      failing: 1,
    });
  });
  it('fail without pending is failure', () => {
    expect(summarize([run('a', 'pass'), run('b', 'fail')])).toEqual({
      overall: 'failure',
      passing: 1,
      pending: 0,
      failing: 1,
    });
  });
  it('cancel counts as failure', () => {
    expect(summarize([run('a', 'pass'), run('b', 'cancel')])).toEqual({
      overall: 'failure',
      passing: 1,
      pending: 0,
      failing: 1,
    });
  });
  it('all pass is success', () => {
    expect(summarize([run('a', 'pass'), run('b', 'pass')])).toEqual({
      overall: 'success',
      passing: 2,
      pending: 0,
      failing: 0,
    });
  });
  it('skipping counts as passing', () => {
    expect(summarize([run('a', 'pass'), run('b', 'skipping')])).toEqual({
      overall: 'success',
      passing: 2,
      pending: 0,
      failing: 0,
    });
  });
});

describe('rollupBucket', () => {
  it('maps CheckRun conclusions', () => {
    expect(rollupBucket('COMPLETED', 'SUCCESS', undefined)).toBe('pass');
    expect(rollupBucket('COMPLETED', 'FAILURE', undefined)).toBe('fail');
    expect(rollupBucket('COMPLETED', 'TIMED_OUT', undefined)).toBe('fail');
    expect(rollupBucket('COMPLETED', 'STARTUP_FAILURE', undefined)).toBe('fail');
    expect(rollupBucket('COMPLETED', 'ACTION_REQUIRED', undefined)).toBe('fail');
    expect(rollupBucket('COMPLETED', 'STALE', undefined)).toBe('fail');
    expect(rollupBucket('COMPLETED', 'CANCELLED', undefined)).toBe('cancel');
    expect(rollupBucket('COMPLETED', 'SKIPPED', undefined)).toBe('skipping');
    expect(rollupBucket('COMPLETED', 'NEUTRAL', undefined)).toBe('skipping');
  });
  it('treats non-completed status as pending', () => {
    expect(rollupBucket('IN_PROGRESS', null as unknown as undefined, undefined)).toBe('pending');
    expect(rollupBucket('QUEUED', undefined, undefined)).toBe('pending');
    expect(rollupBucket('WAITING', undefined, undefined)).toBe('pending');
  });
  it('treats unknown conclusions as fail (safe default)', () => {
    expect(rollupBucket('COMPLETED', 'SOMETHING_NEW', undefined)).toBe('fail');
  });
  it('maps legacy status-context state', () => {
    expect(rollupBucket(undefined, undefined, 'SUCCESS')).toBe('pass');
    expect(rollupBucket(undefined, undefined, 'PENDING')).toBe('pending');
    expect(rollupBucket(undefined, undefined, 'FAILURE')).toBe('fail');
    expect(rollupBucket(undefined, undefined, 'ERROR')).toBe('fail');
    expect(rollupBucket(undefined, undefined, 'GARBAGE')).toBe('fail');
  });
  it('returns null when nothing useful is present', () => {
    expect(rollupBucket(undefined, undefined, undefined)).toBe(null);
  });
});

describe('isPrUrl', () => {
  it('accepts PR URLs', () => {
    expect(isPrUrl('https://github.com/acme/app/pull/42')).toBe(true);
    expect(isPrUrl('https://code.acme.test/acme/app/pull/42')).toBe(true);
    expect(isPrUrl('http://code.acme.test/acme/app/pull/42')).toBe(false);
    expect(isPrUrl('https://www.github.com/acme/app/pull/1')).toBe(true);
  });
  it('rejects issues, discussions, and malformed PR URLs', () => {
    expect(isPrUrl('https://github.com/acme/app/issues/42')).toBe(false);
    expect(isPrUrl('https://gitlab.com/acme/app/-/merge_requests/42')).toBe(false);
    expect(isPrUrl('not a url')).toBe(false);
    expect(isPrUrl('https://github.com/acme/app')).toBe(false);
    expect(isPrUrl('https://github.com/acme/app/pull/abc')).toBe(false);
  });
  it('rejects URLs carrying credentials', () => {
    expect(isPrUrl('https://user:pass@github.com/a/b/pull/1')).toBe(false);
    expect(isPrUrl('https://user@github.com/a/b/pull/1')).toBe(false);
  });
});

describe('fetchPrStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
  });

  it('parses statusCheckRollup conclusions into buckets', async () => {
    const payload = {
      state: 'OPEN',
      headRefOid: 'abc123',
      isDraft: true,
      reviewDecision: 'CHANGES_REQUESTED',
      mergeable: 'CONFLICTING',
      statusCheckRollup: [
        { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'lint', status: 'IN_PROGRESS', conclusion: null },
        { name: 'flake', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'doc', status: 'COMPLETED', conclusion: 'SKIPPED' },
        { name: 'cancel', status: 'COMPLETED', conclusion: 'CANCELLED' },
        // Legacy status-context shape:
        { context: 'ci/legacy', state: 'SUCCESS' },
      ],
    };
    const calls = stubGh((_args, cb) => cb(null, JSON.stringify(payload), ''));
    const out = await fetchPrStatus('https://github.com/a/b/pull/1');
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe('pr');
    expect(calls[0][1]).toBe('view');
    expect(calls[0]).toContain(
      'state,mergedAt,headRefOid,isDraft,reviewDecision,mergeable,statusCheckRollup',
    );
    expect(out.state).toBe('OPEN');
    expect(out.headRefOid).toBe('abc123');
    expect(out.isDraft).toBe(true);
    expect(out.reviewDecision).toBe('CHANGES_REQUESTED');
    expect(out.mergeable).toBe('CONFLICTING');
    expect(out.checks).toEqual([
      { name: 'build', bucket: 'pass' },
      { name: 'lint', bucket: 'pending' },
      { name: 'flake', bucket: 'fail' },
      { name: 'doc', bucket: 'skipping' },
      { name: 'cancel', bucket: 'cancel' },
      { name: 'ci/legacy', bucket: 'pass' },
    ]);
  });

  it('returns empty checks when response is malformed', async () => {
    stubGh((_args, cb) => cb(null, JSON.stringify(null), ''));
    const out = await fetchPrStatus('https://github.com/a/b/pull/1');
    expect(out).toEqual({
      state: 'UNKNOWN',
      headRefOid: '',
      isDraft: false,
      reviewDecision: null,
      mergeable: 'UNKNOWN',
      checks: [],
    });
  });

  it('ignores unknown review metadata from GitHub', async () => {
    stubGh((_args, cb) =>
      cb(
        null,
        JSON.stringify({
          state: 'OPEN',
          headRefOid: 'abc123',
          isDraft: 'yes',
          reviewDecision: 'NEW_REVIEW_STATE',
          statusCheckRollup: [],
        }),
        '',
      ),
    );

    await expect(fetchPrStatus('https://github.com/a/b/pull/1')).resolves.toMatchObject({
      isDraft: false,
      reviewDecision: null,
    });
  });
});

describe('listOpenPrUrlsForBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
  });

  it('skips gh without remotes and discovers PRs after a remote is added', async () => {
    let remote = '';
    const commands: string[] = [];
    const impl = (cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
      commands.push(cmd);
      if (cmd === 'git') {
        cb(null, remote, '');
      } else if (!remote) {
        cb(new Error('no git remotes found'), '', 'no git remotes found');
      } else {
        cb(
          null,
          JSON.stringify([
            { url: 'https://github.com/a/b/pull/11', headRefName: 'task/my-branch' },
          ]),
          '',
        );
      }
    };
    vi.mocked(execFile).mockImplementation(impl as unknown as typeof execFile);

    await expect(listOpenPrUrlsForBranch('/repo/worktree', 'task/my-branch')).resolves.toEqual([]);
    expect(commands).toEqual(['git']);

    remote = 'origin\n';
    await expect(listOpenPrUrlsForBranch('/repo/worktree', 'task/my-branch')).resolves.toEqual([
      'https://github.com/a/b/pull/11',
    ]);
    expect(commands).toEqual(['git', 'git', 'gh']);
  });

  it.each(['github.com', 'code.acme.test'])('finds an open PR for a branch on %s', async (host) => {
    const calls = stubGh((_args, cb) => {
      cb(
        null,
        JSON.stringify([
          {
            url: `https://${host}/a/b/pull/11`,
            headRefName: 'task/my-branch',
          },
        ]),
        '',
      );
    });
    await expect(listOpenPrUrlsForBranch('/repo/worktree', 'task/my-branch')).resolves.toEqual([
      `https://${host}/a/b/pull/11`,
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'pr',
      'list',
      '--state',
      'open',
      '--head',
      'task/my-branch',
      '--json',
      'url,headRefName,isCrossRepository,headRepositoryOwner',
      '--limit',
      '20',
    ]);
  });

  it('does not require the local branch head to match the PR head', async () => {
    stubGh((_args, cb) =>
      cb(
        null,
        JSON.stringify([
          {
            url: 'https://github.com/a/b/pull/12',
            headRefName: 'task/ahead-locally',
            headRefOid: 'remote-sha',
          },
        ]),
        '',
      ),
    );
    await expect(listOpenPrUrlsForBranch('/repo/worktree', 'task/ahead-locally')).resolves.toEqual([
      'https://github.com/a/b/pull/12',
    ]);
  });

  it('returns nothing when the branch has no open PR', async () => {
    stubGh((_args, cb) => cb(null, JSON.stringify([]), ''));
    await expect(listOpenPrUrlsForBranch('/repo/worktree', 'task/no-pr')).resolves.toEqual([]);
  });

  it('returns nothing without invoking gh when the worktree path is gone', async () => {
    const err = new Error('missing worktree') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    mockStat.mockRejectedValueOnce(err);
    const calls = stubGh((_args, cb) => cb(null, JSON.stringify([]), ''));

    await expect(listOpenPrUrlsForBranch('/repo/missing-worktree', 'task/no-pr')).resolves.toEqual(
      [],
    );

    expect(calls).toHaveLength(0);
  });

  it('lists every open PR of the branch', async () => {
    stubGh((_args, cb) =>
      cb(
        null,
        JSON.stringify([
          { url: 'https://github.com/a/b/pull/11', headRefName: 'task/two-bases' },
          { url: 'https://github.com/a/b/pull/12', headRefName: 'task/two-bases' },
          { url: 'https://github.com/a/b/pull/13', headRefName: 'task/other' },
        ]),
        '',
      ),
    );
    await expect(listOpenPrUrlsForBranch('/repo/worktree', 'task/two-bases')).resolves.toEqual([
      'https://github.com/a/b/pull/11',
      'https://github.com/a/b/pull/12',
    ]);
  });

  it('rejects malformed PR URLs from gh output', async () => {
    stubGh((_args, cb) =>
      cb(
        null,
        JSON.stringify([
          {
            url: 'https://github.com/a/b/issues/12',
            headRefName: 'task/issue',
          },
        ]),
        '',
      ),
    );
    await expect(listOpenPrUrlsForBranch('/repo/worktree', 'task/issue')).resolves.toEqual([]);
  });

  it('ignores fork PRs from owners none of the local remotes belong to', async () => {
    const impl = (cmd: string, _args: string[], _opts: unknown, cb: ExecCb) => {
      if (cmd === 'git') {
        cb(
          null,
          [
            'origin\tgit@github.com:Acme/api.git (fetch)',
            'origin\tgit@github.com:Acme/api.git (push)',
            'mine\thttps://github.com/me/api/ (fetch)',
          ].join('\n'),
          '',
        );
        return;
      }
      const fork = (login: string) => ({ isCrossRepository: true, headRepositoryOwner: { login } });
      cb(
        null,
        JSON.stringify([
          { url: 'https://github.com/acme/api/pull/1', headRefName: 'develop' },
          { url: 'https://github.com/acme/api/pull/2', headRefName: 'develop', ...fork('ME') },
          {
            url: 'https://github.com/acme/api/pull/3',
            headRefName: 'develop',
            ...fork('stranger'),
          },
        ]),
        '',
      );
    };
    vi.mocked(execFile).mockImplementation(impl as unknown as typeof execFile);

    await expect(listOpenPrUrlsForBranch('/repo/worktree', 'develop')).resolves.toEqual([
      'https://github.com/acme/api/pull/1',
      'https://github.com/acme/api/pull/2',
    ]);
  });
});

describe('refreshPrChecksWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
  });

  it.each([
    { statusCheckRollup: [] },
    { statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
  ])(
    'reports conflicts instead of green or absent CI for rollup %j',
    async ({ statusCheckRollup }) => {
      const send = vi.fn();
      initPrChecks(fakeWindow(send));
      let mergeable = 'CONFLICTING';
      stubGh((_args, cb) =>
        cb(
          null,
          JSON.stringify({ state: 'OPEN', headRefOid: 'sha', mergeable, statusCheckRollup }),
          '',
        ),
      );
      startPrChecksWatcher({
        taskId: 't1',
        watchId: 't1',
        prUrl: 'https://github.com/a/b/pull/1',
        taskName: 'test',
        babysit: false,
        branch: null,
      });
      await flushPromises();
      expect(send.mock.calls[send.mock.calls.length - 1]?.[1]).toMatchObject({
        overall: 'failure',
        failing: 1,
        checks: expect.arrayContaining([
          { name: 'Merge conflicts with base branch', bucket: 'fail' },
        ]),
      });

      mergeable = 'MERGEABLE';
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000);
      try {
        await __runTickForTests();
      } finally {
        now.mockRestore();
      }
      expect(send.mock.calls[send.mock.calls.length - 1]?.[1]).toMatchObject({
        taskId: 't1',
        overall: statusCheckRollup.length ? 'success' : 'none',
        failing: 0,
      });
    },
  );

  it('does not suppress the first fetched status after a post-push refresh', async () => {
    const send = vi.fn();
    initPrChecks(fakeWindow(send));
    stubGh((_args, cb) =>
      cb(
        null,
        JSON.stringify({
          state: 'OPEN',
          headRefOid: 'new-sha',
          statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        }),
        '',
      ),
    );

    startPrChecksWatcher({
      taskId: 't1',
      watchId: 't1',
      prUrl: 'https://github.com/a/b/pull/1',
      taskName: 'test',
      babysit: false,
      branch: null,
    });
    refreshPrChecksWatcher('t1');
    await flushPromises();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][1]).toMatchObject({ taskId: 't1', overall: 'pending' });
    expect(send.mock.calls[1][1]).toMatchObject({
      taskId: 't1',
      overall: 'success',
      passing: 1,
    });
  });

  it('keeps stale post-push status hidden until GitHub reports a new head', async () => {
    const send = vi.fn();
    initPrChecks(fakeWindow(send));
    const statuses = [
      {
        state: 'OPEN',
        headRefOid: 'old-sha',
        statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      },
      {
        state: 'OPEN',
        headRefOid: 'old-sha',
        statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      },
      {
        state: 'OPEN',
        headRefOid: 'new-sha',
        statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      },
    ];
    let nextStatus = 0;
    stubGh((_args, cb) => {
      const payload = statuses[Math.min(nextStatus, statuses.length - 1)];
      nextStatus += 1;
      cb(null, JSON.stringify(payload), '');
    });

    startPrChecksWatcher({
      taskId: 't1',
      watchId: 't1',
      prUrl: 'https://github.com/a/b/pull/1',
      taskName: 'test',
      babysit: false,
      branch: null,
    });
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(1);

    refreshPrChecksWatcher('t1');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toMatchObject({ taskId: 't1', overall: 'pending' });

    // The refresh polls at once; GitHub still reports the old head, which stays hidden.
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(2);

    await __runTickForTests();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][1]).toMatchObject({
      taskId: 't1',
      overall: 'success',
      passing: 1,
    });
  });

  it('publishes review metadata while stale post-push CI remains hidden', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const send = vi.fn();
      initPrChecks(fakeWindow(send));
      const statuses = [
        {
          state: 'OPEN',
          headRefOid: 'old-sha',
          isDraft: false,
          reviewDecision: 'REVIEW_REQUIRED',
          statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        },
        {
          state: 'OPEN',
          headRefOid: 'old-sha',
          isDraft: true,
          reviewDecision: 'CHANGES_REQUESTED',
          statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }],
        },
      ];
      let nextStatus = 0;
      stubGh((_args, cb) => {
        const payload = statuses[Math.min(nextStatus, statuses.length - 1)];
        nextStatus += 1;
        cb(null, JSON.stringify(payload), '');
      });

      startPrChecksWatcher({
        taskId: 't1',
        watchId: 't1',
        prUrl: 'https://github.com/a/b/pull/1',
        taskName: 'test',
        babysit: false,
        branch: null,
      });
      await flushPromises();
      refreshPrChecksWatcher('t1');

      now.mockReturnValue(30_000);
      await __runTickForTests();

      expect(send).toHaveBeenCalledTimes(3);
      expect(send.mock.calls[2][1]).toMatchObject({
        overall: 'pending',
        isDraft: true,
        reviewDecision: 'CHANGES_REQUESTED',
        passing: 0,
        pending: 1,
        failing: 0,
      });
    } finally {
      now.mockRestore();
    }
  });

  it('publishes a review-decision change when CI and the head SHA are unchanged', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const send = vi.fn();
      initPrChecks(fakeWindow(send));
      let reviewDecision = 'REVIEW_REQUIRED';
      stubGh((_args, cb) =>
        cb(
          null,
          JSON.stringify({
            state: 'OPEN',
            headRefOid: 'same-sha',
            isDraft: false,
            reviewDecision,
            statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          }),
          '',
        ),
      );

      startPrChecksWatcher({
        taskId: 't1',
        watchId: 't1',
        prUrl: 'https://github.com/a/b/pull/1',
        taskName: 'test',
        babysit: false,
        branch: null,
      });
      await flushPromises();
      expect(send).toHaveBeenCalledTimes(1);

      reviewDecision = 'APPROVED';
      now.mockReturnValue(6 * 60_000);
      await __runTickForTests();

      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1][1]).toMatchObject({ reviewDecision: 'APPROVED' });
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    ['MERGED', true],
    ['CLOSED', false],
  ])('stops watching a %s PR and reports merged=%s', async (state, merged) => {
    const send = vi.fn();
    initPrChecks(fakeWindow(send));
    stubGh((_args, cb) =>
      cb(
        null,
        JSON.stringify({
          state,
          mergedAt: merged ? '2026-10-09T10:00:00Z' : null,
          headRefOid: 'sha',
          statusCheckRollup: [],
        }),
        '',
      ),
    );

    startPrChecksWatcher({
      taskId: 't1',
      watchId: 't1',
      prUrl: 'https://github.com/a/b/pull/1',
      taskName: 'test',
      babysit: false,
      branch: null,
    });
    await flushPromises();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toMatchObject({
      taskId: 't1',
      cleared: true,
      merged,
      prUrl: 'https://github.com/a/b/pull/1',
      mergedAt: merged ? '2026-10-09T10:00:00Z' : undefined,
    });
    expect(__getStateForTests().taskIds).toEqual([]);
  });

  it('polls GitHub right away instead of waiting for the next tick', async () => {
    const send = vi.fn();
    initPrChecks(fakeWindow(send));
    let state = 'OPEN';
    const calls = stubGh((_args, cb) =>
      cb(null, JSON.stringify({ state, headRefOid: 'sha', statusCheckRollup: [] }), ''),
    );
    startPrChecksWatcher({
      taskId: 't1',
      watchId: 't1',
      prUrl: 'https://github.com/a/b/pull/1',
      taskName: 'test',
      babysit: false,
      branch: null,
    });
    await flushPromises();
    state = 'MERGED';

    refreshPrChecksWatcher('t1');
    await flushPromises();

    expect(calls).toHaveLength(2);
    expect(send.mock.calls[send.mock.calls.length - 1]?.[1]).toMatchObject({ merged: true });
  });
});

describe('startPrChecksWatcher — pushes made outside the app', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
  });

  const success = [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  const pending = [{ name: 'build', status: 'IN_PROGRESS', conclusion: '' }];

  async function watchSettledPr(send: ReturnType<typeof vi.fn>) {
    initPrChecks(fakeWindow(send));
    const github = { head: 'old-sha', rollup: success };
    const local: { origin: string; error: (Error & { code?: unknown }) | null } = {
      origin: 'old-sha',
      error: null,
    };
    const calls = stubGh((args, cb, cmd) => {
      if (cmd === 'git') {
        cb(local.error, local.error ? '' : `${local.origin}\n`, '');
        return;
      }
      cb(
        null,
        JSON.stringify({
          state: 'OPEN',
          headRefOid: github.head,
          statusCheckRollup: github.rollup,
        }),
        '',
      );
    });
    startPrChecksWatcher({
      taskId: 't1',
      watchId: 't1',
      prUrl: 'https://github.com/a/b/pull/1',
      taskName: 'test',
      babysit: false,
      branch: { worktreePath: '/wt', branchName: 'feature' },
    });
    await flushPromises();
    await __runTickForTests();
    return { github, local, ghCalls: () => calls.filter((a) => a[0] !== 'rev-parse') };
  }

  it('re-polls a settled PR on the next tick after its branch is pushed', async () => {
    const send = vi.fn();
    const { github, local, ghCalls } = await watchSettledPr(send);
    expect(ghCalls()).toHaveLength(1);

    local.origin = 'new-sha';
    github.head = 'new-sha';
    github.rollup = pending;
    await __runTickForTests();

    expect(ghCalls()).toHaveLength(2);
    expect(send.mock.calls[send.mock.calls.length - 1]?.[1]).toMatchObject({
      overall: 'pending',
      headSha: 'new-sha',
    });
  });

  it('leaves a settled PR alone while its branch has not moved', async () => {
    const send = vi.fn();
    const { ghCalls } = await watchSettledPr(send);

    await __runTickForTests();

    expect(ghCalls()).toHaveLength(1);
  });

  it('does not mark a push the app already reported a second time', async () => {
    const send = vi.fn();
    const { local } = await watchSettledPr(send);
    // The app pushed and refreshed; GitHub still reports the old head.
    refreshPrChecksWatcher('t1');
    await flushPromises();
    local.origin = 'new-sha';
    send.mockClear();

    await __runTickForTests();

    expect(send).not.toHaveBeenCalled();
  });

  it('logs a failed ref read, but not a branch that was never pushed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const send = vi.fn();
      const { local } = await watchSettledPr(send);

      local.error = Object.assign(new Error('exit 1'), { code: 1 });
      await __runTickForTests();
      expect(warn).not.toHaveBeenCalled();

      local.error = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
      await __runTickForTests();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[pr-checks]'), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps polling a pushed head until GitHub has created its checks', async () => {
    const send = vi.fn();
    const { github, ghCalls } = await watchSettledPr(send);
    github.head = 'new-sha';
    github.rollup = [];
    refreshPrChecksWatcher('t1');
    await flushPromises();
    expect(ghCalls()).toHaveLength(2);

    github.rollup = pending;
    await __runTickForTests();

    expect(ghCalls()).toHaveLength(3);
    expect(send.mock.calls[send.mock.calls.length - 1]?.[1]).toMatchObject({
      overall: 'pending',
      headSha: 'new-sha',
    });
  });

  it('shows a pushed head without checks as running, not as having no CI', async () => {
    const send = vi.fn();
    const { github } = await watchSettledPr(send);
    github.head = 'new-sha';
    github.rollup = [];
    send.mockClear();

    refreshPrChecksWatcher('t1');
    await flushPromises();
    await __runTickForTests();
    expect(send.mock.calls.map(([, p]) => (p as { overall: string }).overall)).not.toContain(
      'none',
    );

    // A head that still has no checks after the wait really has no CI.
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60_000);
    try {
      await __runTickForTests();
    } finally {
      now.mockRestore();
    }
    expect(send.mock.calls[send.mock.calls.length - 1]?.[1]).toMatchObject({ overall: 'none' });
  });

  it('starts a new baseline when the PR’s branch changes', async () => {
    const send = vi.fn();
    const { local } = await watchSettledPr(send);
    startPrChecksWatcher({
      taskId: 't1',
      watchId: 't1',
      prUrl: 'https://github.com/a/b/pull/1',
      taskName: 'test',
      babysit: false,
      branch: { worktreePath: '/wt', branchName: 'other' },
    });
    local.origin = 'other-sha';
    send.mockClear();

    await __runTickForTests();

    expect(send).not.toHaveBeenCalled();
  });
});

describe('refreshPrChecksWatcher — replies arriving out of order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
  });

  it('polls at once after a push even while a tick’s poll is running', async () => {
    initPrChecks(fakeWindow(vi.fn()));
    const held: ExecCb[] = [];
    stubGh((_args, cb) => held.push(cb));
    startPrChecksWatcher({
      taskId: 't1',
      watchId: 't1',
      prUrl: 'https://github.com/a/b/pull/1',
      taskName: 'test',
      babysit: false,
      branch: null,
    });
    held.shift()?.(
      null,
      JSON.stringify({
        state: 'OPEN',
        headRefOid: 'old-sha',
        statusCheckRollup: [{ name: 'build', status: 'IN_PROGRESS', conclusion: '' }],
      }),
      '',
    );
    await flushPromises();
    void __runTickForTests();
    await flushPromises();
    expect(held).toHaveLength(1);

    refreshPrChecksWatcher('t1');
    await flushPromises();

    expect(held).toHaveLength(2);
  });

  it('never lets an older reply replace a newer head', async () => {
    const send = vi.fn();
    initPrChecks(fakeWindow(send));
    const held: ExecCb[] = [];
    stubGh((_args, cb) => held.push(cb));
    const reply = (cb: ExecCb | undefined, headRefOid: string, rollup: unknown[]) =>
      cb?.(null, JSON.stringify({ state: 'OPEN', headRefOid, statusCheckRollup: rollup }), '');
    const success = [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    const running = [{ name: 'build', status: 'IN_PROGRESS', conclusion: '' }];
    startPrChecksWatcher({
      taskId: 't1',
      watchId: 't1',
      prUrl: 'https://github.com/a/b/pull/1',
      taskName: 'test',
      babysit: false,
      branch: null,
    });
    reply(held.shift(), 'old-sha', success);
    await flushPromises();

    refreshPrChecksWatcher('t1');
    const tick = __runTickForTests();
    await flushPromises();
    // Newest first: the last poll sees the pushed head, earlier ones the old head.
    const inFlight = held.splice(0);

    reply(inFlight.pop(), 'new-sha', running);
    await flushPromises();
    for (const cb of inFlight.reverse()) reply(cb, 'old-sha', success);
    await tick;
    await flushPromises();

    expect(send.mock.calls[send.mock.calls.length - 1]?.[1]).toMatchObject({
      headSha: 'new-sha',
      overall: 'pending',
    });
  });
});

describe('startPrChecksWatcher — several PRs per task', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
  });

  it("watches a task's additional PR beside its primary one", async () => {
    const send = vi.fn();
    initPrChecks(fakeWindow(send));
    stubGh((args, cb) =>
      cb(
        null,
        JSON.stringify({
          state: 'OPEN',
          headRefOid: `sha-${args[2]}`,
          statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        }),
        '',
      ),
    );
    startPrChecksWatcher({
      taskId: 't1',
      watchId: 't1',
      prUrl: 'https://github.com/a/b/pull/1',
      taskName: 'T',
      babysit: false,
      branch: null,
    });
    startPrChecksWatcher({
      taskId: 't1',
      prUrl: 'https://github.com/a/api/pull/2',
      taskName: 'T · api #2',
      watchId: 't1:api',
      babysit: false,
      branch: null,
    });
    await flushPromises();

    expect(__getStateForTests().taskIds.sort()).toEqual(['t1', 't1:api']);
    const payloads = send.mock.calls.map(([, payload]) => payload as Record<string, unknown>);
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: 't1',
          watchId: 't1',
          prUrl: 'https://github.com/a/b/pull/1',
        }),
        expect.objectContaining({
          taskId: 't1',
          watchId: 't1:api',
          prUrl: 'https://github.com/a/api/pull/2',
        }),
      ]),
    );

    stopPrChecksWatcher('t1:api');
    expect(__getStateForTests().taskIds).toEqual(['t1']);
  });

  it('marks the PRs that share the pushed head as freshly pushed', async () => {
    const send = vi.fn();
    initPrChecks(fakeWindow(send));
    stubGh((args, cb) =>
      cb(
        null,
        JSON.stringify({
          state: 'OPEN',
          headRefOid: args[2]?.includes('/api/') ? 'sha-api' : 'sha-task',
          statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        }),
        '',
      ),
    );
    const watch = (watchId: string, prUrl: string) =>
      startPrChecksWatcher({
        taskId: 't1',
        watchId,
        prUrl,
        taskName: 'T',
        babysit: false,
        branch: null,
      });
    watch('t1', 'https://github.com/a/b/pull/1');
    watch('t1:b', 'https://github.com/a/b/pull/3');
    watch('t1:api', 'https://github.com/a/api/pull/2');
    await flushPromises();
    send.mockClear();

    refreshPrChecksWatcher('t1');

    const refreshed = send.mock.calls.map(([, payload]) => payload as Record<string, unknown>);
    expect(refreshed.map((p) => [p.watchId, p.overall])).toEqual([
      ['t1', 'pending'],
      ['t1:b', 'pending'],
    ]);
  });
});

describe('startPrChecksWatcher — hidden window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    __resetForTests();
    vi.useRealTimers();
  });

  it('keeps polling only babysat PRs while the window is hidden', async () => {
    initPrChecks(fakeWindow(vi.fn()));
    const calls = stubGh((_args, cb) =>
      cb(
        null,
        JSON.stringify({
          state: 'OPEN',
          headRefOid: 'sha',
          statusCheckRollup: [{ name: 'build', status: 'IN_PROGRESS' }],
        }),
        '',
      ),
    );
    const watch = (watchId: string, babysit: boolean) =>
      startPrChecksWatcher({
        taskId: watchId,
        watchId,
        prUrl: `https://github.com/a/b/pull/${watchId === 'babysat' ? 1 : 2}`,
        taskName: 'T',
        babysit,
        branch: null,
      });
    watch('plain', false);
    watch('babysat', true);
    await flushPromises();
    calls.length = 0;

    vi.advanceTimersByTime(30_000);
    await flushPromises();

    expect(calls.map((args) => args[2])).toEqual(['https://github.com/a/b/pull/1']);
  });

  it('notices a push to a babysat PR’s branch while the window is hidden', async () => {
    initPrChecks(fakeWindow(vi.fn()));
    let origin = 'old-sha';
    let head = 'old-sha';
    const calls = stubGh((_args, cb, cmd) => {
      if (cmd === 'git') {
        cb(null, `${origin}\n`, '');
        return;
      }
      cb(
        null,
        JSON.stringify({
          state: 'OPEN',
          headRefOid: head,
          statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        }),
        '',
      );
    });
    startPrChecksWatcher({
      taskId: 't1',
      watchId: 't1',
      prUrl: 'https://github.com/a/b/pull/1',
      taskName: 'T',
      babysit: true,
      branch: { worktreePath: '/wt', branchName: 'feature' },
    });
    await flushPromises();
    vi.advanceTimersByTime(30_000);
    await flushPromises();
    const ghCalls = () => calls.filter((args) => args[0] !== 'rev-parse');
    expect(ghCalls()).toHaveLength(1);

    origin = 'new-sha';
    head = 'new-sha';
    vi.advanceTimersByTime(30_000);
    await flushPromises();

    expect(ghCalls()).toHaveLength(2);
  });
});

describe('startPrChecksWatcher — graceful degradation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
  });

  it('ignores non-PR URLs (no task registered)', () => {
    startPrChecksWatcher({
      taskId: 't1',
      watchId: 't1',
      prUrl: 'https://github.com/a/b/issues/1',
      taskName: 'test',
      babysit: false,
      branch: null,
    });
    expect(__getStateForTests().taskIds).toEqual([]);
  });

  it('disables session when gh is missing (ENOENT)', async () => {
    stubGh((_args, cb) => {
      const e = new Error('ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      cb(e, '', '');
    });
    startPrChecksWatcher({
      taskId: 't1',
      watchId: 't1',
      prUrl: 'https://github.com/a/b/pull/1',
      taskName: 'test',
      babysit: false,
      branch: null,
    });
    // Allow the fire-and-forget refresh to settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(__getStateForTests().disabled).toBe(true);
    expect(__getStateForTests().disabledReason).toBe('missing');
  });

  it.each([
    'You are not logged into any GitHub hosts.',
    // gh 2.101 with no account at all.
    'To get started with GitHub CLI, please run:  gh auth login',
  ])('disables session when gh reports not authenticated: %s', async (stderr) => {
    stubGh((_args, cb) => {
      const e = new Error('auth') as Error & { stderr?: string };
      e.stderr = stderr;
      cb(e, '', stderr);
    });
    startPrChecksWatcher({
      taskId: 't1',
      watchId: 't1',
      prUrl: 'https://github.com/a/b/pull/1',
      taskName: 'test',
      babysit: false,
      branch: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(__getStateForTests().disabled).toBe(true);
    expect(__getStateForTests().disabledReason).toBe('auth');
  });
});
