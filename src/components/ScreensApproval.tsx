import { For, Show, type JSX } from 'solid-js';
import { sf } from '../lib/fontScale';
import { dialogButtonStyle, theme } from '../lib/theme';
import { approveTaskScreens, cancelTaskScreens, taskScreens } from '../store/task-screens';

const codeStyle: JSX.CSSProperties = {
  margin: '2px 0 8px',
  padding: '6px 8px',
  background: theme.bgInput,
  border: `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-md)',
  'white-space': 'pre-wrap',
  'overflow-wrap': 'anywhere',
};

/**
 * The commands a capture asks to start the app with. They come from Claude
 * but run in the user's shell, outside Claude's sandbox, so the user sees and
 * allows them first.
 */
export function ScreensApproval(props: { taskId: string }) {
  const commands = () => {
    const s = taskScreens(props.taskId);
    return s?.state === 'running' ? s.commands : undefined;
  };
  const listed = () => {
    const c = commands();
    return c
      ? [
          { label: 'After', command: c.after },
          ...(c.before ? [{ label: 'Before', command: c.before }] : []),
        ]
      : [];
  };
  return (
    <Show when={commands()}>
      <section aria-label="Start the app?" style={{ 'margin-top': '8px', 'font-size': sf(12) }}>
        <p style={{ margin: '0 0 8px', color: theme.fgMuted }}>
          Run these to start the app? They run in your shell, outside Claude’s sandbox, with any
          scripts they call.
        </p>
        <For each={listed()}>
          {(item) => (
            <>
              <div>{item.label}</div>
              <pre style={codeStyle}>
                <code>{item.command}</code>
              </pre>
            </>
          )}
        </For>
        <button
          type="button"
          style={dialogButtonStyle(true)}
          onClick={() => approveTaskScreens(props.taskId)}
        >
          Start
        </button>
        <button
          type="button"
          style={{ ...dialogButtonStyle(false), 'margin-left': '8px' }}
          onClick={() => cancelTaskScreens(props.taskId)}
        >
          Don’t start
        </button>
      </section>
    </Show>
  );
}
