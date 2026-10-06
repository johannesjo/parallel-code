import { For, Show, createEffect } from 'solid-js';
import {
  VERIFY_CHECK_ID,
  type EvidencePackage,
  type ProjectCheck,
} from '../../electron/shared/evidence';
import type { VerificationRun } from '../ipc/types';
import { skipReasonText } from '../lib/evidence-plan';
import { summarizeVerificationRun, type VerificationSummaryKind } from '../lib/verification-run';
import { theme } from '../lib/theme';
import {
  cancelEvidenceChecks,
  cancelTaskVerification,
  getTaskChecks,
  getVerificationOutput,
  runEvidenceCheck,
  runTaskVerification,
} from '../store/store';
import type { Task } from '../store/types';
import { evidenceButtonStyle } from './EvidenceDetails';

interface EvidenceCheckListProps {
  task: Task;
  filter?: 'attention' | 'passed';
  pkg?: EvidencePackage;
  /** Current worktree HEAD; results from another commit read as outdated. */
  headSha?: string | null;
  /** An evidence build is running; single checks wait for it. */
  busy: boolean;
  /** Live output of running evidence checks, by check id. */
  outputs?: Record<string, string>;
}

const KIND_STYLE: Record<VerificationSummaryKind, { color: string; symbol: string }> = {
  none: { color: theme.fgMuted, symbol: '—' },
  running: { color: theme.fgMuted, symbol: '…' },
  passed: { color: theme.success, symbol: '✓' },
  stale: { color: theme.warning, symbol: '!' },
  dirty: { color: theme.warning, symbol: '!' },
  failed: { color: theme.error, symbol: '×' },
  unavailable: { color: theme.fgMuted, symbol: '—' },
};
const smallButton = { ...evidenceButtonStyle, padding: '4px 8px', 'font-size': '12px' };
const preStyle = {
  margin: '4px 0 0',
  padding: '6px 8px',
  'max-height': '160px',
  overflow: 'auto',
  'font-size': '12px',
  'white-space': 'pre-wrap',
  'word-break': 'break-word',
  background: theme.bgInput,
  border: `1px solid ${theme.border}`,
  'border-radius': '6px',
} as const;

interface LatestRun {
  run: VerificationRun;
  /** Manual runs and evidence runs are cancelled through different keys. */
  manual: boolean;
}

/** The newer of the package's result and, for verify, the task's own verify run. */
function latestRun(check: ProjectCheck, task: Task, pkg?: EvidencePackage): LatestRun | undefined {
  const evidence = pkg?.checks.find(
    (run) => run.checkId === check.id && run.command === check.command,
  );
  const manual =
    check.id === VERIFY_CHECK_ID && task.verificationRun?.command === check.command
      ? task.verificationRun
      : undefined;
  if (manual && (!evidence || manual.startedAt >= evidence.startedAt))
    return { run: manual, manual: true };
  return evidence ? { run: evidence, manual: false } : undefined;
}

/** Match the same latest result used by the row, including newer manual verification. */
export function evidenceCheckNeedsAttention(
  check: ProjectCheck,
  task: Task,
  pkg?: EvidencePackage,
): boolean {
  return latestRun(check, task, pkg)?.run.status !== 'passed';
}

function CheckRow(props: EvidenceCheckListProps & { check: ProjectCheck }) {
  let live: HTMLPreElement | undefined;
  const isVerify = () => props.check.id === VERIFY_CHECK_ID;
  const latest = () => latestRun(props.check, props.task, props.pkg);
  const running = () => latest()?.run.status === 'running';
  const summary = () => {
    const current = latest();
    if (current) return summarizeVerificationRun(current.run, props.headSha);
    const skip = props.pkg?.skipped.find((s) => s.checkId === props.check.id);
    const text = skip
      ? `Waiting for your click: ${skipReasonText(skip.reason)}`
      : props.pkg?.assembling
        ? 'Queued'
        : 'Not run';
    return { kind: 'none' as const, label: text[0].toUpperCase() + text.slice(1) };
  };
  const liveOutput = () => {
    if (!running()) return '';
    return latest()?.manual
      ? getVerificationOutput(props.task.id)
      : (props.outputs?.[props.check.id] ?? '');
  };
  const failedOutput = () => {
    const run = latest()?.run;
    return run && run.status !== 'passed' && run.status !== 'running' ? run.outputTail : '';
  };
  // Keep the newest output in view while a run streams.
  createEffect(() => {
    liveOutput();
    if (live) live.scrollTop = live.scrollHeight;
  });

  const run = () =>
    void (isVerify()
      ? runTaskVerification(props.task.id)
      : runEvidenceCheck(props.task.id, props.check.id));
  const cancel = () =>
    void (latest()?.manual
      ? cancelTaskVerification(props.task.id)
      : cancelEvidenceChecks(props.task.id, props.check.id));

  return (
    <li
      style={{
        display: 'grid',
        'grid-template-columns': '14px minmax(0, 1fr) auto',
        gap: '6px',
        'align-items': 'baseline',
      }}
    >
      <span aria-hidden="true" style={{ color: KIND_STYLE[summary().kind].color }}>
        {KIND_STYLE[summary().kind].symbol}
      </span>
      <div style={{ 'min-width': '0' }}>
        {/* One line per check: the command yields its width first, then shows on hover. */}
        <div
          style={{
            display: 'flex',
            'flex-wrap': 'wrap',
            gap: '6px',
            'align-items': 'baseline',
            'min-width': '0',
          }}
        >
          <strong style={{ 'overflow-wrap': 'anywhere' }}>{props.check.name}</strong>
          <Show when={isVerify()}>
            <span
              style={{ color: theme.fgMuted, 'white-space': 'nowrap' }}
              title="Agents and the coordinator must pass this before a task lands"
            >
              (required to land)
            </span>
          </Show>
          <span style={{ color: KIND_STYLE[summary().kind].color, 'overflow-wrap': 'anywhere' }}>
            {summary().label}
          </span>
          <code
            title={props.check.command}
            style={{
              flex: '1 1 0',
              'min-width': '0',
              color: theme.fgMuted,
              overflow: 'hidden',
              'text-overflow': 'ellipsis',
              'white-space': 'nowrap',
            }}
          >
            {props.check.command}
          </code>
        </div>
        <Show when={liveOutput()}>
          <pre ref={live} style={preStyle}>
            {liveOutput()}
          </pre>
        </Show>
        <Show when={failedOutput()}>
          <details open>
            <summary style={{ cursor: 'pointer', color: theme.fgMuted }}>Failure output</summary>
            <pre style={preStyle}>{failedOutput()}</pre>
          </details>
        </Show>
      </div>
      <Show
        when={!running()}
        fallback={
          <button type="button" style={smallButton} onClick={cancel}>
            Cancel
          </button>
        }
      >
        <Show when={isVerify() || props.pkg}>
          <button
            type="button"
            style={smallButton}
            disabled={!isVerify() && props.busy}
            onClick={run}
            title={
              !isVerify() && props.busy
                ? 'Waiting for the evidence build to finish'
                : `Run ${props.check.command} in the task worktree`
            }
          >
            {latest() ? 'Re-run' : 'Run'}
          </button>
        </Show>
      </Show>
    </li>
  );
}

/** Configured checks with their latest results; failures come first. */
export function EvidenceCheckList(props: EvidenceCheckListProps) {
  const checks = () =>
    getTaskChecks(props.task.id).filter((check) => {
      if (!props.filter) return true;
      const attention = evidenceCheckNeedsAttention(check, props.task, props.pkg);
      return props.filter === 'attention' ? attention : !attention;
    });
  return (
    <Show when={checks().length > 0}>
      <ul
        aria-label={props.filter === 'passed' ? 'Passed checks' : 'Checks'}
        style={{
          display: 'grid',
          gap: '12px',
          margin: '8px 0 0',
          padding: '0',
          'list-style': 'none',
          'font-size': '13px',
        }}
      >
        <For
          each={[...checks()].sort((a, b) => {
            const rank = (check: ProjectCheck) => {
              const status = latestRun(check, props.task, props.pkg)?.run.status;
              return status && ['failed', 'timed_out', 'error'].includes(status)
                ? 0
                : status === 'passed'
                  ? 2
                  : 1;
            };
            return rank(a) - rank(b);
          })}
        >
          {(check) => <CheckRow {...props} check={check} />}
        </For>
      </ul>
    </Show>
  );
}
