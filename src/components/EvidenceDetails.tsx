import { For, Show, createSignal, type JSX } from 'solid-js';
import type { EvidenceReason } from '../../electron/shared/evidence-confidence';
import type { EvidenceFlag, EvidencePackage } from '../../electron/shared/evidence';
import { theme } from '../lib/theme';
import {
  acceptEvidenceFlag,
  dismissEvidenceFinding,
  restoreEvidenceFinding,
  reopenEvidenceFlag,
} from '../store/store';
import type { Task } from '../store/types';
import { EvidenceQuestionButton } from './EvidenceQuestionButton';

export const evidenceButtonStyle = {
  padding: '4px 10px',
  background: theme.bgInput,
  border: `1px solid ${theme.border}`,
  'border-radius': '6px',
  color: theme.fg,
  cursor: 'pointer',
  'font-size': '13px',
};
const smallButton = { ...evidenceButtonStyle, padding: '4px 8px', 'font-size': '12px' };
const sectionStyle = { 'margin-top': '8px', 'font-size': '13px' };
const listStyle = {
  margin: '8px 0 0',
  padding: '0 0 0 16px',
  display: 'grid',
  gap: '12px',
  'overflow-wrap': 'anywhere',
} as const;
const muted = { color: theme.fgMuted };

function location(file: string, line?: number): string {
  return line ? `${file}:${line}` : file;
}

function FlagItem(props: {
  taskId: string;
  flag: EvidenceFlag;
  accepted?: string;
  onReviewFile?: (file: string, line?: number, side?: 'old' | 'new') => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [reason, setReason] = createSignal('');
  const save = () => {
    acceptEvidenceFlag(props.taskId, props.flag.id, reason());
    setEditing(false);
  };
  return (
    <li>
      <Show
        when={props.onReviewFile}
        fallback={<code>{location(props.flag.file, props.flag.line)}</code>}
      >
        <button
          type="button"
          style={smallButton}
          onClick={() =>
            props.onReviewFile?.(
              props.flag.file,
              props.flag.line,
              props.flag.rule === 'test-removed' ? 'old' : 'new',
            )
          }
          title="Open file diff"
        >
          {location(props.flag.file, props.flag.line)}
        </button>
      </Show>{' '}
      {props.flag.detail} <span style={muted}>({props.flag.rule})</span>
      <Show
        when={props.accepted === undefined}
        fallback={
          <div style={muted}>
            Accepted: {props.accepted}{' '}
            <button
              type="button"
              style={smallButton}
              onClick={() => reopenEvidenceFlag(props.taskId, props.flag.id)}
            >
              Undo acceptance
            </button>
          </div>
        }
      >
        <Show
          when={editing()}
          fallback={
            <Show when={props.flag.category !== 'info'}>
              {' '}
              <button type="button" style={smallButton} onClick={() => setEditing(true)}>
                Accept…
              </button>
            </Show>
          }
        >
          <form
            style={{ display: 'flex', gap: '4px', 'margin-top': '4px' }}
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <input
              aria-label="Why this change is fine"
              placeholder="Why this change is fine"
              value={reason()}
              onInput={(event) => setReason(event.currentTarget.value)}
              style={{ flex: '1', 'font-size': '13px' }}
            />
            <button type="submit" style={smallButton} disabled={!reason().trim()}>
              Accept
            </button>
            <button type="button" style={smallButton} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        </Show>
      </Show>
    </li>
  );
}

interface EvidenceDetailsProps {
  task: Task;
  pkg: EvidencePackage;
  reasons: EvidenceReason[];
  agentId?: string;
  checks?: JSX.Element;
  passedChecks?: JSX.Element;
  hasCheckAttention?: boolean;
  onReviewFile?: (file: string, line?: number, side?: 'old' | 'new') => void;
}

/** The facts behind the headline, collapsed so the headline stays scannable. */
export function EvidenceDetails(props: EvidenceDetailsProps) {
  const flags = () => props.pkg.scan.flags;
  const openFlags = () =>
    flags().filter((flag) => flag.category !== 'info' && !(flag.id in props.pkg.acceptedFlags));
  const review = () => props.pkg.review;
  const openFindings = () =>
    (review()?.findings ?? []).filter((f) => !props.pkg.dismissedFindings.includes(f.id));
  const resolvedFlags = () => flags().filter((flag) => flag.id in props.pkg.acceptedFlags);
  const dismissed = () =>
    (review()?.findings ?? []).filter((f) => props.pkg.dismissedFindings.includes(f.id));
  const hasAttention = () =>
    props.hasCheckAttention ||
    openFlags().length ||
    openFindings().length ||
    props.pkg.claim?.notVerified?.length ||
    props.pkg.scan.sourceWithoutTests.length;
  const fileLink = (file: string, line?: number) => (
    <Show when={props.onReviewFile} fallback={<code>{location(file, line)}</code>}>
      <button
        type="button"
        style={{ ...smallButton, 'overflow-wrap': 'anywhere', 'text-align': 'left' }}
        onClick={() => props.onReviewFile?.(file, line)}
      >
        {location(file, line)}
      </button>
    </Show>
  );
  return (
    <>
      <Show when={hasAttention()}>
        <section aria-label="Needs attention" style={{ ...sectionStyle, 'margin-top': '16px' }}>
          <strong>Needs attention</strong>
          {props.checks}
          <Show when={openFlags().length > 0}>
            <div style={sectionStyle}>App scan · changes to review</div>
            <ul style={listStyle}>
              <For each={openFlags()}>
                {(flag) => (
                  <FlagItem taskId={props.task.id} flag={flag} onReviewFile={props.onReviewFile} />
                )}
              </For>
            </ul>
          </Show>
          <Show when={openFindings().length > 0}>
            <div style={sectionStyle}>AI review · findings</div>
            <ul style={listStyle}>
              <For each={openFindings()}>
                {(finding) => (
                  <li>
                    <strong>{finding.severity}</strong> {fileLink(finding.file, finding.line)}{' '}
                    {finding.text}
                    <div style={{ 'margin-top': '6px' }}>
                      <button
                        type="button"
                        style={smallButton}
                        onClick={() => dismissEvidenceFinding(props.task.id, finding.id)}
                      >
                        Dismiss
                      </button>{' '}
                      <EvidenceQuestionButton
                        buttonStyle={smallButton}
                        taskId={props.task.id}
                        pkg={props.pkg}
                        agentId={props.agentId}
                        question={{ kind: 'finding', id: finding.id }}
                      />
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={props.pkg.claim?.notVerified?.length}>
            <div style={sectionStyle}>Agent report · not verified</div>
            <ul style={listStyle}>
              <For each={props.pkg.claim?.notVerified}>
                {(gap, index) => (
                  <li>
                    {gap}
                    <div style={{ 'margin-top': '6px' }}>
                      <EvidenceQuestionButton
                        buttonStyle={smallButton}
                        taskId={props.task.id}
                        pkg={props.pkg}
                        agentId={props.agentId}
                        question={{ kind: 'gap', index: index() }}
                      />
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={props.pkg.scan.sourceWithoutTests.length > 0}>
            <details style={sectionStyle}>
              <summary>
                App scan · No related tests found: {props.pkg.scan.sourceWithoutTests.length}{' '}
                {props.pkg.scan.sourceWithoutTests.length === 1 ? 'file' : 'files'}
              </summary>
              <ul style={listStyle}>
                <For each={props.pkg.scan.sourceWithoutTests}>
                  {(file) => <li>{fileLink(file)}</li>}
                </For>
              </ul>
            </details>
          </Show>
        </section>
      </Show>
      <div
        style={{
          ...sectionStyle,
          'margin-top': '16px',
          'border-top': `1px solid ${theme.border}`,
          'padding-top': '12px',
        }}
      >
        <strong>Supporting evidence</strong>
      </div>
      {props.passedChecks}
      <Show when={props.reasons.length > 1}>
        <details style={sectionStyle}>
          <summary>Confidence details ({props.reasons.length})</summary>
          <ul style={listStyle}>
            <For each={props.reasons}>{(reason) => <li>{reason.text}</li>}</For>
          </ul>
        </details>
      </Show>
      <Show when={resolvedFlags().length + dismissed().length > 0}>
        <details style={sectionStyle}>
          <summary>Resolved items ({resolvedFlags().length + dismissed().length})</summary>
          <ul style={listStyle}>
            <For each={resolvedFlags()}>
              {(flag) => (
                <FlagItem
                  taskId={props.task.id}
                  flag={flag}
                  accepted={props.pkg.acceptedFlags[flag.id]}
                  onReviewFile={props.onReviewFile}
                />
              )}
            </For>
            <For each={dismissed()}>
              {(finding) => (
                <li>
                  AI review · {fileLink(finding.file, finding.line)} {finding.text}{' '}
                  <button
                    type="button"
                    style={smallButton}
                    onClick={() => restoreEvidenceFinding(props.task.id, finding.id)}
                  >
                    Undo dismissal
                  </button>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
      <Show
        when={flags().some(
          (flag) => flag.category === 'info' && !(flag.id in props.pkg.acceptedFlags),
        )}
      >
        <details style={sectionStyle}>
          <summary>App scan · informational notes</summary>
          <ul style={listStyle}>
            <For
              each={flags().filter(
                (flag) => flag.category === 'info' && !(flag.id in props.pkg.acceptedFlags),
              )}
            >
              {(flag) => (
                <FlagItem taskId={props.task.id} flag={flag} onReviewFile={props.onReviewFile} />
              )}
            </For>
          </ul>
        </details>
      </Show>
      <Show when={props.pkg.scan.tests.length > 0 || props.pkg.scan.coveringTests.length > 0}>
        <details style={sectionStyle}>
          <summary>Tests ({props.pkg.scan.tests.length} changed)</summary>
          <ul style={listStyle}>
            <For each={props.pkg.scan.tests}>
              {(test) => (
                <li>
                  <span style={muted}>
                    {test.change} {test.kind}
                  </span>{' '}
                  {test.title} <code style={muted}>{test.file}</code>
                </li>
              )}
            </For>
          </ul>
          <Show when={props.pkg.scan.coveringTests.length > 0}>
            <div style={{ ...muted, 'margin-top': '4px' }}>
              Unchanged tests that import changed code:
              <ul style={listStyle}>
                <For each={props.pkg.scan.coveringTests}>
                  {(file) => (
                    <li>
                      <code>{file}</code>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
        </details>
      </Show>
      <Show when={review()}>
        {(current) => (
          <details style={sectionStyle}>
            <summary>
              AI review (
              {current().status === 'done' ? `${openFindings().length} findings` : current().status}
              )
            </summary>
            <Show when={current().error}>
              <div style={{ color: theme.error }}>{current().error}</div>
            </Show>
            <Show when={current().testSummary}>
              <p style={{ margin: '4px 0' }}>{current().testSummary}</p>
            </Show>
          </details>
        )}
      </Show>
      <Show when={props.pkg.claim}>
        {(claim) => (
          <details style={sectionStyle}>
            <summary>Agent report</summary>
            <Show when={claim().summary}>
              <p style={{ margin: '4px 0', 'white-space': 'pre-wrap' }}>{claim().summary}</p>
            </Show>
            <Show when={claim().risks?.length}>
              <div style={muted}>Risks:</div>
              <ul style={listStyle}>
                <For each={claim().risks}>{(risk) => <li>{risk}</li>}</For>
              </ul>
            </Show>
          </details>
        )}
      </Show>
    </>
  );
}
