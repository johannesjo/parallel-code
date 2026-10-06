import { For, Show } from 'solid-js';
import { sendPrompt, store } from '../store/store';
import { bannerStyle, theme } from '../lib/theme';
import type { Task } from '../store/types';
import type { MergeState } from './merge-state';

const buttonStyle = (primary: boolean, disabled = false) => ({
  padding: '5px 12px',
  background: primary ? theme.accent : theme.bgInput,
  border: primary ? `1px solid ${theme.accent}` : `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-md)',
  color: primary ? theme.accentText : theme.fg,
  cursor: disabled ? 'not-allowed' : 'pointer',
  'font-size': '12px',
  'font-weight': primary ? '600' : 'normal',
  opacity: disabled ? '0.5' : '1',
});

/**
 * Base moved on: offers to bring it in by rebase, by a merge commit, or by
 * asking the agent. With conflicts the agent is the suggested route.
 */
export function MergeConflictBanner(props: { task: Task; state: MergeState; onDone: () => void }) {
  const base = () => props.state.baseBranchName();
  const dirty = () => Boolean(props.state.worktreeStatus()?.has_uncommitted_changes);
  const blocked = () => props.state.syncing() !== null || dirty();
  const blockedTitle = (action: string) =>
    dirty() ? `Commit or stash changes before you ${action}` : undefined;
  const agentRunning = () =>
    props.task.agentIds.length > 0 &&
    store.agents[props.state.selectedAgentId()]?.status === 'running';
  const askAgent = () => {
    const agentId = props.state.selectedAgentId();
    props.onDone();
    sendPrompt(props.task.id, agentId, `rebase on ${base()} branch`).catch((err) => {
      console.error('Failed to send rebase prompt:', err);
    });
  };

  return (
    <Show when={!props.state.mergeStatus.loading && props.state.mergeStatus()}>
      {(status) => (
        <Show when={status().main_ahead_count > 0}>
          <div
            style={{
              ...bannerStyle(props.state.hasConflicts() ? theme.error : theme.warning),
              'margin-bottom': '12px',
              'font-size': '13px',
            }}
          >
            <div style={{ 'font-weight': '600' }}>
              <Show
                when={props.state.hasConflicts()}
                fallback={
                  <>
                    {base()} has {status().main_ahead_count} new commit
                    {status().main_ahead_count > 1 ? 's' : ''}. Bring them into this branch first.
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
                type="button"
                disabled={blocked()}
                onClick={() => void props.state.syncWithBase('rebase')}
                title={blockedTitle('rebase') ?? `Replay this branch's commits on top of ${base()}`}
                style={buttonStyle(!props.state.hasConflicts(), blocked())}
              >
                {props.state.syncing() === 'rebase' ? 'Rebasing…' : `Rebase onto ${base()}`}
              </button>
              <button
                type="button"
                disabled={blocked()}
                onClick={() => void props.state.syncWithBase('merge')}
                title={
                  blockedTitle('merge') ??
                  `Add a merge commit that brings ${base()} into this branch; history stays as it is`
                }
                style={buttonStyle(false, blocked())}
              >
                {props.state.syncing() === 'merge' ? 'Merging…' : `Merge ${base()} into branch`}
              </button>
              <Show when={agentRunning()}>
                <button
                  type="button"
                  onClick={askAgent}
                  title="Close the dialog and ask the agent to rebase"
                  style={buttonStyle(props.state.hasConflicts())}
                >
                  Rebase with AI
                </button>
              </Show>
            </div>
            <Show when={props.state.syncError()}>
              <div style={{ 'margin-top': '6px', color: theme.error }}>
                {props.state.syncError()}
              </div>
            </Show>
          </div>
        </Show>
      )}
    </Show>
  );
}
