import { For, Show } from 'solid-js';
import { errMessage } from '../lib/log';
import { bannerStyle, dialogButtonStyle, linkButtonStyle, theme } from '../lib/theme';
import { getPrChecks } from '../store/store';
import type { PrMergeMethod } from '../ipc/types';
import type { Task } from '../store/types';
import type { MergeReadinessCheck } from './merge-readiness';
import { MergeReadinessPanel } from './MergeReadinessPanel';
import { PR_METHOD_LABELS, taskPrUrl, type FinishPr } from './pr-actions';

interface FinishPrSectionProps {
  task: Task;
  pr: FinishPr;
  /** The readiness row summarising PR checks. */
  checkRows: MergeReadinessCheck[];
  /** A push or merge is running; PR actions would race it. */
  disabled: boolean;
  onOpenPullRequest: (url: string) => void;
  /** A Fix CI or review prompt now waits in the task input. */
  onStaged: () => void;
}

const mutedText = { color: theme.fgMuted, margin: '6px 0' };

/**
 * What GitHub says about the task's PR: status, CI, and agent hand-offs that
 * only show when there is something to fix. How to merge lives in PrMergeRoute.
 */
export function FinishPrSection(props: FinishPrSectionProps) {
  const checks = () => getPrChecks(props.task.id);
  const busyOrDisabled = () => props.disabled || !!props.pr.busy();
  const merged = () => props.pr.mode() === 'merged';
  const summary = () => {
    const c = checks();
    const parts = [
      c?.isDraft ? 'Draft' : '',
      c?.reviewDecision ? `Review: ${c.reviewDecision.toLowerCase().replace(/_/g, ' ')}` : '',
    ];
    return parts.filter(Boolean).join(' · ');
  };
  const ciFailed = () => (checks()?.failing ?? 0) > 0;
  const changesRequested = () => checks()?.reviewDecision === 'CHANGES_REQUESTED';
  const stage = async (kind: 'fix-ci' | 'review') => {
    if (await props.pr.stage(kind)) props.onStaged();
  };

  return (
    <section aria-label="GitHub PR and CI" style={{ margin: '28px 0', 'font-size': '13px' }}>
      <h3 style={{ margin: '0 0 8px', 'font-size': '13px', color: theme.fg }}>
        GitHub PR and CI
        <Show when={taskPrUrl(props.task)}>
          {(url) => (
            <>
              {' · '}
              <button
                type="button"
                style={linkButtonStyle}
                disabled={busyOrDisabled()}
                onClick={() => props.onOpenPullRequest(url())}
                title="View pull request details or open it on GitHub"
              >
                PR #{props.pr.number()} details…
              </button>
            </>
          )}
        </Show>
      </h3>
      <Show when={taskPrUrl(props.task)} fallback={<p>No pull request detected for this task.</p>}>
        <Show when={!merged()} fallback={<p style={mutedText}>Merged on GitHub.</p>}>
          <Show when={summary()}>
            <p style={mutedText}>{summary()}</p>
          </Show>
          <Show when={checks()?.mergeable === 'CONFLICTING'}>
            <p style={{ color: theme.warning, margin: '6px 0' }}>
              PR has conflicts with its base branch.
            </p>
          </Show>
          <MergeReadinessPanel checks={props.checkRows} />
          <Show when={checks()?.checks.length}>
            <ul
              aria-label="GitHub CI checks"
              style={{ 'max-height': '140px', 'overflow-y': 'auto', 'padding-left': '20px' }}
            >
              <For each={checks()?.checks}>
                {(check) => (
                  <li>
                    {check.name}: {check.bucket}
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={props.pr.headDiffers()}>
            <p style={{ color: theme.fgSubtle, margin: '6px 0' }}>
              CI reflects the PR on GitHub, not unpushed local commits.
            </p>
          </Show>
          <Show when={ciFailed() || changesRequested()}>
            <div style={{ display: 'flex', gap: '8px', 'margin-top': '8px' }}>
              <Show when={ciFailed()}>
                <button
                  type="button"
                  class="btn-secondary"
                  disabled={busyOrDisabled()}
                  aria-busy={props.pr.busy() === 'fix-ci'}
                  onClick={() => void stage('fix-ci')}
                  title="Collect failed checks and their log tails into a prompt for the agent"
                  style={dialogButtonStyle(false, busyOrDisabled())}
                >
                  {props.pr.busy() === 'fix-ci' ? 'Collecting…' : 'Fix CI'}
                </button>
              </Show>
              <Show when={changesRequested()}>
                <button
                  type="button"
                  class="btn-secondary"
                  disabled={busyOrDisabled()}
                  aria-busy={props.pr.busy() === 'review'}
                  onClick={() => void stage('review')}
                  title="Collect unresolved review comments into a prompt for the agent"
                  style={dialogButtonStyle(false, busyOrDisabled())}
                >
                  {props.pr.busy() === 'review' ? 'Collecting…' : 'Address review'}
                </button>
              </Show>
            </div>
          </Show>
          <Show when={props.pr.info()}>
            <p role="status" style={mutedText}>
              {props.pr.info()}
            </p>
          </Show>
        </Show>
      </Show>
    </section>
  );
}

const selectStyle = {
  padding: '6px 8px',
  background: theme.bgInput,
  border: `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-md)',
  color: theme.fg,
  'font-size': '13px',
};

/**
 * How a task with a PR merges: the GitHub merge method, or why and how it
 * merges locally instead. Renders nothing without a PR.
 */
export function PrMergeRoute(props: { pr: FinishPr; disabled: boolean }) {
  const disabled = () => props.disabled || !!props.pr.busy();
  const backToPr = () => (
    <button
      type="button"
      style={linkButtonStyle}
      disabled={disabled()}
      onClick={() => props.pr.setMergeLocally(false)}
    >
      Use PR #{props.pr.number()} instead
    </button>
  );
  const mergeLocally = () => (
    <button
      type="button"
      style={linkButtonStyle}
      disabled={disabled()}
      onClick={() => props.pr.setMergeLocally(true)}
      title="Merge the branch into its base on this machine, bypassing the pull request"
    >
      Merge locally instead
    </button>
  );

  return (
    <div style={{ 'font-size': '13px', 'margin-bottom': '10px' }}>
      <Show when={props.pr.mode() === 'pr'}>
        <Show when={props.pr.pr()}>
          {(details) => (
            <>
              <label
                style={{
                  display: 'flex',
                  gap: '8px',
                  'align-items': 'center',
                  color: theme.fgMuted,
                }}
              >
                Merge on GitHub by
                <select
                  value={props.pr.method()}
                  disabled={disabled()}
                  onChange={(e) => props.pr.setMethod(e.currentTarget.value as PrMergeMethod)}
                  style={selectStyle}
                >
                  <For each={details().mergeMethods}>
                    {(m) => <option value={m}>{PR_METHOD_LABELS[m]}</option>}
                  </For>
                </select>
              </label>
              {/* UNSTABLE: non-required checks fail; GitHub allows the merge. */}
              <Show when={details().mergeStateStatus === 'UNSTABLE'}>
                <p style={mutedText}>Some checks are failing; GitHub still allows the merge.</p>
              </Show>
            </>
          )}
        </Show>
        <p style={mutedText}>{mergeLocally()}</p>
      </Show>
      <Show when={props.pr.mode() === 'merged' && props.pr.headDiffers()}>
        <p style={mutedText}>
          This worktree has commits that are not in PR #{props.pr.number()}. {mergeLocally()}
        </p>
      </Show>
      <Show when={props.pr.mode() === 'local'}>
        <Show when={props.pr.localReason()}>{(reason) => <p style={mutedText}>{reason()}</p>}</Show>
        <Show when={!props.pr.localReason() && props.pr.mergeLocally()}>
          <p style={mutedText}>{backToPr()}</p>
        </Show>
        <Show when={!props.pr.mergeLocally() && props.pr.details.error}>
          {(err) => (
            <p role="status" style={mutedText}>
              Could not load the pull request ({errMessage(err())}), so this merges locally.{' '}
              <button
                type="button"
                style={linkButtonStyle}
                disabled={disabled() || props.pr.details.loading}
                onClick={() => void props.pr.refetch()}
              >
                Retry
              </button>
            </p>
          )}
        </Show>
      </Show>
      <Show when={props.pr.error()}>
        <div role="alert" style={{ ...bannerStyle(theme.error), 'margin-top': '8px' }}>
          {props.pr.error()}
        </div>
      </Show>
    </div>
  );
}
