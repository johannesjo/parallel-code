import { For, Show, type JSX } from 'solid-js';
import { errMessage } from '../lib/log';
import { countLabel } from '../lib/plural';
import { bannerStyle, dialogButtonStyle, linkButtonStyle, theme } from '../lib/theme';
import { getPrChecks, type PrChecksState } from '../store/store';
import type { PrMergeMethod } from '../ipc/types';
import type { Task } from '../store/types';
import { CommentIcon, ToolsIcon } from './icons';
import { PR_METHOD_LABELS, prIsBlocked, taskPrUrl, type FinishPr } from './pr-actions';

interface FinishPrSectionProps {
  task: Task;
  pr: FinishPr;
  /** A push or merge is running; PR actions would race it. */
  disabled: boolean;
  onOpenPullRequest: (url: string) => void;
  /** A Fix CI or review prompt now waits in the task input. */
  onStaged: () => void;
  /** How it merges, closing the section. */
  children?: JSX.Element;
}

const mutedText = { color: theme.fgMuted, margin: '6px 0' };

/** One line for all checks; the list behind it opens itself when one fails. */
function checksSummary(c: PrChecksState): { text: string; color: string } {
  const of = `of ${countLabel(c.checks.length, 'check')}`;
  if (c.failing > 0) return { text: `✗ ${c.failing} ${of} failed`, color: theme.error };
  if (c.pending > 0) return { text: `${c.pending} ${of} running`, color: theme.fgMuted };
  return { text: `✓ ${countLabel(c.passing, 'check')} passed`, color: theme.success };
}

/**
 * The task's pull request: its state on GitHub with the action that fixes it,
 * CI, agent hand-offs that only show when there is something to fix, then
 * how it merges, which the dialog passes in.
 */
export function FinishPrSection(props: FinishPrSectionProps) {
  const checks = () => getPrChecks(props.task.id);
  const busyOrDisabled = () => props.disabled || !!props.pr.busy();
  const merged = () => props.pr.mode() === 'merged';
  // The PR details decide whether merging is offered; the watcher may lag them.
  const isDraft = () => props.pr.pr()?.isDraft ?? checks()?.isDraft;
  const summary = () => {
    const c = checks();
    const parts = [
      isDraft() ? 'Draft' : '',
      c?.reviewDecision ? c.reviewDecision.toLowerCase().replace(/_/g, ' ') : '',
    ];
    return parts.filter(Boolean).join(' · ');
  };
  const canMarkReady = () => props.pr.mode() === 'pr' && !!props.pr.pr()?.isDraft;
  const ciFailed = () => (checks()?.failing ?? 0) > 0;
  const changesRequested = () => checks()?.reviewDecision === 'CHANGES_REQUESTED';
  const stage = async (kind: 'fix-ci' | 'review') => {
    if (await props.pr.stage(kind)) props.onStaged();
  };

  return (
    <section aria-label="Pull request" style={{ margin: '20px 0 0', 'font-size': '13px' }}>
      <h3 style={{ margin: '0 0 8px', 'font-size': '13px', color: theme.fg }}>
        <Show when={taskPrUrl(props.task)} fallback="Pull request">
          {(url) => (
            <>
              Pull request #{props.pr.number()}
              {' · '}
              <button
                type="button"
                style={linkButtonStyle}
                disabled={busyOrDisabled()}
                onClick={() => props.onOpenPullRequest(url())}
                title="View pull request details or open it on GitHub"
              >
                Details…
              </button>
            </>
          )}
        </Show>
      </h3>
      <Show when={taskPrUrl(props.task)}>
        <Show when={!merged()} fallback={<p style={mutedText}>Merged on GitHub.</p>}>
          <Show when={summary() || canMarkReady()}>
            <p style={mutedText}>
              {summary()}
              <Show when={canMarkReady()}>
                {summary() ? ' · ' : ''}
                <button
                  type="button"
                  style={linkButtonStyle}
                  disabled={busyOrDisabled()}
                  onClick={() => void props.pr.markReady()}
                >
                  {props.pr.busy() === 'ready' ? 'Marking ready…' : 'Mark ready for review'}
                </button>
              </Show>
            </p>
          </Show>
          <Show when={checks()?.mergeable === 'CONFLICTING'}>
            <p style={{ color: theme.warning, margin: '6px 0' }}>
              PR has conflicts with its base branch.
            </p>
          </Show>
          <Show when={checks()?.checks.length ? checks() : undefined}>
            {(c) => (
              <details open={ciFailed()} style={{ margin: '6px 0', 'font-size': '12px' }}>
                <summary style={{ cursor: 'pointer', color: checksSummary(c()).color }}>
                  {checksSummary(c()).text}
                </summary>
                <ul
                  aria-label="GitHub CI checks"
                  style={{ 'max-height': '140px', 'overflow-y': 'auto', 'padding-left': '20px' }}
                >
                  <For each={c().checks}>
                    {(check) => (
                      <li>
                        {check.name}: {check.bucket}
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            )}
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
                  class="btn-secondary btn-with-icon"
                  disabled={busyOrDisabled()}
                  aria-busy={props.pr.busy() === 'fix-ci'}
                  onClick={() => void stage('fix-ci')}
                  title="Collect failed checks and their log tails into a prompt for the agent"
                  style={dialogButtonStyle(false, busyOrDisabled())}
                >
                  <ToolsIcon size={14} />
                  {props.pr.busy() === 'fix-ci' ? 'Collecting…' : 'Fix CI'}
                </button>
              </Show>
              <Show when={changesRequested()}>
                <button
                  type="button"
                  class="btn-secondary btn-with-icon"
                  disabled={busyOrDisabled()}
                  aria-busy={props.pr.busy() === 'review'}
                  onClick={() => void stage('review')}
                  title="Collect unresolved review comments into a prompt for the agent"
                  style={dialogButtonStyle(false, busyOrDisabled())}
                >
                  <CommentIcon size={14} />
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
      {props.children}
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

const rowStyle: JSX.CSSProperties = {
  display: 'flex',
  'flex-wrap': 'wrap',
  gap: '8px',
  'align-items': 'center',
  color: theme.fgMuted,
  'margin-top': '12px',
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
    <div style={{ 'font-size': '13px' }}>
      <Show when={props.pr.mode() === 'pr'}>
        <Show when={props.pr.pr()}>
          {(details) => (
            <>
              <div style={rowStyle}>
                <label style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                  Merge by
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
                <span aria-hidden="true">·</span>
                {mergeLocally()}
              </div>
              {/* UNSTABLE: non-required checks fail; GitHub allows the merge. */}
              <Show when={details().mergeStateStatus === 'UNSTABLE'}>
                <p style={mutedText}>Some checks are failing; GitHub still allows the merge.</p>
              </Show>
              <Show when={prIsBlocked(details())}>
                <label
                  style={{ ...mutedText, display: 'flex', gap: '6px', 'align-items': 'center' }}
                  title="Merges with gh pr merge --admin, skipping branch protection and any merge queue. GitHub refuses unless you may bypass them."
                >
                  <input
                    type="checkbox"
                    data-testid="bypass-protection"
                    checked={props.pr.bypassProtection()}
                    disabled={disabled()}
                    onChange={(e) => props.pr.setBypassProtection(e.currentTarget.checked)}
                  />
                  Bypass required reviews and checks (admin)
                </label>
              </Show>
            </>
          )}
        </Show>
        <Show when={!props.pr.pr()}>
          <p style={mutedText}>{mergeLocally()}</p>
        </Show>
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
