import { renderToString } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import type { MergeStatus, VerificationRun, WorktreeStatus } from '../ipc/types';
import type { SubtaskVerification } from '../store/types';
import { MergeReadinessPanel } from './MergeReadinessPanel';
import { buildMergeReadiness, type MergeReadinessInput } from './merge-readiness';

const cleanMergeStatus: MergeStatus = {
  main_ahead_count: 0,
  conflicting_files: [],
  base_branch: 'main',
};

const cleanWorktreeStatus: WorktreeStatus = {
  has_committed_changes: true,
  has_uncommitted_changes: false,
  current_branch: 'task/readiness',
  base_branch: 'main',
};

const passedVerification: SubtaskVerification = {
  checks: [
    { name: 'typecheck', command: 'npm run typecheck', result: 'passed' },
    { name: 'test', command: 'npm test', result: 'passed' },
  ],
};

function input(overrides: Partial<MergeReadinessInput> = {}): MergeReadinessInput {
  return {
    expectedBranch: 'task/readiness',
    mergeStatus: cleanMergeStatus,
    mergeStatusLoading: false,
    worktreeStatus: cleanWorktreeStatus,
    worktreeStatusLoading: false,
    verification: passedVerification,
    ...overrides,
  };
}

describe('buildMergeReadiness', () => {
  it('reports ready when merge safety and reported verification pass', () => {
    const readiness = buildMergeReadiness(input());

    expect(readiness.overall).toBe('ready');
    expect(readiness.checks).toEqual([
      expect.objectContaining({ label: 'Merge safety', status: 'pass' }),
      expect.objectContaining({ label: 'Verification', status: 'pass' }),
      expect.objectContaining({ label: 'Coverage', status: 'neutral' }),
      expect.objectContaining({ label: 'PR checks', status: 'neutral' }),
    ]);
  });

  it('reports checking while merge data is loading', () => {
    const readiness = buildMergeReadiness(
      input({ mergeStatus: undefined, mergeStatusLoading: true }),
    );

    expect(readiness.overall).toBe('checking');
    expect(readiness.checks[0]).toEqual(
      expect.objectContaining({ status: 'checking', detail: 'Checking merge safety…' }),
    );
  });

  it.each([
    {
      name: 'conflicting files',
      overrides: {
        mergeStatus: { ...cleanMergeStatus, conflicting_files: ['src/App.tsx'] },
      },
      detail: '1 conflicting file must be resolved.',
    },
    {
      name: 'a mismatched branch',
      overrides: {
        worktreeStatus: { ...cleanWorktreeStatus, current_branch: 'task/other' },
      },
      detail: "Worktree is on 'task/other', expected 'task/readiness'.",
    },
    {
      name: 'no committed changes',
      overrides: {
        worktreeStatus: { ...cleanWorktreeStatus, has_committed_changes: false },
      },
      detail: 'No committed changes are available to merge.',
    },
  ])('reports not ready for $name', ({ overrides, detail }) => {
    const readiness = buildMergeReadiness(input(overrides));

    expect(readiness.overall).toBe('blocked');
    expect(readiness.checks[0]).toEqual(expect.objectContaining({ status: 'blocked', detail }));
  });

  it.each([
    {
      name: 'a detached HEAD when merge status is unavailable',
      overrides: {
        mergeStatus: undefined,
        worktreeStatus: { ...cleanWorktreeStatus, current_branch: null },
      },
      detail: 'Worktree has a detached HEAD.',
    },
    {
      name: 'conflicts when worktree status is unavailable',
      overrides: {
        mergeStatus: { ...cleanMergeStatus, conflicting_files: ['src/App.tsx'] },
        worktreeStatus: undefined,
      },
      detail: '1 conflicting file must be resolved.',
    },
  ])('preserves the known blocker for $name', ({ overrides, detail }) => {
    const readiness = buildMergeReadiness(input(overrides));

    expect(readiness.overall).toBe('blocked');
    expect(readiness.checks[0]).toEqual(expect.objectContaining({ status: 'blocked', detail }));
  });

  it('reports attention for uncommitted changes and missing verification', () => {
    const readiness = buildMergeReadiness(
      input({
        worktreeStatus: { ...cleanWorktreeStatus, has_uncommitted_changes: true },
        verification: undefined,
      }),
    );

    expect(readiness.overall).toBe('attention');
    expect(readiness.checks[0]).toEqual(
      expect.objectContaining({
        status: 'warning',
        detail: 'Uncommitted changes will be excluded.',
      }),
    );
    expect(readiness.checks[1]).toEqual(
      expect.objectContaining({ status: 'warning', detail: 'No verification was reported.' }),
    );
  });

  it('reports attention for failing verification and pending PR checks', () => {
    const readiness = buildMergeReadiness(
      input({
        verification: {
          checks: [
            {
              name: 'test',
              command: 'npm test',
              result: 'failed',
              reason: '2 tests failed',
            },
          ],
        },
        prChecks: { overall: 'pending', passing: 2, pending: 1, failing: 0 },
      }),
    );

    expect(readiness.overall).toBe('attention');
    expect(readiness.checks[1]).toEqual(
      expect.objectContaining({ status: 'warning', detail: 'test failed — 2 tests failed' }),
    );
    expect(readiness.checks[3]).toEqual(
      expect.objectContaining({ status: 'warning', detail: '1 pending, 2 passing.' }),
    );
  });

  it('includes failures while PR checks are still pending', () => {
    const readiness = buildMergeReadiness(
      input({
        prChecks: { overall: 'pending', passing: 2, pending: 1, failing: 1 },
      }),
    );

    expect(readiness.overall).toBe('attention');
    expect(readiness.checks[3]).toEqual(
      expect.objectContaining({
        status: 'warning',
        detail: '1 pending, 2 passing, 1 failing.',
      }),
    );
  });

  it('reports attention for aggregate coverage regression and impacted unchanged files', () => {
    const readiness = buildMergeReadiness(
      input({
        coverage: {
          aggregate: {
            task: { state: 'available', pct: 78 },
            base: { state: 'available', pct: 82 },
            delta: -4,
          },
          files: {},
          impactedUnchangedFiles: [
            {
              path: 'src/shared.ts',
              task: { state: 'available', pct: 70 },
              base: { state: 'available', pct: 80 },
              delta: -10,
            },
          ],
        },
      }),
    );

    expect(readiness.overall).toBe('attention');
    expect(readiness.checks[2]).toEqual(
      expect.objectContaining({
        label: 'Coverage',
        status: 'warning',
        detail: 'Base 82% → task 78% (-4pp). 1 unchanged file also regressed.',
      }),
    );
  });

  it('keeps an unchanged-file regression visible when aggregate coverage improves', () => {
    const readiness = buildMergeReadiness(
      input({
        coverage: {
          aggregate: {
            task: { state: 'available', pct: 84 },
            base: { state: 'available', pct: 82 },
            delta: 2,
          },
          files: {},
          impactedUnchangedFiles: [
            {
              path: 'src/shared.ts',
              task: { state: 'available', pct: 70 },
              base: { state: 'available', pct: 80 },
              delta: -10,
            },
          ],
        },
      }),
    );

    expect(readiness.checks[2]).toEqual(
      expect.objectContaining({
        status: 'warning',
        detail: 'Base 82% → task 84% (+2pp). 1 unchanged file also regressed.',
      }),
    );
  });

  it('does not attribute base-only covered files to the task', () => {
    const readiness = buildMergeReadiness(
      input({
        coverage: {
          aggregate: {
            task: { state: 'available', pct: 82 },
            base: { state: 'available', pct: 82 },
            delta: 0,
          },
          files: {},
          impactedUnchangedFiles: [
            {
              path: 'src/added-on-base.ts',
              task: { state: 'file-not-present', pct: null },
              base: { state: 'available', pct: 80 },
              delta: null,
            },
          ],
        },
      }),
    );

    expect(readiness.overall).toBe('ready');
    expect(readiness.checks[2]).toEqual(
      expect.objectContaining({
        status: 'pass',
        detail: 'Base 82% → task 82% (0pp).',
      }),
    );
  });

  it('does not warn for aggregate drift below the materiality threshold', () => {
    const readiness = buildMergeReadiness(
      input({
        coverage: {
          aggregate: {
            task: { state: 'available', pct: 81.99 },
            base: { state: 'available', pct: 82 },
            delta: -0.01,
          },
          files: {},
          impactedUnchangedFiles: [],
        },
      }),
    );

    expect(readiness.overall).toBe('ready');
    expect(readiness.checks[2]).toEqual(
      expect.objectContaining({
        status: 'pass',
        detail: 'Base 82% → task 81.99% (-0.01pp).',
      }),
    );
  });

  it('warns when aggregate coverage reaches the materiality threshold', () => {
    const readiness = buildMergeReadiness(
      input({
        coverage: {
          aggregate: {
            task: { state: 'available', pct: 81 },
            base: { state: 'available', pct: 82 },
            delta: -1,
          },
          files: {},
          impactedUnchangedFiles: [],
        },
      }),
    );

    expect(readiness.checks[2]).toEqual(expect.objectContaining({ status: 'warning' }));
  });

  it('keeps coverage informational until an ahead base branch is rebased', () => {
    const readiness = buildMergeReadiness(
      input({
        mergeStatus: { ...cleanMergeStatus, main_ahead_count: 2 },
        coverage: {
          aggregate: {
            task: { state: 'available', pct: 78 },
            base: { state: 'available', pct: 82 },
            delta: -4,
          },
          files: {},
          impactedUnchangedFiles: [],
        },
      }),
    );

    expect(readiness.checks[2]).toEqual(
      expect.objectContaining({
        status: 'neutral',
        detail: 'main is 2 commits ahead; rebase and regenerate task coverage before comparing.',
      }),
    );
  });

  it('keeps a stale task report neutral even when its delta is negative', () => {
    const readiness = buildMergeReadiness(
      input({
        coverage: {
          aggregate: {
            task: { state: 'available', pct: 78 },
            base: { state: 'available', pct: 82 },
            delta: -4,
          },
          files: {},
          impactedUnchangedFiles: [],
          baseline: {
            baseBranch: 'main',
            stale: false,
            taskHeadAt: '2026-07-26T00:00:00.000Z',
            taskStale: true,
          },
        },
      }),
    );

    expect(readiness.checks[2]).toEqual(
      expect.objectContaining({
        status: 'neutral',
        detail: 'Task coverage report predates task HEAD; regenerate it before comparing.',
      }),
    );
  });

  it.each([
    ['loading', 'still loading'],
    ['failed', 'unavailable'],
  ] as const)(
    'keeps task coverage visible but neutral when changed-file inventory is %s',
    (inventoryState, detailFragment) => {
      const readiness = buildMergeReadiness(
        input({
          coverage: {
            aggregate: {
              task: { state: 'available', pct: 78 },
              base: { state: 'available', pct: 82 },
              delta: -4,
            },
            files: {},
            impactedUnchangedFiles: [],
            inventoryState,
          },
        }),
      );

      expect(readiness.checks[2]).toEqual(expect.objectContaining({ status: 'neutral' }));
      expect(readiness.checks[2].detail).toContain('Task 78%');
      expect(readiness.checks[2].detail).toContain(detailFragment);
      expect(readiness.checks[2].detail).not.toContain('No task coverage report');
    },
  );

  it('keeps a stale base report neutral even when its delta is negative', () => {
    const readiness = buildMergeReadiness(
      input({
        coverage: {
          aggregate: {
            task: { state: 'available', pct: 78 },
            base: { state: 'available', pct: 82 },
            delta: -4,
          },
          files: {},
          impactedUnchangedFiles: [],
          baseline: {
            baseBranch: 'main',
            baseHeadAt: '2026-07-26T00:00:00.000Z',
            stale: true,
          },
        },
      }),
    );

    expect(readiness.overall).toBe('ready');
    expect(readiness.checks[2]).toEqual(
      expect.objectContaining({
        status: 'neutral',
        detail:
          'Base coverage report predates main as currently checked out; regenerate it before comparing.',
      }),
    );
  });

  it('keeps an unanchored base report neutral even when its delta is positive', () => {
    const readiness = buildMergeReadiness(
      input({
        coverage: {
          aggregate: {
            task: { state: 'available', pct: 84 },
            base: { state: 'available', pct: 82 },
            delta: 2,
          },
          files: {},
          impactedUnchangedFiles: [],
          baseline: {
            baseBranch: 'main',
            stale: false,
            unanchored: true,
          },
        },
      }),
    );

    expect(readiness.overall).toBe('ready');
    expect(readiness.checks[2]).toEqual(
      expect.objectContaining({
        status: 'neutral',
        detail:
          'Base coverage report cannot be anchored to main as currently checked out; comparison is informational only.',
      }),
    );
  });
});

describe('MergeReadinessPanel', () => {
  it('renders an accessible textual summary without relying on status color', () => {
    const readiness = buildMergeReadiness(input());
    const html = renderToString(() => MergeReadinessPanel({ readiness }));

    expect(html).toContain('aria-label="Ready to merge summary"');
    expect(html).toContain('Ready to merge');
    expect(html).toContain('Merge safety');
    expect(html).toContain('Verification');
    expect(html).toContain('2 checks passed.');
    expect(html).toContain('Coverage');
    expect(html).toContain('No task coverage report.');
    expect(html).toContain('PR checks');
    expect(html).toContain('No PR checks available.');
    expect(html).toContain(
      'title="Ready means every available check passed. Needs attention means a warning; Not ready means a merge-safety blocker; Checking means merge data is loading. This summary is advisory."',
    );
    expect(html).toContain(
      'title="Checks the task branch for conflicts with its base branch, branch mismatch, committed changes, and local uncommitted changes."',
    );
    expect(html).toContain('title="Runs the project\'s verify command in the task worktree');
    expect(html).toContain(
      'title="Uses checks reported for a detected GitHub pull request. Pull requests are optional, and unavailable check data is neutral."',
    );
    expect(html).toContain(
      'title="Compares existing task and base-branch coverage reports. Opening the dialog never runs tests or modifies either worktree."',
    );
  });
});

describe('buildMergeReadiness verify command runs', () => {
  const run = (overrides: Partial<VerificationRun> = {}): VerificationRun => ({
    command: 'npm test',
    status: 'passed',
    exitCode: 0,
    headSha: 'head-1',
    dirty: false,
    startedAt: '2026-09-03T10:00:00.000Z',
    finishedAt: '2026-09-03T10:01:00.000Z',
    outputTail: '12 passed\n',
    ...overrides,
  });
  const atHead = (head_sha: string | null): WorktreeStatus => ({
    ...cleanWorktreeStatus,
    head_sha,
  });
  const verificationOf = (overrides: Partial<MergeReadinessInput>) =>
    buildMergeReadiness(input({ verifyCommandConfigured: true, ...overrides })).checks[1];

  it('asks for a run when a command is configured but nothing ran, ignoring the self-report', () => {
    expect(verificationOf({ verification: passedVerification })).toEqual(
      expect.objectContaining({
        status: 'warning',
        detail: expect.stringContaining('Not verified'),
      }),
    );
  });

  it('passes when the run passed at the current HEAD on a clean tree', () => {
    expect(verificationOf({ verificationRun: run(), worktreeStatus: atHead('head-1') })).toEqual(
      expect.objectContaining({ status: 'pass', detail: 'Passed. `npm test` exited 0.' }),
    );
  });

  it('warns when HEAD moved since the run', () => {
    expect(verificationOf({ verificationRun: run(), worktreeStatus: atHead('head-2') })).toEqual(
      expect.objectContaining({
        status: 'warning',
        detail: expect.stringContaining('older commit'),
      }),
    );
  });

  it('warns when the run saw uncommitted changes', () => {
    expect(
      verificationOf({ verificationRun: run({ dirty: true }), worktreeStatus: atHead('head-1') }),
    ).toEqual(
      expect.objectContaining({
        status: 'warning',
        detail: expect.stringContaining('uncommitted changes'),
      }),
    );
  });

  it('reports checking while a run is in flight', () => {
    expect(
      verificationOf({ verificationRun: run({ status: 'running', finishedAt: null }) }),
    ).toEqual(expect.objectContaining({ status: 'checking', detail: 'Running `npm test`…' }));
  });

  it('warns with the last output line when the run failed', () => {
    expect(
      verificationOf({
        verificationRun: run({
          status: 'failed',
          exitCode: 1,
          outputTail: '11 passed\n1 failed\n',
        }),
      }),
    ).toEqual(expect.objectContaining({ status: 'warning', detail: 'Failed (exit 1). 1 failed' }));
  });

  it('uses a run even when the command was since removed from the project', () => {
    expect(
      buildMergeReadiness(input({ verification: undefined, verificationRun: run() })).checks[1],
    ).toEqual(expect.objectContaining({ status: 'pass' }));
  });

  it('keeps the self-report fallback when nothing is configured and nothing ran', () => {
    expect(buildMergeReadiness(input()).checks[1]).toEqual(
      expect.objectContaining({ status: 'pass', detail: '2 checks passed.' }),
    );
  });
});
