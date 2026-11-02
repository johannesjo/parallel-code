import { For, Show } from 'solid-js';
import { sendPrompt, store } from '../store/store';
import { bannerStyle, theme } from '../lib/theme';
import type { Task } from '../store/types';
import { overlapText } from '../lib/readiness-line';
import type { MergeState } from './merge-state';
import { GitBranchIcon, GitMergeIcon, SparkleIcon } from './icons';

// Neutral even with conflicts: the banner carries the urgency, and full-strength
// text, not an accent fill, marks the suggested route.
export const buttonStyle = (suggested: boolean, disabled = false) => ({
  padding: '5px 12px',
  background: theme.bgInput,
  border: `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-md)',
  color: suggested ? theme.fg : theme.fgMuted,
  cursor: disabled ? 'not-allowed' : 'pointer',
  'font-size': '12px',
  'font-weight': suggested ? '500' : 'normal',
  'white-space': 'nowrap',
  opacity: disabled ? '0.5' : '1',
});

/**
 * Base moved on: offers to bring it in by rebase, by a merge commit, or by
 * asking the agent. With conflicts, or after an attempt stopped on them, the agent is
 * the suggested route.
 */
export function MergeConflictBanner(props: { task: Task; state: MergeState; onDone: () => void }) {
  const base = () => props.state.baseBranchName();
  // Other uncommitted changes are stashed and put back around the sync.
  const overlap = () => props.state.uncommittedOverlap();
  // Undefined when the overlap is unknown: then neither overlap line shows.
  const baseOverlap = () =>
    props.state.hasConflicts() ? undefined : props.state.mergeStatus()?.overlapping_files;
  const blocked = () => props.state.syncing() !== null || overlap().length > 0;
  const blockedTitle = (action: string) =>
    overlap().length ? `Commit or stash your changes before you ${action}` : undefined;
  const agentRunning = () =>
    props.task.agentIds.length > 0 &&
    store.agents[props.state.selectedAgentId()]?.status === 'running';
  const agentSuggested = () => props.state.hasConflicts() || props.state.syncConflict() !== null;
  // The merge check found no conflicts, so a single merge commit should go through
  // where replaying the branch commit by commit did not.
  const mergeInstead = () => props.state.syncConflict() === 'rebase' && !props.state.hasConflicts();
  const askAgent = () => {
    const agentId = props.state.selectedAgentId();
    props.onDone();
    const conflicts = props.state.mergeStatus()?.conflicting_files ?? [];
    const prompt = conflicts.length
      ? `rebase on ${base()} branch and resolve the conflicts in ${conflicts.join(', ')}`
      : props.state.syncConflict()
        ? `rebase on ${base()} branch and resolve the conflicts`
        : `rebase on ${base()} branch`;
    sendPrompt(props.task.id, agentId, prompt).catch((err) => {
      console.error('Failed to send rebase prompt:', err);
    });
  };

  return (
    <Show when={!props.state.mergeStatus.loading && props.state.mergeStatus()}>
      {(status) => (
        <Show when={status().main_ahead_count > 0}>
          <div
            style={{
              // A base that moved on is routine; only conflicts need attention now.
              ...(props.state.hasConflicts()
                ? bannerStyle(theme.error)
                : {
                    padding: '8px 12px',
                    'border-radius': 'var(--radius-md)',
                    border: `1px solid ${theme.border}`,
                  }),
              'margin-bottom': '28px',
              'font-size': '13px',
            }}
          >
            <div style={{ 'font-weight': props.state.hasConflicts() ? '600' : 'normal' }}>
              <Show
                when={props.state.hasConflicts()}
                fallback={
                  <>
                    {base()} has {status().main_ahead_count} new commit
                    {status().main_ahead_count > 1 ? 's' : ''}.
                    {/* Nothing to act on without overlap, so it stays on the heading's line. */}
                    <Show when={baseOverlap()?.length === 0}>
                      <span style={{ color: theme.fgMuted }}>
                        {" No overlap with this branch's files."}
                      </span>
                    </Show>
                  </>
                }
              >
                Conflicts with {base()} in {status().conflicting_files.length} file
                {status().conflicting_files.length > 1 ? 's' : ''}:
              </Show>
            </div>
            <Show when={props.state.hasConflicts()}>
              {/* Capped so a long list does not push the dialog's content out of view. */}
              <ul
                style={{
                  margin: '4px 0 0',
                  'padding-left': '20px',
                  'max-height': '96px',
                  'overflow-y': 'auto',
                }}
              >
                <For each={status().conflicting_files}>{(f) => <li>{f}</li>}</For>
              </ul>
            </Show>
            {/* Checks on this branch never saw those commits; overlap is where that matters. */}
            <Show when={baseOverlap()?.length}>
              <div style={{ 'margin-top': '4px', color: theme.fgMuted }}>
                {overlapText(baseOverlap() ?? [], status().main_ahead_count)}
              </div>
            </Show>
            <Show when={overlap().length > 0}>
              <div style={{ 'margin-top': '4px' }}>
                Commit or stash your changes to {overlap().join(', ')} first: {base()} changed them
                too.
              </div>
            </Show>
            <div
              style={{
                'margin-top': '8px',
                display: 'flex',
                'flex-wrap': 'wrap',
                'align-items': 'center',
                gap: '6px',
              }}
            >
              <button
                class="btn-with-icon"
                type="button"
                disabled={blocked()}
                onClick={() => void props.state.syncWithBase('rebase')}
                title={blockedTitle('rebase') ?? `Replay this branch's commits on top of ${base()}`}
                style={buttonStyle(!agentSuggested(), blocked())}
              >
                <GitBranchIcon size={12} />
                {props.state.syncing() === 'rebase' ? 'Rebasing…' : 'Rebase'}
              </button>
              <button
                class="btn-with-icon"
                type="button"
                disabled={blocked()}
                onClick={() => void props.state.syncWithBase('merge')}
                title={
                  blockedTitle('merge') ??
                  `Add a merge commit that brings ${base()} into this branch; history stays as it is`
                }
                style={buttonStyle(false, blocked())}
              >
                <GitMergeIcon size={12} />
                {props.state.syncing() === 'merge' ? 'Merging…' : 'Merge'}
              </button>
              <Show when={agentRunning()}>
                <button
                  class="btn-with-icon"
                  type="button"
                  onClick={askAgent}
                  title="Close the dialog and ask the agent to rebase"
                  style={buttonStyle(agentSuggested())}
                >
                  <SparkleIcon size={12} />
                  Rebase with AI
                </button>
              </Show>
            </div>
            <Show when={props.state.syncError()}>
              <div style={{ 'margin-top': '6px', color: theme.error }}>
                {props.state.syncError()}
                <Show when={mergeInstead()}>
                  {` Merge ${base()} into the branch instead${agentRunning() ? ', or rebase with AI' : ''}.`}
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      )}
    </Show>
  );
}
