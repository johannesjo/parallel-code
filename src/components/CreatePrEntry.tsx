import { Show } from 'solid-js';
import { linkButtonStyle, theme } from '../lib/theme';
import { shortcutHint } from '../store/keybindings';

/** Finish's PR section before the task has one: a quiet offer to open it, or to write it first. */
export function CreatePrEntry(props: {
  disabled: boolean;
  /** A one-click create is running. */
  creating: boolean;
  onCreate: () => void;
  onWrite: () => void;
}) {
  return (
    <section aria-label="Pull request" style={{ margin: '20px 0 0', 'font-size': '13px' }}>
      <h3 style={{ margin: '0 0 8px', 'font-size': '13px', color: theme.fg }}>Pull request</h3>
      <p style={{ color: theme.fgMuted, margin: '6px 0' }}>
        <Show when={props.creating} fallback="None yet.">
          Creating…
        </Show>{' '}
        <button
          type="button"
          style={linkButtonStyle}
          disabled={props.disabled || props.creating}
          title={`Push, draft a description and open a draft PR on GitHub${shortcutHint('app.task.createPr')}`}
          onClick={() => props.onCreate()}
        >
          Create draft PR
        </button>
        {' · '}
        <button
          type="button"
          style={linkButtonStyle}
          disabled={props.disabled || props.creating}
          title="Write or edit the title and description first"
          onClick={() => props.onWrite()}
        >
          Write it first…
        </button>
      </p>
    </section>
  );
}
