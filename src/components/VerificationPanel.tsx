import { Show, createEffect, createMemo } from 'solid-js';
import {
  cancelTaskVerification,
  getVerificationOutput,
  getVerifyCommand,
  runTaskVerification,
  sendVerificationFailureToAgent,
  store,
} from '../store/store';
import { summarizeVerificationRun, type VerificationSummaryKind } from '../lib/verification-run';
import { theme } from '../lib/theme';
import type { Task } from '../store/types';

interface VerificationPanelProps {
  task: Task;
  agentId?: string;
  /** Current worktree HEAD, used to flag runs that predate the latest commit. */
  headSha?: string | null;
  onSentToAgent?: () => void;
}

const KIND_COLOR: Record<VerificationSummaryKind, string> = {
  none: theme.warning,
  running: theme.fgMuted,
  passed: theme.success,
  stale: theme.warning,
  dirty: theme.warning,
  failed: theme.error,
  unavailable: theme.fgMuted,
};

const buttonStyle = {
  padding: '4px 10px',
  background: theme.bgInput,
  border: `1px solid ${theme.border}`,
  'border-radius': '6px',
  color: theme.fg,
  cursor: 'pointer',
  'font-size': '12px',
};

export function VerificationPanel(props: VerificationPanelProps) {
  let outputRef: HTMLPreElement | undefined;
  const command = () => getVerifyCommand(props.task.id);
  const run = () => props.task.verificationRun;
  const summary = createMemo(() => summarizeVerificationRun(run(), props.headSha));
  const running = () => run()?.status === 'running';
  const output = () => getVerificationOutput(props.task.id);
  const agentCanReceive = () =>
    Boolean(props.agentId) && store.agents[props.agentId ?? '']?.status === 'running';
  const canSend = () => {
    const status = run()?.status;
    return agentCanReceive() && status !== undefined && status !== 'running' && status !== 'passed';
  };

  // Keep the newest output in view while a run streams.
  createEffect(() => {
    output();
    if (outputRef && running()) outputRef.scrollTop = outputRef.scrollHeight;
  });

  // Close first like the rebase button does; the prompt lands in the terminal.
  const sendToAgent = () => {
    const agentId = props.agentId;
    if (!agentId) return;
    props.onSentToAgent?.();
    sendVerificationFailureToAgent(props.task.id, agentId).catch((err: unknown) => {
      console.error('Failed to send verification failure to agent:', err);
    });
  };

  return (
    <section
      aria-label="Verification"
      style={{
        'margin-bottom': '12px',
        padding: '10px 12px',
        border: `1px solid ${theme.border}`,
        'border-radius': '8px',
      }}
    >
      <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'font-size': '12px' }}>
        <strong style={{ color: KIND_COLOR[summary().kind], 'font-size': '13px' }}>
          {summary().label}
        </strong>
        <span style={{ color: theme.fgMuted, flex: '1', 'min-width': '0' }}>
          <Show when={command()} fallback="No verify command configured for this project.">
            {(cmd) => <code title={summary().detail}>{cmd()}</code>}
          </Show>
        </span>
        <Show when={command()}>
          <Show
            when={!running()}
            fallback={
              <button
                type="button"
                style={buttonStyle}
                onClick={() => void cancelTaskVerification(props.task.id)}
              >
                Cancel
              </button>
            }
          >
            <button
              type="button"
              style={buttonStyle}
              onClick={() => void runTaskVerification(props.task.id)}
              title="Run the verify command in this task's worktree"
            >
              {run() ? 'Re-run' : 'Run'}
            </button>
          </Show>
        </Show>
        <Show when={canSend()}>
          <button
            type="button"
            style={{ ...buttonStyle, background: theme.accent, color: theme.accentText }}
            onClick={sendToAgent}
            title="Close the dialog and ask the agent to fix the failure"
          >
            Send to agent
          </button>
        </Show>
      </div>
      <Show when={!command() && !run()}>
        <div style={{ 'font-size': '12px', color: theme.fgSubtle, 'margin-top': '6px' }}>
          Set one in the project settings so the app can run your tests here before merging.
        </div>
      </Show>
      <Show when={output()}>
        <pre
          ref={outputRef}
          style={{
            margin: '8px 0 0',
            padding: '8px',
            'max-height': '160px',
            overflow: 'auto',
            'font-size': '11px',
            'line-height': '1.4',
            'white-space': 'pre-wrap',
            'word-break': 'break-word',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            'border-radius': '6px',
            color: theme.fg,
          }}
        >
          {output()}
        </pre>
      </Show>
    </section>
  );
}
