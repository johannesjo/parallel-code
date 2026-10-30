import { For, Show, createEffect, createSignal } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import { bannerStyle, theme } from '../lib/theme';
import { getProjectPath } from '../store/store';
import type { Task } from '../store/types';
import { buttonStyle } from './MergeConflictBanner';
import type { MergeState } from './merge-state';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The local base has commits its upstream lacks and is behind it, typically
 * work that reached the upstream in another form. Explains that as the likely
 * cause of a conflict and offers to point the base at its upstream.
 */
export function BaseUpstreamNotice(props: { task: Task; state: MergeState }) {
  const [confirming, setConfirming] = createSignal(false);
  const [resetting, setResetting] = createSignal(false);
  const [error, setError] = createSignal('');
  const [previousHead, setPreviousHead] = createSignal('');
  const base = () => props.state.baseBranchName();
  const divergence = () => props.state.mergeStatus()?.base_upstream;

  // A fresh check replaces what an earlier confirm or failure was about.
  createEffect(() => {
    divergence();
    setConfirming(false);
    setError('');
  });

  const reset = async (expectedHead: string) => {
    setResetting(true);
    setError('');
    try {
      const previous = await invoke<string>(IPC.ResetBaseToUpstream, {
        projectRoot: getProjectPath(props.task.projectId),
        baseBranch: base(),
        expectedHead,
      });
      setPreviousHead(previous);
      props.state.refetchAll();
    } catch (err) {
      setError(errMessage(err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
      // A base that moved since the check needs fresh facts before another try.
      props.state.refetchAll();
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
      <Show when={divergence()}>
        {(d) => {
          const conflictCause = () => {
            const differing = new Set(d().differing_files);
            return (props.state.mergeStatus()?.conflicting_files ?? []).filter((f) =>
              differing.has(f),
            );
          };
          return (
            <div
              data-testid="base-upstream"
              style={{
                padding: '8px 12px',
                'border-radius': 'var(--radius-md)',
                border: `1px solid ${theme.border}`,
                'margin-bottom': '12px',
                'font-size': '13px',
              }}
            >
              <div>
                Local {base()} has {plural(d().local_count, 'commit')} not on {d().upstream} and is{' '}
                {d().behind} behind it.
                <Show when={conflictCause().length}>
                  {' '}
                  That is the likely cause of the conflicts in {conflictCause().join(', ')}.
                </Show>
              </div>
              <ul
                style={{
                  margin: '4px 0 0',
                  'padding-left': '20px',
                  'max-height': '96px',
                  'overflow-y': 'auto',
                  color: theme.fgMuted,
                }}
              >
                <For each={d().local_commits}>
                  {(c) => (
                    <li>
                      <code>{c.hash}</code> {c.subject}
                    </li>
                  )}
                </For>
                <Show when={d().local_count > d().local_commits.length}>
                  <li>and {d().local_count - d().local_commits.length} more</li>
                </Show>
              </ul>
              <Show
                when={confirming()}
                fallback={
                  <div style={{ 'margin-top': '8px' }}>
                    <button
                      type="button"
                      onClick={() => setConfirming(true)}
                      title={`Use ${d().upstream} as ${base()} if these commits already reached it`}
                      style={buttonStyle(conflictCause().length > 0)}
                    >
                      Reset {base()} to {d().upstream}…
                    </button>
                  </div>
                }
              >
                <div style={{ 'margin-top': '8px' }}>
                  {/* The one thing a reset loses, so it is spelled out before it runs. */}
                  <Show
                    when={d().differing_files.length}
                    fallback={`Their files match ${d().upstream}, so nothing is lost.`}
                  >
                    {d().differing_files.join(', ')} will take {d().upstream}'s version; the local
                    edits to {d().differing_files.length === 1 ? 'it' : 'them'} are dropped.
                  </Show>{' '}
                  Uncommitted changes stay. To undo, reset {base()} to{' '}
                  <code>{d().head.slice(0, 10)}</code>.
                  <div style={{ 'margin-top': '8px', display: 'flex', gap: '6px' }}>
                    <button
                      type="button"
                      disabled={resetting()}
                      onClick={() => void reset(d().head)}
                      style={buttonStyle(true, resetting())}
                    >
                      {resetting() ? 'Resetting…' : `Drop ${plural(d().local_count, 'commit')}`}
                    </button>
                    <button
                      type="button"
                      disabled={resetting()}
                      onClick={() => setConfirming(false)}
                      style={buttonStyle(false, resetting())}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </Show>
              <Show when={error()}>
                <div role="alert" style={{ 'margin-top': '6px', color: theme.error }}>
                  {error()}
                </div>
              </Show>
            </div>
          );
        }}
      </Show>
      {/* Outside the notice: that one hides once the reset lands. */}
      <Show when={previousHead() && !divergence()}>
        <div
          role="status"
          style={{ ...bannerStyle(theme.success), 'margin-bottom': '12px', 'font-size': '13px' }}
        >
          Reset {base()} to its upstream. It was at <code>{previousHead().slice(0, 10)}</code>.
        </div>
      </Show>
    </>
  );
}
