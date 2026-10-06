import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import { DEFAULT_EVIDENCE_MODEL } from '../../electron/shared/evidence-settings';
import { EVIDENCE_LEVEL, evidenceHeadline, evidenceCheckOutcomes } from '../lib/evidence-display';
import { compileEvidencePrompt } from '../lib/evidence-plan';
import { theme } from '../lib/theme';
import {
  buildEvidence,
  getEvidenceUiState,
  getProject,
  getEvidenceConfidence,
  getTaskChecks,
  isEvidenceBusy,
  runEvidenceReview,
  sendEvidenceToAgent,
  sendVerificationFailureToAgent,
  stopEvidence,
  store,
} from '../store/store';
import type { Task } from '../store/types';
import { EvidenceCheckList, evidenceCheckNeedsAttention } from './EvidenceCheckList';
import { EvidenceDetails, evidenceButtonStyle as buttonStyle } from './EvidenceDetails';
import { EvidenceRunsHelp } from './EvidenceRunsHelp';
import { HelpPopover } from './HelpPopover';

interface EvidencePanelProps {
  task: Task;
  agentId?: string;
  /** Current worktree HEAD; a package built on another commit is outdated. */
  headSha?: string | null;
  dirty?: boolean;
  onSentToAgent?: () => void;
  /** Opens the project settings; offered while no check is configured. */
  onConfigure?: () => void;
  onReviewFile?: (file: string, line?: number, side?: 'old' | 'new') => void;
  /** Shown under the actions, e.g. readiness signals the checks do not cover. */
  children?: JSX.Element;
}

const mutedLine = { 'font-size': '13px', color: theme.fgMuted, 'margin-top': '6px' };

export function EvidencePanel(props: EvidencePanelProps) {
  const [sendError, setSendError] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const pkg = () => props.task.evidence;
  const ui = () => getEvidenceUiState(props.task.id);
  const confidence = createMemo(() =>
    getEvidenceConfidence(props.task, {
      head_sha: props.headSha,
      has_uncommitted_changes: props.dirty,
    }),
  );
  const busy = () => {
    const current = pkg();
    return Boolean(ui().scanning) || Boolean(current && isEvidenceBusy(current));
  };
  const level = () => {
    const current = confidence();
    return current
      ? EVIDENCE_LEVEL[current.level]
      : { label: 'No evidence yet', color: theme.fgMuted };
  };
  const headline = () => {
    const current = confidence();
    return current ? evidenceHeadline(current, pkg()) : 'No evidence yet';
  };
  const modelSettings = () =>
    getProject(props.task.projectId)?.evidenceModel ?? DEFAULT_EVIDENCE_MODEL;
  const canRunModel = () =>
    modelSettings().when !== 'off' &&
    Boolean(pkg()) &&
    !busy() &&
    pkg()?.review?.status !== 'running';
  const evidencePrompt = () => {
    const current = pkg();
    return current ? compileEvidencePrompt(current) : undefined;
  };
  // Without a package, a failed verify run is still worth handing back.
  const verifyFailed = () => {
    const status = props.task.verificationRun?.status;
    return status !== undefined && status !== 'running' && status !== 'passed';
  };
  const canSend = () =>
    Boolean(props.agentId) &&
    store.agents[props.agentId ?? '']?.status === 'running' &&
    Boolean(evidencePrompt() || verifyFailed());
  const outdated = () => confidence()?.level === 'not-checked';
  const sent = () => pkg()?.sentToAgent?.includes('fix');
  const checkCounts = () => {
    const current = pkg();
    return current
      ? `${outdated() ? 'Previous results: ' : ''}${evidenceCheckOutcomes(current)}`
      : '';
  };
  const activeChecks = () =>
    pkg()
      ?.checks.filter((check) => check.status === 'running')
      .map((check) => check.name)
      .join(', ');

  const firstFlag = () =>
    pkg()?.scan.flags.find(
      (flag) => flag.category !== 'info' && !(flag.id in (pkg()?.acceptedFlags ?? {})),
    );
  const reviewFile = () => firstFlag()?.file ?? pkg()?.scan.files[0]?.path;
  const primary = () => {
    if (busy()) return 'stop';
    if (props.onConfigure && getTaskChecks(props.task.id).length === 0) return 'configure';
    if (confidence()?.level === 'not-checked') return 'build';
    if (canSend() && !sent()) return 'send';
    if (props.onReviewFile && reviewFile()) return 'review';
    return 'build';
  };
  const actionStyle = (action: string) =>
    primary() === action && action !== 'stop'
      ? { ...buttonStyle, background: theme.accent, color: theme.accentText }
      : buttonStyle;
  const sendToAgent = async () => {
    const agentId = props.agentId;
    if (!agentId || sending()) return;
    setSending(true);
    setSendError('');
    try {
      const send = evidencePrompt() ? sendEvidenceToAgent : sendVerificationFailureToAgent;
      if (await send(props.task.id, agentId)) props.onSentToAgent?.();
      else setSendError('Nothing was sent. Refresh the results and try again.');
    } catch {
      setSendError('Could not send to the agent. Please try again.');
    } finally {
      setSending(false);
    }
  };

  const actions = () => [
    ...(busy() ? ['stop'] : ['build']),
    ...(props.onConfigure && getTaskChecks(props.task.id).length === 0 ? ['configure'] : []),
    ...(canRunModel() ? ['model'] : []),
    ...(canSend() && !sent() ? ['send'] : []),
    ...(props.onReviewFile && reviewFile() ? ['review'] : []),
  ];
  const actionButton = (action: string) => {
    const label = () =>
      ({
        stop: 'Stop',
        build: pkg() ? 'Refresh evidence' : 'Build evidence',
        configure: 'Configure checks',
        model: pkg()?.review ? 'Re-run AI review' : 'Run AI review',
        send: sending() ? 'Sending…' : 'Ask agent to fix',
        review: firstFlag() ? 'Review change' : 'Review diff',
      })[action];
    const click = () => {
      if (action === 'stop') void stopEvidence(props.task.id);
      if (action === 'build') void buildEvidence(props.task.id, { trigger: 'manual' });
      if (action === 'configure') props.onConfigure?.();
      if (action === 'model') void runEvidenceReview(props.task.id);
      if (action === 'send') void sendToAgent();
      if (action === 'review') {
        const file = reviewFile();
        if (file)
          props.onReviewFile?.(
            file,
            firstFlag()?.line,
            firstFlag()?.rule === 'test-removed' ? 'old' : 'new',
          );
      }
    };
    const button = (
      <button
        type="button"
        style={actionStyle(action)}
        disabled={action === 'send' && sending()}
        onClick={click}
      >
        {label()}
      </button>
    );
    return action === 'build' ? (
      <HelpPopover content={<EvidenceRunsHelp task={props.task} />}>{button}</HelpPopover>
    ) : (
      button
    );
  };
  const checks = (filter?: 'attention' | 'passed') => (
    <EvidenceCheckList
      task={props.task}
      filter={filter}
      pkg={pkg()}
      headSha={props.headSha}
      busy={Boolean(ui().scanning || pkg()?.assembling)}
      outputs={ui().outputs}
    />
  );

  return (
    <section aria-label="Evidence">
      {/* Text and actions on separate rows: sharing one, the buttons squeezed
          the counts into a sliver that wrapped word by word. */}
      <div
        style={{
          display: 'flex',
          'align-items': 'baseline',
          'flex-wrap': 'wrap',
          gap: '8px',
          'font-size': '13px',
        }}
      >
        <strong style={{ color: level().color, 'font-size': '15px' }}>{headline()}</strong>
        <span style={{ color: theme.fgMuted }}>{pkg() ? checkCounts() : ''}</span>
      </div>
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          'flex-wrap': 'wrap',
          'margin-top': '10px',
        }}
      >
        <For each={actions().filter((action) => action === primary())}>{actionButton}</For>
        <Show when={actions().some((action) => action !== primary())}>
          <details>
            <summary style={{ cursor: 'pointer', 'font-size': '13px' }}>More actions</summary>
            <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap', padding: '8px 0' }}>
              <For each={actions().filter((action) => action !== primary())}>{actionButton}</For>
            </div>
          </details>
        </Show>
      </div>
      <div style={{ 'margin-top': '10px' }}>{props.children}</div>
      <Show when={sent()}>
        <div role="status" style={mutedLine}>
          Sent to agent · awaiting fresh evidence. These issues remain open.
        </div>
      </Show>
      <Show when={sendError()}>
        <div role="alert" style={{ ...mutedLine, color: theme.error }}>
          {sendError()}
        </div>
      </Show>
      <Show when={confidence()}>
        {(current) => (
          <div style={mutedLine}>
            {/* The headline already says "Checks outdated"; only a confidence level adds to it. */}
            {level().label === headline() ? '' : `${level().label} · `}
            {current().reasons[0]?.text ?? 'App checks passed; this does not prove correctness.'}
          </div>
        )}
      </Show>
      <Show when={outdated() && (props.dirty || pkg()?.scan.dirty)}>
        <div style={mutedLine}>Commit the uncommitted changes, then refresh evidence.</div>
      </Show>
      <Show when={activeChecks()}>
        <div role="status" style={mutedLine}>
          Running {activeChecks()}…
        </div>
      </Show>
      <Show when={ui().scanning}>
        <div style={mutedLine}>Scanning the change…</div>
      </Show>
      <Show when={ui().error}>
        <div style={{ ...mutedLine, color: theme.error }}>{ui().error}</div>
      </Show>
      <Show
        when={pkg()}
        fallback={
          <div style={mutedLine}>
            Evidence gathers check results, test changes and the agent's handoff for one commit.
            Build it here to see what passed and what still needs review.
          </div>
        }
      >
        {(current) => (
          <>
            <div style={mutedLine}>
              Commit {current().scan.headSha.slice(0, 8)} · {current().scan.tests.length} test
              changes · {current().scan.files.length} files
            </div>
            <EvidenceDetails
              task={props.task}
              agentId={props.agentId}
              checks={checks('attention')}
              passedChecks={checks('passed')}
              hasCheckAttention={getTaskChecks(props.task.id).some((check) =>
                evidenceCheckNeedsAttention(check, props.task, current()),
              )}
              pkg={current()}
              reasons={confidence()?.reasons ?? []}
              onReviewFile={props.onReviewFile}
            />
          </>
        )}
      </Show>
      <Show when={!pkg()}>{checks()}</Show>
    </section>
  );
}
