import { For, Show, createSignal, createUniqueId, onCleanup, onMount, type JSX } from 'solid-js';
import { VERIFY_CHECK_ID } from '../../electron/shared/evidence';
import { openEvidenceFlags } from '../lib/evidence-display';
import { readinessLine, type ReadinessAction } from '../lib/readiness-line';
import { theme } from '../lib/theme';
import {
  backgroundVerifyEnabled,
  cancelTaskVerification,
  getBackgroundVerifyHold,
  getEvidenceUiState,
  getTaskChecks,
  isEvidenceBusy,
  runTaskVerification,
  stageVerificationFailurePrompt,
} from '../store/store';
import type { Task } from '../store/types';
import { evidenceButtonStyle } from './EvidenceDetails';
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
  onReviewFile?: (file: string, line?: number, side?: 'old' | 'new') => void;
  /** The evidence panel: every check, flag and review, behind Details. */
  children: JSX.Element;
}

const FAILED = new Set(['failed', 'timed_out', 'error']);
// Ages read "4m ago"; a refresh this often keeps them honest without churn.
const NOW_REFRESH_MS = 30_000;

const toggleStyle = {
  background: 'none',
  border: 'none',
  padding: '4px 0',
  color: theme.fgMuted,
  cursor: 'pointer',
  'font-size': '13px',
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
 * after agent turns, so usually the result is already here. Everything else
 * the evidence panel holds sits behind Details.
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
  // A build restarts verify itself, so a click would only cancel its run.
  const evidenceBusy = () => {
    const pkg = props.task.evidence;
    return (
      Boolean(getEvidenceUiState(props.task.id).scanning) || Boolean(pkg && isEvidenceBusy(pkg))
    );
  };
  const action = () => {
    const next = line().action;
    if (next === 'configure' && !props.onConfigure) return undefined;
    if ((next === 'run' || next === 'rerun') && evidenceBusy()) return undefined;
    return next;
  };
  const otherFailures = () =>
    (props.task.evidence?.checks ?? []).filter(
      (check) => check.checkId !== VERIFY_CHECK_ID && FAILED.has(check.status),
    );
  const weakened = () =>
    props.task.evidence
      ? openEvidenceFlags(props.task.evidence).filter((flag) => flag.category === 'test-weakened')
      : [];
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
    <section aria-label="Readiness and checks" style={{ margin: '20px 0', 'font-size': '13px' }}>
      <div style={rowStyle} role="status">
        <span
          style={{
            color: line().tone === 'failed' ? theme.error : theme.fg,
            'white-space': 'nowrap',
          }}
        >
          {line().text}
        </span>
        <span style={detailStyle} title={line().detail}>
          {line().detail}
        </span>
        <Show when={action()}>
          {(next) => (
            <button
              type="button"
              class="btn-with-icon"
              style={evidenceButtonStyle}
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
      </div>
      <Show when={otherFailures().length > 0}>
        <div style={rowStyle}>
          <span style={{ color: theme.error }}>
            {otherFailures()
              .map((check) => check.name)
              .join(', ')}{' '}
            failed
          </span>
          <span style={detailStyle}>in the latest evidence build</span>
          <button type="button" style={evidenceButtonStyle} onClick={() => setOpen(true)}>
            Show
          </button>
        </div>
      </Show>
      <For each={weakened().slice(0, 1)}>
        {(flag) => (
          <div style={rowStyle}>
            <span style={{ color: theme.warning, 'white-space': 'nowrap' }}>
              {weakened().length === 1
                ? 'A test was weakened'
                : `${weakened().length} tests were weakened`}
            </span>
            <span style={detailStyle} title={`${flag.file}: ${flag.detail}`}>
              {flag.file}: {flag.detail}
            </span>
            <Show when={props.onReviewFile}>
              <button
                type="button"
                style={evidenceButtonStyle}
                onClick={() =>
                  props.onReviewFile?.(
                    flag.file,
                    flag.line,
                    flag.rule === 'test-removed' ? 'old' : 'new',
                  )
                }
              >
                Review
              </button>
            </Show>
          </div>
        )}
      </For>
      <button
        type="button"
        aria-expanded={open()}
        aria-controls={bodyId}
        style={toggleStyle}
        onClick={() => setOpen(!open())}
      >
        <span aria-hidden="true">{open() ? '▾' : '▸'}</span> Details
      </button>
      {/* Hidden rather than unmounted, so folding keeps the panel's local state. */}
      <div id={bodyId} hidden={!open()} style={{ 'margin-top': '8px' }}>
        {props.children}
      </div>
    </section>
  );
}
