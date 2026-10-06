import { EVIDENCE_LIMITS, type EvidencePackage } from '../../electron/shared/evidence';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Bounds what a package adds to state.json: check output keeps only its tail. */
export function persistedEvidence(pkg: EvidencePackage | undefined): EvidencePackage | undefined {
  if (!pkg) return undefined;
  const max = EVIDENCE_LIMITS.persistedTailChars;
  return {
    ...pkg,
    checks: pkg.checks.map((run) => ({ ...run, outputTail: run.outputTail.slice(-max) })),
  };
}

/**
 * A saved package from an older or interrupted session. Anything still in
 * flight when the app quit has no process behind it anymore, so it is marked
 * as cancelled rather than restored as running. Malformed data is dropped:
 * the package can always be rebuilt.
 */
export function restoredEvidence(value: unknown): EvidencePackage | undefined {
  if (!isRecord(value) || !isRecord(value.scan) || typeof value.scan.headSha !== 'string')
    return undefined;
  if (!Array.isArray(value.checks) || !Array.isArray(value.skipped)) return undefined;
  const pkg = value as unknown as EvidencePackage;
  const finishedAt = new Date().toISOString();
  return {
    ...pkg,
    assembling: false,
    acceptedFlags: isRecord(pkg.acceptedFlags) ? pkg.acceptedFlags : {},
    dismissedFindings: Array.isArray(pkg.dismissedFindings) ? pkg.dismissedFindings : [],
    checks: pkg.checks.map((run) =>
      run.status === 'running'
        ? { ...run, status: 'cancelled', finishedAt, message: 'Interrupted when the app quit.' }
        : run,
    ),
    ...(pkg.review?.status === 'running' && {
      review: { ...pkg.review, status: 'error', error: 'Interrupted when the app quit.' },
    }),
  };
}
