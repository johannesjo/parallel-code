import { Show, createSignal, createUniqueId, onCleanup, onMount, type JSX } from 'solid-js';
import { VERIFY_CHECK_ID } from '../../electron/shared/checks';
import { readinessLine, type ReadinessAction } from '../lib/readiness-line';
import { theme } from '../lib/theme';
import {
  backgroundVerifyEnabled,
  cancelTaskVerification,
  getBackgroundVerifyHold,
  getCheckSuiteUiState,
  getTaskChecks,
  isCheckSuiteBusy,
  runTaskVerification,
  stageCheckFailurePrompt,
  stageVerificationFailurePrompt,
} from '../store/store';
import type { Task } from '../store/types';
import { PlayIcon } from './icons';

interface ReadinessSectionProps {
  task: Task;
  /** Current worktree HEAD; a result from another commit does not count. */
  headSha?: string | null;
  /** Full hashes of the branch's commits, oldest first, for "N commits ago". */
  branchCommits?: readonly string[];
  onConfigure?: () => void;
  /** After a fix prompt was staged in the task's input. */
  onStaged?: () => void;
  /** Whether `children` has rows to show; Details is hidden without them. */
  hasDetails: boolean;
  /** The remaining readiness rows, such as coverage, behind Details. */
  children: JSX.Element;
}

const FAILED = new Set(['failed', 'timed_out', 'error']);
// Ages read "4m ago"; a refresh this often keeps them honest without churn.
const NOW_REFRESH_MS = 30_000;

const buttonStyle = {
  padding: '4px 10px',
  background: theme.bgInput,
  border: `1px solid ${theme.border}`,
  'border-radius': '6px',
  color: theme.fg,
  cursor: 'pointer',
  'font-size': '13px',
};
const toggleStyle = {
  background: 'none',
  border: 'none',
  padding: '4px 0',
  color: theme.fgMuted,
  cursor: 'pointer',
  'font-size': '13px',
  // It shares the status row, which the detail text may fill.
  'white-space': 'nowrap',
  'flex-shrink': '0',
};
const rowStyle = {
  display: 'flex',
  'align-items': 'center',
  gap: '8px',
  // One row tall in every state, so a result arriving never moves the dialog.
  'min-height': '28px',
};
const detailStyle = {
  flex: '1',
  'min-width': '0',
  color: theme.fgMuted,
  overflow: 'hidden',
  'text-overflow': 'ellipsis',
  'white-space': 'nowrap',
} as const;

const codeStyle = { 'font-family': 'var(--font-mono)', 'font-size': '12px' };

const ACTION_LABEL: Record<ReadinessAction, string> = {
  run: 'Run',
  rerun: 'Re-run',
  cancel: 'Cancel',
  stage: 'Stage fix prompt',
  configure: 'Configure checks',
};

/**
 * One line that says whether the verify command passed on this commit, who ran
 * it and when, with the one action that fits. Checks run in the background
 * after agent turns, so usually the result is already here. The remaining
 * readiness rows sit behind Details.
 */
export function ReadinessSection(props: ReadinessSectionProps) {
  const [open, setOpen] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });
  const bodyId = createUniqueId();
  const verifyCommand = () =>
    getTaskChecks(props.task.id).find((check) => check.id === VERIFY_CHECK_ID)?.command;
  const line = () =>
    readinessLine({
      verifyCommand: verifyCommand(),
      run: props.task.verificationRun,
      verification: props.task.verification,
      headSha: props.headSha,
      hold: getBackgroundVerifyHold(props.task.id),
      lastPass: props.task.lastVerifyPass,
      branchCommits: props.branchCommits,
      autoRun: backgroundVerifyEnabled(props.task.id),
      now: now(),
    });
  const detailTitle = () => [line().command, line().detail].filter(Boolean).join(' · ');
  // A review's check run restarts verify itself, so a click would only cancel its run.
  const suiteBusy = () => {
    const pkg = props.task.evidence;
    return (
      Boolean(getCheckSuiteUiState(props.task.id).scanning) || Boolean(pkg && isCheckSuiteBusy(pkg))
    );
  };
  const action = () => {
    const next = line().action;
    if (next === 'configure' && !props.onConfigure) return undefined;
    if ((next === 'run' || next === 'rerun') && suiteBusy()) return undefined;
    return next;
  };
  const otherFailures = () =>
    (props.task.evidence?.checks ?? []).filter(
      (check) => check.checkId !== VERIFY_CHECK_ID && FAILED.has(check.status),
    );
  const run = (next: ReadinessAction) => {
    if (next === 'run' || next === 'rerun') void runTaskVerification(props.task.id);
    if (next === 'cancel') void cancelTaskVerification(props.task.id);
    if (next === 'configure') props.onConfigure?.();
    if (next === 'stage' && stageVerificationFailurePrompt(props.task.id)) props.onStaged?.();
  };
  const actionTitle = (next: ReadinessAction) =>
    ({
      run: `Run ${verifyCommand() ?? 'the verify command'} in the task worktree. It keeps running if you close this dialog.`,
      rerun: `Run ${verifyCommand() ?? 'the verify command'} again`,
      cancel: 'Stop the run',
      stage: "Put the failure in the agent's prompt input for you to review and send",
      configure: 'Open the project settings at the verify command',
    })[next];

  return (
    <section aria-label="Readiness and checks" style={{ margin: '0 0 14px', 'font-size': '13px' }}>
      <div style={rowStyle}>
        {/* Only the outcome is announced, not ages and button labels as they tick. */}
        <span
          role="status"
          style={{
            flex: '1',
            color: line().tone === 'failed' ? theme.error : theme.fg,
            'white-space': 'nowrap',
          }}
        >
          {line().text}
        </span>
        <Show when={action()}>
          {(next) => (
            <button
              type="button"
              class="btn-with-icon"
              style={buttonStyle}
              title={actionTitle(next())}
              onClick={() => run(next())}
            >
              <Show when={next() === 'run' || next() === 'rerun'}>
                <PlayIcon size={12} />
              </Show>
              {ACTION_LABEL[next()]}
            </button>
          )}
        </Show>
        <Show when={props.hasDetails}>
          <button
            type="button"
            aria-expanded={open()}
            aria-controls={bodyId}
            style={toggleStyle}
            onClick={() => setOpen(!open())}
          >
            <span aria-hidden="true">{open() ? '▾' : '▸'}</span> Details
          </button>
        </Show>
      </div>
      {/* Kept in every state, even empty, so a result arriving never moves the dialog. */}
      <div style={{ ...detailStyle, 'min-height': '18px' }} title={detailTitle()}>
        <Show when={line().command}>{(command) => <code style={codeStyle}>{command()}</code>}</Show>
        {line().command && line().detail ? ' · ' : ''}
        {line().detail}
      </div>
      <Show when={otherFailures().length > 0}>
        <div style={rowStyle}>
          <span style={{ color: theme.error }}>
            {otherFailures()
              .map((check) => check.name)
              .join(', ')}{' '}
            failed
          </span>
          <span style={detailStyle}>in the review's check run</span>
          <button
            type="button"
            style={buttonStyle}
            title="Put the failures in the agent's prompt input for you to review and send"
            onClick={() => {
              if (stageCheckFailurePrompt(props.task.id)) props.onStaged?.();
            }}
          >
            Stage fix prompt
          </button>
        </div>
      </Show>
      <Show when={getCheckSuiteUiState(props.task.id).error}>
        {(error) => (
          <div role="alert" style={{ ...rowStyle, color: theme.error }}>
            {error()}
          </div>
        )}
      </Show>
      <Show when={props.hasDetails}>
        {/* Hidden rather than unmounted, so folding keeps the rows' local state. */}
        <div id={bodyId} hidden={!open()} style={{ 'margin-top': '8px' }}>
          {props.children}
        </div>
      </Show>
    </section>
  );
}
