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
import { CheckIcon, CloseIcon, UndoIcon } from './icons';

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
const fileLinkStyle = {
  background: 'none',
  border: 'none',
  padding: '0',
  color: theme.fgMuted,
  cursor: 'pointer',
  'font-size': '12px',
  'text-decoration': 'underline',
  'overflow-wrap': 'anywhere',
  'text-align': 'left',
} as const;

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
      <div>{props.flag.detail}</div>
      <div style={{ ...muted, 'margin-top': '4px' }}>
        <Show
          when={props.onReviewFile}
          fallback={<code>{location(props.flag.file, props.flag.line)}</code>}
        >
          <button
            type="button"
            style={fileLinkStyle}
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
        </Show>
      </div>
      <div style={{ 'margin-top': '6px' }}>
        <Show
          when={props.accepted === undefined}
          fallback={
            <div style={muted}>
              Accepted: {props.accepted}{' '}
              <button
                class="btn-with-icon"
                type="button"
                style={smallButton}
                onClick={() => reopenEvidenceFlag(props.taskId, props.flag.id)}
              >
                <UndoIcon size={12} />
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
                <button
                  class="btn-with-icon"
                  type="button"
                  style={smallButton}
                  onClick={() => setEditing(true)}
                >
                  <CheckIcon size={12} />
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
              <button
                class="btn-with-icon"
                type="submit"
                style={smallButton}
                disabled={!reason().trim()}
              >
                <CheckIcon size={12} />
                Accept
              </button>
              <button type="button" style={smallButton} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </form>
          </Show>
        </Show>
      </div>
    </li>
  );
}

interface EvidenceDetailsProps {
  task: Task;
  pkg: EvidencePackage;
  reasons: EvidenceReason[];
  confidenceLabel?: string;
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
    openFlags().length ||
    openFindings().length ||
    props.pkg.claim?.notVerified?.length ||
    props.pkg.scan.sourceWithoutTests.length;
  const fileLink = (file: string, line?: number) => (
    <Show when={props.onReviewFile} fallback={<code>{location(file, line)}</code>}>
      <button type="button" style={fileLinkStyle} onClick={() => props.onReviewFile?.(file, line)}>
        {location(file, line)}
      </button>
    </Show>
  );
  return (
    <>
      <Show when={props.hasCheckAttention}>
        <section
          aria-label="Checks needing attention"
          style={{ ...sectionStyle, 'margin-top': '16px' }}
        >
          <strong>Checks needing attention</strong>
          {props.checks}
        </section>
      </Show>
      <Show when={hasAttention()}>
        <section aria-label="Advisory findings" style={{ ...sectionStyle, 'margin-top': '16px' }}>
          <strong>Advisory findings</strong>
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
                    <div>
                      <strong>{finding.severity}</strong> · {finding.text}
                    </div>
                    <div style={{ 'margin-top': '4px' }}>
                      {fileLink(finding.file, finding.line)}
                    </div>
                    <div style={{ 'margin-top': '6px' }}>
                      <button
                        class="btn-with-icon"
                        type="button"
                        style={smallButton}
                        onClick={() => dismissEvidenceFinding(props.task.id, finding.id)}
                      >
                        <CloseIcon size={12} />
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
      <details
        style={{
          ...sectionStyle,
          margin: '24px 0 8px',
          'border-top': `1px solid ${theme.border}`,
          'padding-top': '8px',
        }}
      >
        <summary style={{ cursor: 'pointer', padding: '8px 0' }}>View evidence</summary>
        <div style={{ ...muted, 'margin-top': '8px' }}>
          Commit {props.pkg.scan.headSha.slice(0, 8)} · {props.pkg.scan.tests.length} test changes ·{' '}
          {props.pkg.scan.files.length} files
        </div>
        <Show when={props.confidenceLabel}>
          <div style={{ ...muted, 'margin-top': '6px' }}>{props.confidenceLabel}</div>
        </Show>
        {props.passedChecks}
        <Show when={props.reasons.length > 0}>
          <ul style={listStyle}>
            <For each={props.reasons}>{(reason) => <li>{reason.text}</li>}</For>
          </ul>
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
                      class="btn-with-icon"
                      type="button"
                      style={smallButton}
                      onClick={() => restoreEvidenceFinding(props.task.id, finding.id)}
                    >
                      <UndoIcon size={12} />
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
                {current().status === 'done'
                  ? `${openFindings().length} findings`
                  : current().status}
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
      </details>
    </>
  );
}
