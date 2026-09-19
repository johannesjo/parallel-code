import { For, Show, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { listResumableSessions, resumeAgentSession } from '../store/sessions';
import { canResumeSessionId } from '../../electron/shared/session-resume';
import type { SessionRecord } from '../../electron/shared/session-record';

/** Relative age of a session, via the platform formatter rather than a table
 *  of thresholds. Exported for its test, which pins `locale` so the wording it
 *  checks does not depend on the host's default. */
export function relativeTime(epochMs: number, now = Date.now(), locale?: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const seconds = Math.round((epochMs - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(seconds, 'second');
}

/** What to call a session with no title of its own yet. */
function sessionLabel(session: SessionRecord): string {
  return session.title ?? `Session ${session.id.slice(0, 8)}`;
}

/**
 * Picks which recorded session a pane resumes, instead of taking whichever one
 * in the worktree is newest.
 *
 * Renders nothing for a CLI that cannot resume a named session — the button
 * would promise something the launch cannot honour.
 */
export function SessionPicker(props: {
  taskId: string;
  agentId: string;
  command: string;
  /** Session this pane is already pointed at, shown as the current choice. */
  currentSessionId?: string;
}) {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLSpanElement | undefined;

  // Fetching is keyed on being open, so the transcript scan runs when someone
  // asks for the list and not on every render of an exited pane.
  const [sessions] = createResource(
    () => (open() ? { taskId: props.taskId, command: props.command } : false),
    (source) =>
      source ? listResumableSessions(source.taskId, source.command) : Promise.resolve([]),
  );

  const handleClickOutside = (e: MouseEvent) => {
    if (rootRef && !rootRef.contains(e.target as Node)) setOpen(false);
  };

  onMount(() => document.addEventListener('mousedown', handleClickOutside));
  onCleanup(() => document.removeEventListener('mousedown', handleClickOutside));

  const pick = (session: SessionRecord) => {
    setOpen(false);
    resumeAgentSession(props.taskId, props.agentId, session.id);
  };

  return (
    <Show when={canResumeSessionId(props.command)}>
      <span style={{ position: 'relative', display: 'inline-flex' }} ref={(el) => (rootRef = el)}>
        <button
          aria-label="Resume a specific session"
          aria-expanded={open()}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open());
          }}
          style={{
            background: theme.bgElevated,
            border: `1px solid ${theme.border}`,
            color: theme.fg,
            padding: '2px 8px',
            'border-radius': 'var(--radius-xs)',
            cursor: 'pointer',
            'font-size': sf(11),
          }}
        >
          Resume session…
        </button>
        <Show when={open()}>
          <div
            style={{
              position: 'absolute',
              top: '100%',
              right: '0',
              'margin-top': '4px',
              background: theme.bgElevated,
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-sm)',
              padding: '4px 0',
              'z-index': '20',
              'min-width': '280px',
              'max-width': '420px',
              'max-height': '320px',
              'overflow-y': 'auto',
              'box-shadow': '0 4px 12px rgba(0,0,0,0.3)',
            }}
          >
            <Show
              when={!sessions.loading}
              fallback={
                <div style={{ padding: '6px 10px', 'font-size': sf(11), color: theme.fgMuted }}>
                  Reading sessions…
                </div>
              }
            >
              <Show
                when={(sessions() ?? []).length > 0}
                fallback={
                  <div style={{ padding: '6px 10px', 'font-size': sf(11), color: theme.fgMuted }}>
                    No recorded sessions for this worktree
                  </div>
                }
              >
                <For each={sessions() ?? []}>
                  {(session) => (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        pick(session);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        'text-align': 'left',
                        background:
                          session.id === props.currentSessionId ? theme.bgHover : 'transparent',
                        border: 'none',
                        color: theme.fg,
                        padding: '5px 10px',
                        cursor: 'pointer',
                        'font-size': sf(11),
                      }}
                    >
                      <div
                        style={{
                          overflow: 'hidden',
                          'text-overflow': 'ellipsis',
                          'white-space': 'nowrap',
                        }}
                      >
                        {sessionLabel(session)}
                      </div>
                      <div style={{ color: theme.fgMuted, 'font-size': sf(10) }}>
                        {relativeTime(session.updatedAt)}
                        <Show when={session.branch}> · {session.branch}</Show>
                        <Show when={session.id === props.currentSessionId}> · current</Show>
                      </div>
                    </button>
                  )}
                </For>
              </Show>
            </Show>
          </div>
        </Show>
      </span>
    </Show>
  );
}
