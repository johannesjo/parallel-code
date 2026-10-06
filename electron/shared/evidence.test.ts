import { describe, expect, it } from 'vitest';
import { computeEvidenceConfidence } from './evidence-confidence.js';
import {
  EVIDENCE_LIMITS,
  parseEvidenceSubmission,
  type EvidenceCheckRun,
  type EvidencePackage,
} from './evidence.js';

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
    headShaAfter: HEAD,
    dirtyAfter: false,
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
    claim: { submittedAt: '2026-10-06T10:00:00.000Z', notVerified: [] },
    acceptedFlags: {},
    dismissedFindings: [],
    ...overrides,
  };
}

const scan = (overrides: Partial<EvidencePackage['scan']>) => ({ ...pkg().scan, ...overrides });
const weakened = {
  id: 'test-removed:1',
  category: 'test-weakened' as const,
  rule: 'test-removed',
  file: 'a.test.ts',
  detail: 'x',
};
const decision = {
  ...weakened,
  id: 'execution-surface-changed:1',
  category: 'needs-decision' as const,
};

describe('computeEvidenceConfidence', () => {
  it.each<[string, EvidencePackage, string | null, string]>([
    ['all checks passed, handed off, nothing open', pkg(), HEAD, 'high'],
    ['assembling', pkg({ assembling: true }), HEAD, 'checking'],
    ['a check still running', pkg({ checks: [check({ status: 'running' })] }), HEAD, 'checking'],
    [
      'uncommitted changes at build time',
      pkg({ scan: scan({ dirty: true }) }),
      HEAD,
      'not-checked',
    ],
    ['new commits since the build', pkg(), 'c'.repeat(40), 'not-checked'],
    [
      'commit during a check',
      pkg({ checks: [check({ headShaAfter: 'c'.repeat(40) })] }),
      HEAD,
      'not-checked',
    ],
    ['edit during a check', pkg({ checks: [check({ dirtyAfter: true })] }), HEAD, 'not-checked'],
    [
      'stale beats failed',
      pkg({ checks: [check({ status: 'failed' })] }),
      'c'.repeat(40),
      'not-checked',
    ],
    ['failed check', pkg({ checks: [check({ status: 'failed', exitCode: 1 })] }), HEAD, 'low'],
    ['timed out check', pkg({ checks: [check({ status: 'timed_out' })] }), HEAD, 'low'],
    ['check could not start', pkg({ checks: [check({ status: 'error' })] }), HEAD, 'low'],
    ['nothing executed', pkg({ checks: [] }), HEAD, 'low'],
    ['only a cancelled check', pkg({ checks: [check({ status: 'cancelled' })] }), HEAD, 'low'],
    ['open test-weakened flag', pkg({ scan: scan({ flags: [weakened] }) }), HEAD, 'low'],
    [
      'accepted test-weakened flag',
      pkg({ scan: scan({ flags: [weakened] }), acceptedFlags: { [weakened.id]: 'obsolete' } }),
      HEAD,
      'high',
    ],
    ['open needs-decision flag', pkg({ scan: scan({ flags: [decision] }) }), HEAD, 'medium'],
    [
      'info flags do not count',
      pkg({ scan: scan({ flags: [{ ...weakened, category: 'info' }] }) }),
      HEAD,
      'high',
    ],
    [
      'on-demand check skipped',
      pkg({ skipped: [{ checkId: 'e2e', name: 'E2E', kind: 'e2e', reason: 'on-demand' }] }),
      HEAD,
      'medium',
    ],
    [
      'source without tests',
      pkg({ scan: scan({ sourceWithoutTests: ['src/a.ts'] }) }),
      HEAD,
      'medium',
    ],
    ['no handoff', pkg({ claim: undefined }), HEAD, 'medium'],
    [
      'declared gaps',
      pkg({ claim: { submittedAt: 'x', notVerified: ['Safari'] } }),
      HEAD,
      'medium',
    ],
  ])('%s → %s', (_name, input, currentHead, expected) => {
    expect(computeEvidenceConfidence(input, currentHead).level).toBe(expected);
  });

  it('treats silence and honest gaps alike, so claiming less never scores better', () => {
    const silent = computeEvidenceConfidence(pkg({ claim: undefined }), HEAD).level;
    const honest = computeEvidenceConfidence(
      pkg({ claim: { submittedAt: 'x', notVerified: ['Safari'] } }),
      HEAD,
    ).level;
    expect(silent).toBe(honest);
  });

  it('names a contradicted claim and keeps it low', () => {
    const result = computeEvidenceConfidence(
      pkg({
        checks: [check({ status: 'failed' })],
        claim: { submittedAt: 'x', checkResults: [{ checkId: 'unit', result: 'passed' }] },
      }),
      HEAD,
    );
    expect(result.level).toBe('low');
    expect(result.reasons.map((reason) => reason.text)).toContain(
      'The agent said Unit passed; it did not.',
    );
  });

  it('lets a model blocker lower the band but never raise it', () => {
    const finding = { id: 'f1', severity: 'blocker' as const, file: 'a.ts', line: 1, text: 'x' };
    const review = {
      status: 'done' as const,
      provider: 'claude' as const,
      headSha: HEAD,
      findings: [finding],
    };
    expect(computeEvidenceConfidence(pkg({ review }), HEAD).level).toBe('medium');
    expect(computeEvidenceConfidence(pkg({ review, dismissedFindings: ['f1'] }), HEAD).level).toBe(
      'high',
    );
    expect(
      computeEvidenceConfidence(
        pkg({ review: { ...review, findings: [] }, checks: [check({ status: 'failed' })] }),
        HEAD,
      ).level,
    ).toBe('low');
  });

  it('orders reasons most severe first', () => {
    const result = computeEvidenceConfidence(
      pkg({ claim: undefined, checks: [check({ status: 'failed' })] }),
      HEAD,
    );
    expect(result.reasons.map((reason) => reason.level)).toEqual(['low', 'medium']);
  });
});

describe('evidence freshness', () => {
  const configured = [
    { id: 'unit', name: 'Unit', kind: 'unit' as const, command: 'npm test', run: 'auto' as const },
  ];
  it('caps an incomplete scan even when all available evidence passes', () => {
    expect(computeEvidenceConfidence(pkg({ scan: scan({ truncated: true }) }), HEAD).level).toBe(
      'medium',
    );
  });
  it('marks later uncommitted edits as outdated', () => {
    expect(computeEvidenceConfidence(pkg(), HEAD, { dirty: true }).level).toBe('not-checked');
  });
  it('rejects a different command result after settings return to the original command', () => {
    const evidence = pkg({
      configuredChecks: configured,
      checks: [check({ command: 'npm run other' })],
    });
    const result = computeEvidenceConfidence(evidence, HEAD, { checks: configured });
    expect(result.level).toBe('not-checked');
    expect(result.reasons[0].text).toContain('results do not match');
  });

  it('requires a rebuild after check configuration changes', () => {
    const evidence = pkg({ configuredChecks: configured });
    expect(computeEvidenceConfidence(evidence, HEAD, { checks: configured }).level).toBe('high');
    expect(
      computeEvidenceConfidence(evidence, HEAD, {
        checks: [{ ...configured[0], command: 'npm run different' }],
      }).level,
    ).toBe('not-checked');
    expect(computeEvidenceConfidence(evidence, HEAD, { checks: [] }).level).toBe('not-checked');
    expect(computeEvidenceConfidence(pkg(), HEAD, { checks: configured }).level).toBe(
      'not-checked',
    );
  });
});

describe('parseEvidenceSubmission', () => {
  it('accepts an empty call and a full submission', () => {
    expect(parseEvidenceSubmission(undefined)).toEqual({});
    expect(
      parseEvidenceSubmission({
        summary: 'Adds X',
        notVerified: ['Safari'],
        risks: ['Migration'],
        checkResults: [{ checkId: 'verify', result: 'passed' }],
      }),
    ).toEqual({
      summary: 'Adds X',
      notVerified: ['Safari'],
      risks: ['Migration'],
      checkResults: [{ checkId: 'verify', result: 'passed' }],
    });
  });

  it.each([
    ['app-owned fields', { checks: [] }, 'does not accept checks'],
    ['a confidence claim', { confidence: 'high' }, 'does not accept confidence'],
    ['an unknown result', { checkResults: [{ checkId: 'verify', result: 'ok' }] }, 'result must'],
    ['a malformed check id', { checkResults: [{ checkId: '../x', result: 'passed' }] }, 'checkId'],
    [
      'extra check fields',
      { checkResults: [{ checkId: 'a', result: 'passed', log: 'x' }] },
      'unknown',
    ],
    ['blank strings', { notVerified: [' '] }, 'non-empty'],
    [
      'too many items',
      { risks: Array.from({ length: EVIDENCE_LIMITS.maxItems + 1 }, () => 'r') },
      'at most',
    ],
    ['an oversized summary', { summary: 'x'.repeat(EVIDENCE_LIMITS.summaryBytes + 1) }, 'exceeds'],
    ['a non-object', [], 'must be an object'],
  ])('rejects %s', (_name, input, message) => {
    expect(() => parseEvidenceSubmission(input)).toThrow(message);
  });
});
