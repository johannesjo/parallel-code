import { For, Show, createEffect, createSignal, on } from 'solid-js';
import { Dialog } from './Dialog';
import { errMessage } from '../lib/log';
import { bannerStyle, dialogButtonStyle, theme } from '../lib/theme';
import { getPrChecks } from '../store/store';
import { showNotification } from '../store/notification';
import type { PrCheckBucket, PrMergeMethod } from '../ipc/types';
import type { Task } from '../store/types';
import { CommentIcon, GitHubIcon, GitMergeIcon, ToolsIcon } from './icons';
import { PR_METHOD_LABELS, createPrActions, prMergeBlocker } from './pr-actions';

interface PullRequestDialogProps {
  open: boolean;
  task: Task;
  prUrl: string;
  onClose: () => void;
}

const BUCKET_COLORS: Record<PrCheckBucket, string> = {
  pass: theme.success,
  skipping: theme.fgSubtle,
  pending: theme.warning,
  fail: theme.error,
  cancel: theme.error,
};

/** PR status for a task, plus actions that feed GitHub feedback to the agent or merge. */
export function PullRequestDialog(props: PullRequestDialogProps) {
  const actions = createPrActions(props);
  const { details, busy, error, info } = actions;
  const [confirmingMerge, setConfirmingMerge] = createSignal(false);
  const checks = () => getPrChecks(props.task.id);
  const chosenMethod = actions.method;
  const setMethod = actions.setMethod;
  const blocker = () => {
    const d = actions.pr();
    return d ? prMergeBlocker(d) : null;
  };

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) setConfirmingMerge(false);
      },
    ),
  );

  async function stage(kind: 'fix-ci' | 'review') {
    if (!(await actions.stage(kind))) return;
    showNotification('Prompt staged in the task input. Review it, then send.');
    props.onClose();
  }

  async function merge() {
    const number = actions.pr()?.number;
    setConfirmingMerge(false);
    const outcome = await actions.merge();
    if (outcome === 'failed') return;
    showNotification(
      outcome === 'merged'
        ? `Merged PR #${number}`
        : `Merge requested for PR #${number}; GitHub has not merged it yet (it may be in a merge queue).`,
    );
    // Closing avoids showing the pre-merge details (and merge button) until
    // a refetch lands; the PR chip updates from the checks watcher.
    props.onClose();
  }

  return (
    <Dialog open={props.open} onClose={() => !busy() && props.onClose()} width="560px">
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
        <h2 style={{ margin: '0', 'font-size': '17px', color: theme.fg, 'font-weight': '600' }}>
          Pull Request
          <Show when={actions.pr()}>
            {(d) => (
              <>
                {' '}
                #{d().number}
                <span style={{ color: theme.fgMuted, 'font-weight': '400' }}> {d().title}</span>
              </>
            )}
          </Show>
        </h2>

        <Show when={details.loading}>
          <span style={{ 'font-size': '13px', color: theme.fgSubtle }}>Loading from GitHub…</span>
        </Show>
        <Show when={details.error}>
          {(err) => (
            <div role="alert" style={{ ...bannerStyle(theme.error), 'font-size': '13px' }}>
              {errMessage(err())}
            </div>
          )}
        </Show>

        <Show when={actions.pr()}>
          {(d) => (
            <dl
              style={{
                display: 'grid',
                'grid-template-columns': 'max-content 1fr',
                gap: '6px 14px',
                margin: '0',
                'font-size': '13px',
                color: theme.fg,
              }}
            >
              <dt style={{ color: theme.fgMuted }}>State</dt>
              <dd style={{ margin: '0' }}>
                {d().isDraft && d().state === 'OPEN' ? 'Draft' : d().state.toLowerCase()} · into{' '}
                {d().baseRefName}
              </dd>
              <dt style={{ color: theme.fgMuted }}>Mergeable</dt>
              <dd style={{ margin: '0' }}>
                {d().mergeable === 'CONFLICTING'
                  ? 'Conflicts'
                  : d().mergeable === 'MERGEABLE'
                    ? 'No conflicts'
                    : 'Unknown'}{' '}
                <span style={{ color: theme.fgSubtle }}>
                  ({d().mergeStateStatus.toLowerCase()})
                </span>
              </dd>
              <dt style={{ color: theme.fgMuted }}>Review</dt>
              <dd style={{ margin: '0' }}>
                {checks()?.reviewDecision?.toLowerCase().replace(/_/g, ' ') ?? 'none'}
              </dd>
            </dl>
          )}
        </Show>
        <Show
          when={actions.pr()?.headRefName && actions.pr()?.headRefName !== props.task.branchName}
        >
          <div style={{ ...bannerStyle(theme.warning), 'font-size': '13px' }}>
            This task works on <strong>{props.task.branchName}</strong>, not the PR branch{' '}
            <strong>{actions.pr()?.headRefName}</strong>. Pushing from this task does not update the
            PR.
          </div>
        </Show>

        <Show when={checks()?.checks.length}>
          <ul
            aria-label="Checks"
            style={{
              'list-style': 'none',
              margin: '0',
              padding: '0',
              'max-height': '160px',
              'overflow-y': 'auto',
              'font-size': '12px',
            }}
          >
            <For each={checks()?.checks ?? []}>
              {(check) => (
                <li style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                  <span
                    aria-hidden="true"
                    style={{
                      width: '7px',
                      height: '7px',
                      'border-radius': '50%',
                      background: BUCKET_COLORS[check.bucket],
                    }}
                  />
                  <span style={{ color: theme.fg }}>{check.name}</span>
                  <span style={{ color: theme.fgSubtle }}>{check.bucket}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <div style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
          <button
            type="button"
            class="btn-secondary btn-with-icon"
            onClick={() => window.open(props.prUrl, '_blank')}
            style={dialogButtonStyle(false)}
          >
            <GitHubIcon size={14} />
            Open on GitHub
          </button>
          <button
            type="button"
            class="btn-secondary btn-with-icon"
            disabled={!!busy() || !actions.pr()}
            title="Collect failed checks and their log tails into a prompt for the agent"
            onClick={() => void stage('fix-ci')}
            style={dialogButtonStyle(false, !!busy() || !actions.pr())}
          >
            <ToolsIcon size={14} />
            {busy() === 'fix-ci' ? 'Collecting…' : 'Fix CI'}
          </button>
          <button
            type="button"
            class="btn-secondary btn-with-icon"
            disabled={!!busy() || !actions.pr()}
            title="Collect unresolved review comments into a prompt for the agent"
            onClick={() => void stage('review')}
            style={dialogButtonStyle(false, !!busy() || !actions.pr())}
          >
            <CommentIcon size={14} />
            {busy() === 'review' ? 'Collecting…' : 'Address review'}
          </button>
        </div>

        <Show when={actions.pr()}>
          {(d) => (
            <Show
              when={!blocker()}
              fallback={
                <span style={{ 'font-size': '13px', color: theme.fgMuted }}>{blocker()}</span>
              }
            >
              <Show
                when={confirmingMerge()}
                fallback={
                  <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                    <select
                      aria-label="Merge method"
                      value={chosenMethod()}
                      onChange={(e) => setMethod(e.currentTarget.value as PrMergeMethod)}
                      style={{
                        flex: '1',
                        padding: '8px',
                        background: theme.bgInput,
                        border: `1px solid ${theme.border}`,
                        'border-radius': 'var(--radius-md)',
                        color: theme.fg,
                        'font-size': '13px',
                      }}
                    >
                      <For each={d().mergeMethods}>
                        {(m) => <option value={m}>{PR_METHOD_LABELS[m]}</option>}
                      </For>
                    </select>
                    <button
                      type="button"
                      class="btn-primary btn-with-icon"
                      disabled={!!busy()}
                      onClick={() => setConfirmingMerge(true)}
                      style={dialogButtonStyle(true, !!busy())}
                    >
                      <GitMergeIcon size={14} />
                      {busy() === 'merge' ? 'Merging…' : 'Merge on GitHub…'}
                    </button>
                  </div>
                }
              >
                <div
                  role="alertdialog"
                  aria-label="Confirm merge"
                  style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}
                >
                  <span style={{ flex: '1', 'font-size': '13px', color: theme.fg }}>
                    {PR_METHOD_LABELS[chosenMethod() ?? 'merge']} PR #{d().number} into{' '}
                    {d().baseRefName}?
                    {/* UNSTABLE: non-required checks fail; GitHub allows the merge. */}
                    <Show when={d().mergeStateStatus === 'UNSTABLE'}>
                      {' '}
                      Some checks are failing.
                    </Show>
                  </span>
                  <button
                    type="button"
                    class="btn-secondary"
                    onClick={() => setConfirmingMerge(false)}
                    style={dialogButtonStyle(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="btn-primary btn-with-icon"
                    onClick={() => void merge()}
                    style={dialogButtonStyle(true)}
                  >
                    <GitMergeIcon size={14} />
                    Confirm merge
                  </button>
                </div>
              </Show>
            </Show>
          )}
        </Show>

        <Show when={info()}>
          <div style={{ ...bannerStyle(theme.fgMuted), 'font-size': '13px' }}>{info()}</div>
        </Show>
        <Show when={error()}>
          <div role="alert" style={{ ...bannerStyle(theme.error), 'font-size': '13px' }}>
            {error()}
          </div>
        </Show>

        <div style={{ display: 'flex', 'justify-content': 'flex-end' }}>
          <button
            type="button"
            class="btn-secondary"
            disabled={!!busy()}
            onClick={() => props.onClose()}
            style={dialogButtonStyle(false, !!busy())}
          >
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
