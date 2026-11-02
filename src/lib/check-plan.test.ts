import { describe, expect, it } from 'vitest';
import type { ProjectCheck } from '../../electron/shared/checks';
import type { VerificationRun } from '../ipc/types';
import { compileCheckFailurePrompt, planChecks, reusableVerifyRun } from './check-plan';

const HEAD = 'a'.repeat(40);
const verify: ProjectCheck = {
  id: 'verify',
  name: 'Verify',
  kind: 'custom',
  command: 'npm run check',
  run: 'auto',
};
const e2e: ProjectCheck = { id: 'e2e', name: 'E2E', kind: 'e2e', command: 'e2e', run: 'on-demand' };
const surface = {
  id: 'execution-surface-changed:1',
  rule: 'execution-surface-changed',
  file: 'package.json',
  detail: 'x',
};

function run(overrides: Partial<VerificationRun> = {}): VerificationRun {
  return {
    command: 'npm run check',
    status: 'passed',
    exitCode: 0,
    headSha: HEAD,
    dirty: false,
    startedAt: 'x',
    finishedAt: 'y',
    outputTail: '',
    ...overrides,
  };
}

describe('planChecks', () => {
  const plan = (overrides: Partial<Parameters<typeof planChecks>[0]> = {}) =>
    planChecks({
      checks: [verify, e2e],
      dockerMode: false,
      flags: [],
      ...overrides,
    });

  it('runs auto checks and leaves on-demand ones for a click', () => {
    expect(plan().run).toEqual([verify]);
    expect(plan().skipped).toEqual([
      { checkId: 'e2e', name: 'E2E', kind: 'e2e', reason: 'on-demand' },
    ]);
  });

  it('never runs anything unasked for Docker tasks, since checks execute on the host', () => {
    expect(plan({ dockerMode: true }).run).toEqual([]);
    expect(plan({ dockerMode: true }).skipped[0].reason).toBe('docker');
  });

  it('holds checks back when the change touches how they run', () => {
    expect(plan({ flags: [surface] }).run).toEqual([]);
    expect(plan({ flags: [surface] }).skipped[0].reason).toBe('execution-surface');
  });
});

it.each(['dirty', 'truncated'] as const)('holds automatic checks for a %s scan', (field) => {
  const result = planChecks({
    checks: [verify],
    dockerMode: false,
    flags: [],
    [field]: true,
  });
  expect(result.run).toEqual([]);
  expect(result.skipped[0].reason).toBe(field === 'dirty' ? 'dirty' : 'incomplete');
});

describe('reusableVerifyRun', () => {
  it('reuses a finished verify run of the same clean commit', () => {
    expect(reusableVerifyRun(run(), verify, HEAD)).toMatchObject({
      checkId: 'verify',
      reused: true,
    });
    expect(reusableVerifyRun(run({ status: 'failed' }), verify, HEAD)?.status).toBe('failed');
  });

  it.each<[string, VerificationRun]>([
    ['another commit', run({ headSha: 'b'.repeat(40) })],
    ['a dirty tree', run({ dirty: true })],
    ['a commit during the run', run({ headShaAfter: 'b'.repeat(40) })],
    ['another command', run({ command: 'npm test' })],
    ['a running run', run({ status: 'running' })],
    ['a cancelled run', run({ status: 'cancelled' })],
  ])('does not reuse %s', (_name, input) => {
    expect(reusableVerifyRun(input, verify, HEAD)).toBeUndefined();
  });

  it('only stands in for the verify check', () => {
    expect(reusableVerifyRun(run({ command: 'e2e' }), e2e, HEAD)).toBeUndefined();
  });
});

describe('compileCheckFailurePrompt', () => {
  const failed = {
    ...run({ status: 'failed', exitCode: 1, outputTail: 'boom' }),
    checkId: 'e2e',
    name: 'E2E',
    kind: 'e2e' as const,
  };

  it('has nothing to send when no check failed', () => {
    expect(
      compileCheckFailurePrompt([{ ...failed, status: 'passed', exitCode: 0 }]),
    ).toBeUndefined();
  });

  it('sends each failure with its output and forbids weakening tests', () => {
    const prompt = compileCheckFailurePrompt([failed]);
    expect(prompt).toContain('Check "E2E" failed (exit 1): `npm run check`');
    expect(prompt).toContain('boom');
    expect(prompt).toContain('never weaken a test');
  });
});
