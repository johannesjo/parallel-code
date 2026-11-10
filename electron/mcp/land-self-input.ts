import type { LandSelfInput, SubtaskVerification } from './types.js';

/** Validates untrusted `land_self` arguments; returns the error text when they are invalid.
 *  Shared by the HTTP route and session tool calls so neither lands on a malformed claim. */
export function parseLandSelfInput(body: Record<string, unknown>): LandSelfInput | string {
  const summary = body.summary;
  if (summary !== undefined && typeof summary !== 'string') return 'summary must be a string';
  if (summary !== undefined && summary.length > 20_000)
    return 'summary must be 20000 characters or fewer';

  const verification = body.verification as { checks?: unknown } | undefined;
  if (!verification || typeof verification !== 'object') {
    return 'verification must be an object';
  }
  if (!Array.isArray(verification.checks) || verification.checks.length === 0) {
    return 'verification.checks must be a non-empty array';
  }
  if (verification.checks.length > 50) return 'verification.checks must contain 50 checks or fewer';

  const checks: SubtaskVerification['checks'] = [];
  for (const rawCheck of verification.checks) {
    if (!rawCheck || typeof rawCheck !== 'object') return 'verification checks must be objects';
    const check = rawCheck as Record<string, unknown>;
    if (typeof check.name !== 'string' || !check.name.trim()) {
      return 'verification check name must be a non-empty string';
    }
    if (typeof check.command !== 'string' || !check.command.trim()) {
      return 'verification check command must be a non-empty string';
    }
    if (check.result !== 'passed' && check.result !== 'blocked' && check.result !== 'failed') {
      return 'verification check result must be passed, blocked, or failed';
    }
    if (check.reason !== undefined && typeof check.reason !== 'string') {
      return 'verification check reason must be a string';
    }
    checks.push({
      name: check.name,
      command: check.command,
      result: check.result,
      reason: check.reason,
    });
  }

  return { verification: { checks }, summary };
}
