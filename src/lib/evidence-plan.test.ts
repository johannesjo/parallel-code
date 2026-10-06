import { describe, expect, it } from 'vitest';
import type { EvidencePackage, ProjectCheck } from '../../electron/shared/evidence';
import type { VerificationRun } from '../ipc/types';
import {
  compileEvidencePrompt,
  compileEvidenceQuestion,
  evidenceForAgent,
  planChecks,
  reusableVerifyRun,
} from './evidence-plan';

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
  category: 'needs-decision' as const,
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
      acceptedFlags: {},
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

  it('holds checks back while a change to how they run is unreviewed', () => {
    expect(plan({ flags: [surface] }).skipped[0].reason).toBe('execution-surface');
    expect(plan({ flags: [surface], acceptedFlags: { [surface.id]: 'ok' } }).run).toEqual([verify]);
  });
});

it.each(['dirty', 'truncated'] as const)('holds automatic checks for a %s scan', (field) => {
  const result = planChecks({
    checks: [verify],
    dockerMode: false,
    flags: [],
    acceptedFlags: {},
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

function pkg(overrides: Partial<EvidencePackage> = {}): EvidencePackage {
  return {
    id: 'p',
    createdAt: 'x',
    trigger: 'agent',
    assembling: false,
    configuredChecks: [verify],
    scan: {
      headSha: HEAD,
      baseSha: HEAD,
      dirty: false,
      files: [],
      flags: [],
      tests: [],
      coveringTests: [],
      sourceWithoutTests: [],
    },
    checks: [{ ...run(), checkId: 'verify', name: 'Verify', kind: 'custom' }],
    skipped: [],
    acceptedFlags: {},
    dismissedFindings: [],
    ...overrides,
  };
}

describe('compileEvidencePrompt', () => {
  it('has nothing to send when checks pass and no test was weakened', () => {
    expect(compileEvidencePrompt(pkg())).toBeUndefined();
  });

  it('sends failures and weakened tests, and forbids weakening tests further', () => {
    const flag = {
      ...surface,
      id: 'f',
      category: 'test-weakened' as const,
      file: 'a.test.ts',
      line: 3,
    };
    const prompt = compileEvidencePrompt(
      pkg({
        checks: [
          {
            ...run({ status: 'failed', exitCode: 1, outputTail: 'boom' }),
            checkId: 'verify',
            name: 'Verify',
            kind: 'custom',
          },
        ],
        scan: { ...pkg().scan, flags: [flag] },
      }),
    );
    expect(prompt).toContain('Check "Verify" failed (exit 1)');
    expect(prompt).toContain('boom');
    expect(prompt).toContain('a.test.ts:3');
    expect(prompt).toContain('never weaken a test');
  });

  it('leaves accepted flags out', () => {
    const flag = { ...surface, id: 'f', category: 'test-weakened' as const };
    expect(
      compileEvidencePrompt(
        pkg({ scan: { ...pkg().scan, flags: [flag] }, acceptedFlags: { f: 'ok' } }),
      ),
    ).toBeUndefined();
  });
});

describe('evidenceForAgent', () => {
  it('lists the configured check ids even before any package exists', () => {
    expect(evidenceForAgent(undefined, [verify])).toEqual({
      status: 'none',
      checks: [{ id: 'verify', name: 'Verify', kind: 'custom' }],
    });
  });

  it('reports the band, its reasons and open flags but no logs', () => {
    const result = evidenceForAgent(pkg({ scan: { ...pkg().scan, flags: [surface] } }), [verify]);
    expect(result).toMatchObject({
      status: 'medium',
      results: [{ id: 'verify', status: 'passed' }],
    });
    expect(result.flags).toEqual([
      { rule: surface.rule, file: surface.file, line: undefined, detail: 'x' },
    ]);
    expect(JSON.stringify(result)).not.toContain('outputTail');
  });
});

it('sends only the selected AI observation and rejects resolved or missing items', () => {
  const evidence = pkg({
    review: {
      status: 'done',
      provider: 'claude',
      headSha: HEAD,
      findings: [{ id: 'f', file: 'a.ts', line: 7, text: 'Check retries', severity: 'concern' }],
    },
  });
  expect(compileEvidenceQuestion(evidence, { kind: 'finding', id: 'f' })).toContain(
    'AI review (concern) — a.ts:7: Check retries',
  );
  expect(compileEvidenceQuestion(evidence, { kind: 'gap', index: 0 })).toBeUndefined();
  evidence.dismissedFindings.push('f');
  expect(compileEvidenceQuestion(evidence, { kind: 'finding', id: 'f' })).toBeUndefined();
});
