import { Show, createSignal, type JSX } from 'solid-js';
import type { EvidencePackage } from '../../electron/shared/evidence';
import { compileEvidenceQuestion, type EvidenceQuestion } from '../lib/evidence-plan';
import { sendEvidenceToAgent, store } from '../store/store';
import { theme } from '../lib/theme';
import { CommentIcon, SendIcon } from './icons';

/** Preview the exact item being sent; delivery never resolves the finding. */
export function EvidenceQuestionButton(props: {
  taskId: string;
  pkg: EvidencePackage;
  agentId?: string;
  question: EvidenceQuestion;
  buttonStyle: JSX.CSSProperties;
}) {
  const [preview, setPreview] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal('');
  const sent = () => props.pkg.sentToAgent?.includes(JSON.stringify(props.question));
  const available = () => props.agentId && store.agents[props.agentId]?.status === 'running';
  const send = async () => {
    const agentId = props.agentId;
    if (!agentId || sending()) return;
    setSending(true);
    setError('');
    try {
      if (await sendEvidenceToAgent(props.taskId, agentId, props.question, props.pkg.id))
        setPreview(false);
      else setError('This item changed. Review the latest evidence and try again.');
    } catch {
      setError('Could not send to the agent. Please try again.');
    } finally {
      setSending(false);
    }
  };
  return (
    <Show
      when={sent()}
      fallback={
        <Show when={available()}>
          <button
            type="button"
            class="btn-secondary btn-with-icon"
            style={props.buttonStyle}
            onClick={() => setPreview(!preview())}
            aria-expanded={preview()}
          >
            <CommentIcon size={12} />
            Ask agent about this
          </button>
          <Show when={preview()}>
            <div style={{ 'margin-top': '8px' }}>
              <pre
                style={{
                  'white-space': 'pre-wrap',
                  'overflow-wrap': 'anywhere',
                  'font-size': '12px',
                  'max-height': '180px',
                  overflow: 'auto',
                }}
              >
                {compileEvidenceQuestion(props.pkg, props.question)}
              </pre>
              <button
                type="button"
                class="btn-secondary btn-with-icon"
                style={props.buttonStyle}
                disabled={sending()}
                onClick={() => void send()}
              >
                <SendIcon size={12} />
                {sending() ? 'Sending…' : 'Send to agent'}
              </button>{' '}
              <button
                type="button"
                class="btn-secondary"
                style={props.buttonStyle}
                onClick={() => setPreview(false)}
              >
                Cancel
              </button>
              <Show when={error()}>
                <div role="alert" style={{ color: theme.error }}>
                  {error()}
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      }
    >
      <span role="status" style={{ color: theme.fgMuted }}>
        Sent to agent · awaiting fresh evidence
      </span>
    </Show>
  );
}
