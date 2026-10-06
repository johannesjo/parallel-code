import { describe, expect, it } from 'vitest';
import type { EvidenceCheckRun, EvidencePackage } from '../../electron/shared/evidence';
import { evidenceSummary, evidenceCheckOutcomes } from './evidence-display';

const HEAD = 'a'.repeat(40);

function check(overrides: Partial<EvidenceCheckRun> = {}): EvidenceCheckRun {
  return {
    checkId: 'unit',
    name: 'Unit',
    kind: 'unit',
    command: 'npm test',
    status: 'passed',
    exitCode: 0,
    headSha: HEAD,
    dirty: false,
    startedAt: '2026-10-06T10:00:00.000Z',
    finishedAt: '2026-10-06T10:01:00.000Z',
    outputTail: '',
    ...overrides,
  };
}

function pkg(overrides: Partial<EvidencePackage> = {}): EvidencePackage {
  return {
    id: 'p1',
    createdAt: '2026-10-06T10:00:00.000Z',
    trigger: 'agent',
    assembling: false,
    scan: {
      headSha: HEAD,
      baseSha: 'b'.repeat(40),
      dirty: false,
      files: [],
      flags: [],
      tests: [],
      coveringTests: [],
      sourceWithoutTests: [],
    },
    checks: [check()],
    skipped: [],
    acceptedFlags: {},
    dismissedFindings: [],
    ...overrides,
  };
}

const flag = {
  id: 'execution-surface-changed:1',
  category: 'needs-decision' as const,
  rule: 'execution-surface-changed',
  file: 'vitest.config.ts',
  detail: 'x',
};
const failed = check({ status: 'failed', exitCode: 1 });
const skip = { checkId: 'e2e', name: 'E2E', kind: 'e2e' as const, reason: 'on-demand' as const };

describe('evidenceSummary', () => {
  it.each<[string, EvidencePackage, string, string]>([
    [
      'two failed checks',
      pkg({ checks: [failed, { ...failed, checkId: 'lint' }] }),
      '2 checks failed',
      '2 failed',
    ],
    [
      'an open decision',
      pkg({ scan: { ...pkg().scan, flags: [flag] } }),
      '1 decision needed',
      '1 to decide',
    ],
    ['a skipped check', pkg({ skipped: [skip] }), '1 check not run', '1 not run'],
    ['everything passed', pkg(), 'All configured checks passed', 'passed'],
  ])('gives %s a headline and a short form', (_name, evidence, headline, short) => {
    expect(evidenceSummary({ level: 'high', reasons: [] }, evidence)).toEqual({ headline, short });
  });

  it('puts freshness ahead of older failures', () => {
    expect(
      evidenceSummary({ level: 'not-checked', reasons: [] }, pkg({ checks: [failed] })),
    ).toEqual({
      headline: 'Checks outdated',
      short: 'outdated',
    });
  });

  it('keeps an accepted decision out of the count', () => {
    const evidence = pkg({
      scan: { ...pkg().scan, flags: [flag] },
      acceptedFlags: { [flag.id]: 'reviewed' },
    });
    expect(evidenceSummary({ level: 'high', reasons: [] }, evidence).short).toBe('passed');
  });
});

describe('evidenceCheckOutcomes', () => {
  it('distinguishes failures, cancellations, skipped and queued checks without double-counting', () => {
    const evidence = pkg({
      checks: [
        check(),
        check({ checkId: 'timeout', status: 'timed_out' }),
        check({ checkId: 'cancel', status: 'cancelled' }),
        check({ checkId: 'running', status: 'running' }),
      ],
      skipped: [skip],
      configuredChecks: [
        { id: 'queued', name: 'Queued', command: 'x', kind: 'custom', run: 'auto' },
      ],
      assembling: true,
    });
    expect(evidenceCheckOutcomes(evidence)).toBe(
      '1 passed · 1 failed · 1 running · 1 waiting · 2 not run',
    );
    evidence.assembling = false;
    expect(evidenceCheckOutcomes(evidence)).toBe('1 passed · 1 failed · 1 running · 3 not run');
  });
});
