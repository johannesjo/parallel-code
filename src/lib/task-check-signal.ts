import type { SubtaskVerification } from '../../electron/shared/completion-report';
import type { EvidenceConfidence } from '../../electron/shared/evidence-confidence';
import type { VerificationRun } from '../ipc/types';
import type { EvidencePackage } from '../../electron/shared/evidence';
import { EVIDENCE_LEVEL, evidenceSummary, openEvidenceFlags } from './evidence-display';
import { theme } from './theme';
import type { VerifyPassRecord } from '../store/types';
import {
  earlierPass,
  summarizeVerificationRun,
  usesVerificationRun,
  type VerificationSummaryKind,
} from './verification-run';

/** One short summary after the task status; the title holds the full reasons. */
export interface CheckSignal {
  label: string;
  color: string;
  title: string;
}

export interface CheckSignalInput {
  evidence?: EvidenceConfidence;
  evidencePackage?: EvidencePackage;
  verificationRun?: VerificationRun;
  verification?: SubtaskVerification;
  verifyCommandConfigured: boolean;
  headSha?: string | null;
  lastVerifyPass?: VerifyPassRecord;
}

// A native tooltip; the Finish dialog lists every flag.
const MAX_TITLE_FLAGS = 5;

// Kinds without an entry stay silent: a configured-but-never-run command on
// every task would be noise, and cancelled runs carry no signal. A pass is
// muted: verify runs in the background, so most tasks show one.
const RUN_SIGNAL: Partial<Record<VerificationSummaryKind, { label: string; color: string }>> = {
  running: { label: 'verifying…', color: theme.fgMuted },
  passed: { label: 'verified', color: theme.fgMuted },
  stale: { label: 'verify stale', color: theme.warning },
  dirty: { label: 'verify (dirty)', color: theme.warning },
  failed: { label: 'verify failed', color: theme.error },
};

function reportedSignal(verification?: SubtaskVerification): CheckSignal | undefined {
  const checks = verification?.checks;
  if (!checks?.length) return undefined;
  const failed = checks.find((check) => check.result !== 'passed');
  if (!failed)
    return {
      label: 'verified',
      color: theme.fgMuted,
      title: checks.map((check) => `${check.name}: ${check.command}`).join('\n'),
    };
  return {
    label: failed.result === 'blocked' ? 'verify blocked' : 'verify failed',
    color: theme.warning,
    title: `${failed.name}: ${failed.command}${failed.reason ? `\n${failed.reason}` : ''}`,
  };
}

/**
 * Evidence already includes the verify check, so it wins when a package exists.
 * Without one, the same precedence as the Finish dialog's readiness row applies.
 */
export function taskCheckSignal(input: CheckSignalInput): CheckSignal | undefined {
  if (input.evidence) {
    const { level, reasons } = input.evidence;
    const flags = input.evidencePackage ? openEvidenceFlags(input.evidencePackage) : [];
    const title = [
      EVIDENCE_LEVEL[level].label,
      ...reasons.map((reason) => reason.text),
      ...flags.slice(0, MAX_TITLE_FLAGS).map((flag) => `${flag.file}: ${flag.detail}`),
    ];
    if (flags.length > MAX_TITLE_FLAGS) title.push(`…and ${flags.length - MAX_TITLE_FLAGS} more`);
    return {
      // The short form: the title bar has room for a word or two, not a sentence.
      label: evidenceSummary(input.evidence, input.evidencePackage).short,
      color: EVIDENCE_LEVEL[level].color,
      title: title.join('\n'),
    };
  }
  if (!usesVerificationRun(input.verificationRun, input.verifyCommandConfigured))
    return reportedSignal(input.verification);
  const summary = summarizeVerificationRun(input.verificationRun, input.headSha);
  const signal = RUN_SIGNAL[summary.kind];
  if (!signal) return undefined;
  const pass =
    summary.kind === 'failed' && input.verificationRun
      ? earlierPass(input.verificationRun, input.lastVerifyPass)
      : undefined;
  const lastPass = pass ? `\nLast passed at ${pass.headSha.slice(0, 7)}.` : '';
  return { ...signal, title: `${summary.label}. ${summary.detail}${lastPass}` };
}
