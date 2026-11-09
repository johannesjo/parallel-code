import { describe, expect, it } from 'vitest';
import type { CheckSuite, SuiteCheckRun } from '../../electron/shared/checks';
import type { VerificationRun } from '../ipc/types';
import { isReadyToMergeLocally, type LocalMergeReadinessInput } from './local-merge-readiness';
import { reviewItemId } from './review-summary';
import type { TaskConfidence } from './task-confidence';

const HEAD = 'a'.repeat(40);

const review = (overrides: Partial<TaskConfidence> = {}): TaskConfidence => ({
  scores: [{ label: 'Confidence', score: 85, why: 'Covered by tests.' }],
  findings: [],
  publishedAt: 1,
  origin: 'review',
  ...overrides,
});

const run = (overrides: Partial<VerificationRun> = {}): VerificationRun => ({
  command: 'npm test',
  status: 'passed',
  exitCode: 0,
  headSha: HEAD,
  dirty: false,
  startedAt: '2026-11-09T10:00:00Z',
  finishedAt: '2026-11-09T10:01:00Z',
  outputTail: '',
  ...overrides,
});

const GIT = {
  has_committed_changes: true,
  has_uncommitted_changes: false,
  head_sha: HEAD,
  refreshedAt: 1,
};

const input = (overrides: Partial<LocalMergeReadinessInput> = {}): LocalMergeReadinessInput => ({
  git: GIT,
  confidence: review(),
  reviewOutdated: false,
  verifyCommandConfigured: false,
  ...overrides,
});

const suite = (headSha: string, status: SuiteCheckRun['status']): CheckSuite => ({
  id: 'suite-1',
  assembling: false,
  scan: { headSha, baseSha: 'b'.repeat(40), dirty: false, files: [], flags: [] },
  checks: [{ ...run({ status, headSha }), checkId: 'lint', name: 'Lint', kind: 'static' }],
  skipped: [],
});

describe('isReadyToMergeLocally', () => {
  it('is ready when a current review found nothing and nothing failed', () => {
    expect(isReadyToMergeLocally(input())).toBe(true);
  });

  it('needs the app reviewer, not a rating the agent published about itself', () => {
    expect(isReadyToMergeLocally(input({ confidence: undefined }))).toBe(false);
    expect(isReadyToMergeLocally(input({ confidence: review({ origin: undefined }) }))).toBe(false);
  });

  it('drops out once the code changed after the review', () => {
    expect(isReadyToMergeLocally(input({ reviewOutdated: true }))).toBe(false);
  });

  it('holds back a low score', () => {
    const low = review({ scores: [{ label: 'Complete', score: 40, why: 'Half done.' }] });
    expect(isReadyToMergeLocally(input({ confidence: low }))).toBe(false);
  });

  it('holds back open gaps and risks until they are dismissed, but not unconfirmed doubts', () => {
    const text = 'The retry loop never gives up.';
    const risky = review({ findings: [{ kind: 'risk', text }] });
    expect(isReadyToMergeLocally(input({ confidence: risky }))).toBe(false);
    const dismissed = { [reviewItemId('risk', text)]: { text, reason: '' } };
    expect(isReadyToMergeLocally(input({ confidence: risky, dismissed }))).toBe(true);
    const doubt = review({ findings: [{ kind: 'unverified', text }] });
    expect(isReadyToMergeLocally(input({ confidence: doubt }))).toBe(true);
  });

  it('needs committed, clean work and a git status that was read', () => {
    const git = GIT;
    expect(isReadyToMergeLocally(input({ git: { ...git, has_uncommitted_changes: true } }))).toBe(
      false,
    );
    expect(isReadyToMergeLocally(input({ git: { ...git, has_committed_changes: false } }))).toBe(
      false,
    );
    expect(isReadyToMergeLocally(input({ git: { ...git, refreshedAt: 0 } }))).toBe(false);
    expect(isReadyToMergeLocally(input({ git: { ...git, error: 'unreadable' } }))).toBe(false);
  });

  it('needs a verify pass on this very commit when a verify command is set', () => {
    const configured = { verifyCommandConfigured: true };
    expect(isReadyToMergeLocally(input(configured))).toBe(false);
    expect(isReadyToMergeLocally(input({ ...configured, verificationRun: run() }))).toBe(true);
    const older = run({ headSha: 'c'.repeat(40) });
    expect(isReadyToMergeLocally(input({ ...configured, verificationRun: older }))).toBe(false);
    const failed = run({ status: 'failed', exitCode: 1 });
    expect(isReadyToMergeLocally(input({ ...configured, verificationRun: failed }))).toBe(false);
    const dirty = run({ dirty: true });
    expect(isReadyToMergeLocally(input({ ...configured, verificationRun: dirty }))).toBe(false);
  });

  it("falls back to the agent's report without a verify command", () => {
    const verification = {
      checks: [{ name: 'tests', command: 'npm test', result: 'failed' as const }],
    };
    expect(isReadyToMergeLocally(input({ verification }))).toBe(false);
  });

  it('holds back a failed check on the current commit, not one on an older commit', () => {
    expect(isReadyToMergeLocally(input({ evidence: suite(HEAD, 'failed') }))).toBe(false);
    expect(isReadyToMergeLocally(input({ evidence: suite(HEAD, 'passed') }))).toBe(true);
    expect(isReadyToMergeLocally(input({ evidence: suite('c'.repeat(40), 'failed') }))).toBe(true);
  });
});
