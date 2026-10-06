import { describe, expect, it } from 'vitest';
import type { EvidenceConfidenceLevel } from '../../electron/shared/evidence-confidence';
import type { VerificationRun } from '../ipc/types';
import { taskCheckSignal } from './task-check-signal';
import { theme } from './theme';

const HEAD = 'a'.repeat(40);

function run(overrides: Partial<VerificationRun> = {}): VerificationRun {
  return {
    command: 'npm test',
    headSha: HEAD,
    dirty: false,
    startedAt: '2026-10-06T10:00:00.000Z',
    finishedAt: '2026-10-06T10:01:00.000Z',
    status: 'passed',
    exitCode: 0,
    outputTail: '',
    ...overrides,
  };
}

function runSignal(overrides: Partial<VerificationRun>, headSha = HEAD) {
  return taskCheckSignal({
    verificationRun: run(overrides),
    verifyCommandConfigured: true,
    headSha,
  });
}

describe('taskCheckSignal', () => {
  it.each<[EvidenceConfidenceLevel, string, string]>([
    ['checking', 'checking…', theme.fgMuted],
    ['not-checked', 'outdated', theme.warning],
    ['low', 'needs attention', theme.error],
    ['medium', 'needs attention', theme.warning],
    // Named, never a bare check mark: high confidence is not proof.
    ['high', 'passed', theme.success],
  ])('names evidence level %s as "%s"', (level, label, color) => {
    const signal = taskCheckSignal({
      evidence: { level, reasons: [] },
      verifyCommandConfigured: true,
    });
    expect(signal).toMatchObject({ label, color });
  });

  it('lets evidence win over a failed verify run and lists its reasons on hover', () => {
    const signal = taskCheckSignal({
      evidence: { level: 'not-checked', reasons: [{ level: 'not-checked', text: 'New commits.' }] },
      verificationRun: run({ status: 'failed', exitCode: 1 }),
      verifyCommandConfigured: true,
      headSha: HEAD,
    });
    expect(signal?.label).toBe('outdated');
    expect(signal?.title).toBe('Checks outdated\nNew commits.');
  });

  it('falls back to the verify run without evidence', () => {
    expect(runSignal({})?.label).toBe('verified');
    expect(runSignal({ status: 'failed', exitCode: 1 })?.label).toBe('verify failed');
    expect(runSignal({ status: 'running', finishedAt: undefined })?.label).toBe('verifying…');
    expect(runSignal({}, 'b'.repeat(40))?.label).toBe('verify stale');
    expect(runSignal({ dirty: true })?.label).toBe('verify (dirty)');
  });

  it('stays silent for a cancelled run', () => {
    expect(runSignal({ status: 'cancelled', exitCode: null })).toBeUndefined();
  });

  it('keeps using a past run after the verify command is removed', () => {
    const signal = taskCheckSignal({
      verificationRun: run({ status: 'failed', exitCode: 1 }),
      verifyCommandConfigured: false,
      headSha: HEAD,
    });
    expect(signal?.label).toBe('verify failed');
  });

  it('uses the agent report only when no verify command or run exists', () => {
    const blocked = {
      checks: [{ name: 'Unit', command: 'npm test', result: 'blocked' as const, reason: 'no db' }],
    };
    expect(taskCheckSignal({ verification: blocked, verifyCommandConfigured: false })).toEqual({
      label: 'verify blocked',
      color: theme.warning,
      title: 'Unit: npm test\nno db',
    });
    expect(
      taskCheckSignal({ verification: blocked, verifyCommandConfigured: true }),
    ).toBeUndefined();

    const passed = { checks: [{ name: 'Unit', command: 'npm test', result: 'passed' as const }] };
    expect(taskCheckSignal({ verification: passed, verifyCommandConfigured: false })?.label).toBe(
      'verified',
    );
  });

  it('shows nothing when there is nothing to report', () => {
    expect(taskCheckSignal({ verifyCommandConfigured: false })).toBeUndefined();
  });
});
