import type { SubtaskVerification } from '../../electron/shared/completion-report';
import type { VerificationRun } from '../ipc/types';
import { theme } from './theme';
import type { VerifyPassRecord } from '../store/types';
import {
  earlierPass,
  summarizeVerificationRun,
  usesVerificationRun,
  type VerificationSummaryKind,
} from './verification-run';

/** The next step the checks ask of you, named as an action; the title holds the full reasons. */
export interface CheckSignal {
  label: string;
  color: string;
  title: string;
  /** A failure: shown as a tinted chip rather than plain status text. */
  urgent?: boolean;
}

export interface CheckSignalInput {
  verificationRun?: VerificationRun;
  verification?: SubtaskVerification;
  verifyCommandConfigured: boolean;
  headSha?: string | null;
  lastVerifyPass?: VerifyPassRecord;
}

// Kinds without an entry stay silent: running or passed asks nothing of you, a
// configured-but-never-run command on every task would be noise, and cancelled
// runs carry no signal.
const RUN_SIGNAL: Partial<Record<VerificationSummaryKind, Omit<CheckSignal, 'title'>>> = {
  stale: { label: 'Re-run verify', color: theme.warning },
  dirty: { label: 'Re-run verify', color: theme.warning },
  failed: { label: 'Verify failed', color: theme.error, urgent: true },
};

function reportedSignal(verification?: SubtaskVerification): CheckSignal | undefined {
  const checks = verification?.checks;
  if (!checks?.length) return undefined;
  const failed = checks.find((check) => check.result !== 'passed');
  if (!failed) return undefined;
  return {
    label: failed.result === 'blocked' ? 'Review blocked verify' : 'Fix failing verify',
    color: theme.warning,
    title: `${failed.name}: ${failed.command}${failed.reason ? `\n${failed.reason}` : ''}`,
  };
}

/** The same precedence as the Finish dialog's readiness row. */
export function taskCheckSignal(input: CheckSignalInput): CheckSignal | undefined {
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
