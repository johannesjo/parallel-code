import { For, Show } from 'solid-js';
import { theme } from '../lib/theme';
import { relativeTime, sessionLabel } from './SessionPicker';
import type { SessionRecord } from '../../electron/shared/session-record';

/** What one imported worktree's task starts with. */
export interface ImportChoice {
  /** Session to resume; `''` starts a new conversation. */
  sessionId: string;
  cleanupOnClose: boolean;
}

/**
 * Per-worktree import options: which recorded session the task resumes, and
 * whether closing it removes the worktree.
 *
 * `sessions` is undefined while the scan runs.
 */
export function ImportWorktreeOptions(props: {
  sessions: SessionRecord[] | undefined;
  choice: ImportChoice;
  disabled: boolean;
  onChange: (choice: ImportChoice) => void;
}) {
  const textStyle = { 'font-size': '12px', color: theme.fgMuted };
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
      <Show when={props.sessions} fallback={<span style={textStyle}>Looking for sessions…</span>}>
        {(sessions) => (
          <Show
            when={sessions().length > 0}
            fallback={
              <span style={textStyle}>No recorded sessions; starts a new conversation</span>
            }
          >
            <select
              aria-label="Session to resume"
              disabled={props.disabled}
              value={props.choice.sessionId}
              onChange={(e) =>
                props.onChange({ ...props.choice, sessionId: e.currentTarget.value })
              }
              style={{ 'font-size': '12px', 'max-width': '100%' }}
            >
              <For each={sessions()}>
                {(session) => (
                  <option value={session.id}>
                    Resume: {sessionLabel(session)} · {relativeTime(session.updatedAt)}
                  </option>
                )}
              </For>
              <option value="">Start a new conversation</option>
            </select>
          </Show>
        )}
      </Show>
      <label style={{ ...textStyle, display: 'flex', gap: '6px', 'align-items': 'center' }}>
        <input
          type="checkbox"
          disabled={props.disabled}
          checked={props.choice.cleanupOnClose}
          onChange={(e) =>
            props.onChange({ ...props.choice, cleanupOnClose: e.currentTarget.checked })
          }
        />
        Remove the worktree when the task closes
      </label>
    </div>
  );
}
