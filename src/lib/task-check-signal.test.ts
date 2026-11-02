import { describe, expect, it } from 'vitest';
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
  it('names the next step a verify run asks for', () => {
    expect(runSignal({ status: 'failed', exitCode: 1 })?.label).toBe('Verify failed');
    expect(runSignal({}, 'b'.repeat(40))?.label).toBe('Re-run verify');
    expect(runSignal({ dirty: true })?.label).toBe('Re-run verify');
  });

  it('stays silent while verify runs or after it passed', () => {
    expect(runSignal({})).toBeUndefined();
    expect(runSignal({ status: 'running', finishedAt: undefined })).toBeUndefined();
  });

  it('points a failure at the last pass', () => {
    const signal = taskCheckSignal({
      verificationRun: run({ status: 'failed', exitCode: 1 }),
      verifyCommandConfigured: true,
      headSha: HEAD,
      lastVerifyPass: { command: run().command, headSha: 'c'.repeat(40), finishedAt: 'x' },
    });
    expect(signal?.color).toBe(theme.error);
    expect(signal?.title).toContain('\nLast passed at ccccccc.');
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
    expect(signal?.label).toBe('Verify failed');
  });

  it('uses the agent report only when no verify command or run exists', () => {
    const blocked = {
      checks: [{ name: 'Unit', command: 'npm test', result: 'blocked' as const, reason: 'no db' }],
    };
    expect(taskCheckSignal({ verification: blocked, verifyCommandConfigured: false })).toEqual({
      label: 'Review blocked verify',
      color: theme.warning,
      title: 'Unit: npm test\nno db',
    });
    expect(
      taskCheckSignal({ verification: blocked, verifyCommandConfigured: true }),
    ).toBeUndefined();

    const passed = { checks: [{ name: 'Unit', command: 'npm test', result: 'passed' as const }] };
    expect(
      taskCheckSignal({ verification: passed, verifyCommandConfigured: false }),
    ).toBeUndefined();
  });

  it('shows nothing when there is nothing to report', () => {
    expect(taskCheckSignal({ verifyCommandConfigured: false })).toBeUndefined();
  });
});
