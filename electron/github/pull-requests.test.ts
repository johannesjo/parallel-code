import { describe, expect, it, vi, beforeEach } from 'vitest';
import { promisify } from 'util';

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

import { execFile } from 'child_process';
import {
  actionsJobId,
  getFailedChecks,
  getPullRequestDetails,
  getReviewFeedback,
  markPullRequestReady,
  mergePullRequest,
  parseFailedChecks,
  parseMergeMethods,
  parseReviewFeedback,
} from './pull-requests.js';

type Callback = (err: Error | null, stdout: string, stderr: string) => void;
const mockExec = execFile as unknown as ReturnType<typeof vi.fn>;

function stubGh(handler: (args: string[]) => string): string[][] {
  const calls: string[][] = [];
  mockExec.mockImplementation((_file: string, args: string[], _opts: unknown, cb: Callback) => {
    calls.push(args);
    try {
      cb(null, handler(args), '');
    } catch (err) {
      cb(err as Error, '', 'boom');
    }
  });
  return calls;
}

beforeEach(() => {
  mockExec.mockReset();
});

describe('markPullRequestReady', () => {
  it('takes the PR out of draft', async () => {
    const calls = stubGh(() => '');
    await markPullRequestReady('https://github.com/o/r/pull/7');
    expect(calls).toEqual([['pr', 'ready', 'https://github.com/o/r/pull/7']]);
  });

  it('rejects non-PR URLs before calling gh', async () => {
    const calls = stubGh(() => '');
    await expect(markPullRequestReady('https://github.com/o/r/issues/7')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('mergePullRequest', () => {
  it('merges with the chosen method and never deletes the branch', async () => {
    const calls = stubGh(() => '');
    await mergePullRequest('https://github.com/o/r/pull/7', {
      method: 'squash',
      headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(calls[0]).toEqual([
      'pr',
      'merge',
      'https://github.com/o/r/pull/7',
      '--squash',
      '--match-head-commit',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ]);
  });

  it('bypasses branch protection only when asked', async () => {
    const calls = stubGh(() => '');
    const url = 'https://github.com/o/r/pull/7';
    await mergePullRequest(url, { method: 'merge', headSha: 'a'.repeat(40), admin: true });
    expect(calls[0]).toContain('--admin');
    await mergePullRequest(url, { method: 'merge', headSha: 'a'.repeat(40) });
    // calls: merge, view, merge, view
    expect(calls[2]).not.toContain('--admin');
  });

  it('reports merged only when GitHub says the PR is merged', async () => {
    const sha = 'a'.repeat(40);
    const url = 'https://github.com/o/r/pull/7';
    stubGh((args) => (args[1] === 'view' ? '{"state":"MERGED"}' : ''));
    await expect(mergePullRequest(url, { method: 'merge', headSha: sha })).resolves.toBe(true);
    // Merge queues accept the request but leave the PR open.
    stubGh((args) => (args[1] === 'view' ? '{"state":"OPEN"}' : ''));
    await expect(mergePullRequest(url, { method: 'merge', headSha: sha })).resolves.toBe(false);
  });

  it('does not fail the merge when only the follow-up state check fails', async () => {
    stubGh((args) => {
      if (args[1] === 'view') throw new Error('network');
      return '';
    });
    await expect(
      mergePullRequest('https://github.com/o/r/pull/7', {
        method: 'merge',
        headSha: 'a'.repeat(40),
      }),
    ).resolves.toBe(false);
  });

  it('rejects non-PR URLs before calling gh', async () => {
    const calls = stubGh(() => '');
    await expect(
      mergePullRequest('https://github.com/o/r/issues/7', {
        method: 'merge',
        headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('parseMergeMethods', () => {
  it('lists allowed methods with the viewer default first', () => {
    expect(
      parseMergeMethods({
        squashMergeAllowed: true,
        mergeCommitAllowed: true,
        rebaseMergeAllowed: false,
        viewerDefaultMergeMethod: 'MERGE',
      }),
    ).toEqual(['merge', 'squash']);
    expect(parseMergeMethods(null)).toEqual([]);
  });
});

describe('parseFailedChecks', () => {
  it('keeps failed check runs and legacy statuses', () => {
    expect(
      parseFailedChecks([
        { name: 'ok', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'skip', status: 'COMPLETED', conclusion: 'SKIPPED' },
        { name: 'running', status: 'IN_PROGRESS', conclusion: '' },
        { name: 'test', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/x' },
        { context: 'legacy', state: 'ERROR', targetUrl: 'https://ci.example/1' },
      ]),
    ).toEqual([
      { name: 'test', url: 'https://github.com/o/r/x', logTail: null },
      { name: 'legacy', url: 'https://ci.example/1', logTail: null },
    ]);
  });
});

describe('actionsJobId', () => {
  const ref = { host: 'github.com', owner: 'O', repo: 'r' };
  it('extracts job ids from same-repo Actions URLs only', () => {
    expect(actionsJobId('https://github.com/o/r/actions/runs/1/job/42', ref)).toBe('42');
    expect(actionsJobId('https://github.com/other/r/actions/runs/1/job/42', ref)).toBeNull();
    expect(actionsJobId('https://dashboard.gitguardian.com', ref)).toBeNull();
  });
});

describe('getFailedChecks', () => {
  it('attaches log tails for failed Actions jobs and survives log errors', async () => {
    const calls = stubGh((args) => {
      if (args[0] === 'pr') {
        return JSON.stringify({
          statusCheckRollup: [
            {
              name: 'unit',
              conclusion: 'FAILURE',
              detailsUrl: 'https://github.com/o/r/actions/runs/1/job/11',
            },
            {
              name: 'lint',
              conclusion: 'FAILURE',
              detailsUrl: 'https://github.com/o/r/actions/runs/1/job/12',
            },
          ],
        });
      }
      if (args[1].endsWith('/jobs/11/logs')) return '2026-01-01T00:00:00Z FAIL a.test.ts\n';
      throw new Error('gone');
    });
    const checks = await getFailedChecks('https://github.com/o/r/pull/7');
    expect(checks.map((c) => c.logTail)).toEqual(['FAIL a.test.ts', null]);
    expect(calls).toHaveLength(3);
  });
});

describe('parseReviewFeedback', () => {
  it('keeps unresolved threads and non-empty review bodies', () => {
    const raw = {
      data: {
        repository: {
          pullRequest: {
            reviews: {
              nodes: [
                { state: 'CHANGES_REQUESTED', body: 'Add tests.', author: { login: 'a' } },
                { state: 'APPROVED', body: 'LGTM', author: { login: 'a' } },
                { state: 'DISMISSED', body: 'Old concern', author: { login: 'c' } },
                { state: 'COMMENTED', body: '  ', author: { login: 'c' } },
                { state: 'CHANGES_REQUESTED', body: 'Please split this.', author: { login: 'b' } },
              ],
            },
            reviewThreads: {
              pageInfo: { hasNextPage: true },
              nodes: [
                {
                  isResolved: true,
                  isOutdated: false,
                  path: 'a.ts',
                  line: 1,
                  comments: { nodes: [{ body: 'done', author: { login: 'b' } }] },
                },
                {
                  isResolved: false,
                  isOutdated: true,
                  path: 'b.ts',
                  line: null,
                  comments: { nodes: [{ body: 'Rename this', author: null }] },
                },
              ],
            },
          },
        },
      },
    };
    expect(parseReviewFeedback(raw)).toEqual({
      reviews: [{ author: 'b', state: 'CHANGES_REQUESTED', body: 'Please split this.' }],
      threads: [
        {
          path: 'b.ts',
          line: null,
          isOutdated: true,
          comments: [{ author: 'unknown', body: 'Rename this' }],
        },
      ],
      truncated: true,
    });
  });

  it('tolerates malformed responses', () => {
    expect(parseReviewFeedback({ errors: [] })).toEqual({
      reviews: [],
      threads: [],
      truncated: false,
    });
  });
});

describe('enterprise PR actions', () => {
  const url = 'https://code.acme.test/o/r/pull/7';
  it('routes repository metadata and review feedback to the PR host', async () => {
    const calls = stubGh(() => '{}');
    await getPullRequestDetails(url);
    await getReviewFeedback(url);
    expect(calls).toContainEqual(expect.arrayContaining(['repo', 'view', 'code.acme.test/o/r']));
    expect(calls).toContainEqual(
      expect.arrayContaining(['api', 'graphql', '--hostname', 'code.acme.test']),
    );
  });

  it('fetches enterprise job logs and excludes jobs on another host', async () => {
    const calls = stubGh((args) =>
      args[0] === 'pr'
        ? JSON.stringify({
            statusCheckRollup: ['code.acme.test', 'github.com'].map((host) => ({
              name: host,
              conclusion: 'FAILURE',
              detailsUrl: `https://${host}/o/r/actions/runs/1/job/11`,
            })),
          })
        : 'failure',
    );
    const checks = await getFailedChecks(url);
    expect(checks.map((check) => check.logTail)).toEqual(['failure', null]);
    expect(calls[1]).toEqual([
      'api',
      'repos/o/r/actions/jobs/11/logs',
      '--hostname',
      'code.acme.test',
    ]);
  });
});
