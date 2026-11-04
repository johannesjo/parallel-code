import { formatKeyCombo } from '../lib/keybindings';
import { linkButtonStyle, theme } from '../lib/theme';
import { resolvedBindings } from '../store/keybindings';

/** Finish's PR section before the task has one: a quiet offer to open it. */
export function CreatePrEntry(props: { disabled: boolean; onCreate: () => void }) {
  const shortcut = () => {
    const binding = resolvedBindings().find((b) => b.id === 'app.task.createPr');
    return binding ? ` (${formatKeyCombo(binding)})` : '';
  };
  return (
    <section aria-label="Pull request" style={{ margin: '20px 0 0', 'font-size': '13px' }}>
      <h3 style={{ margin: '0 0 8px', 'font-size': '13px', color: theme.fg }}>Pull request</h3>
      <p style={{ color: theme.fgMuted, margin: '6px 0' }}>
        None yet.{' '}
        <button
          type="button"
          style={linkButtonStyle}
          disabled={props.disabled}
          title={`Write a title and description, then open it on GitHub${shortcut()}`}
          onClick={() => props.onCreate()}
        >
          Create pull request…
        </button>
      </p>
    </section>
  );
}
