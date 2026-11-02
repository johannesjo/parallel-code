import { Show, createUniqueId, type JSX } from 'solid-js';
import { sectionLabelStyle, theme } from '../lib/theme';

/** Text input look shared by every field of the project dialog. */
export const projectInputStyle: JSX.CSSProperties = {
  background: theme.bgInput,
  border: `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-md)',
  padding: '8px 12px',
  color: theme.fg,
  'font-size': '14px',
  outline: 'none',
};

export const projectMonoInputStyle: JSX.CSSProperties = {
  ...projectInputStyle,
  'font-size': '13px',
  'font-family': "'JetBrains Mono', monospace",
};

export const projectHintStyle: JSX.CSSProperties = {
  'font-size': '12px',
  color: theme.fgSubtle,
  'line-height': '1.45',
};

/** Neutral bordered button for routine actions inside the dialog body. */
export const projectButtonStyle: JSX.CSSProperties = {
  padding: '5px 12px',
  background: theme.bgInput,
  border: `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-sm)',
  color: theme.fgMuted,
  cursor: 'pointer',
  'font-size': '12px',
  'flex-shrink': '0',
};

/**
 * A titled group of related settings within a tab. The heading ranks above the
 * uppercase field labels inside.
 */
export function ProjectSection(props: { title: string; children: JSX.Element }) {
  const id = createUniqueId();
  return (
    <section
      aria-labelledby={id}
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: '14px',
      }}
    >
      <h3 id={id} style={{ margin: '0', 'font-size': '14px', 'font-weight': '600' }}>
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

interface ProjectFieldProps {
  label: string;
  /** Muted aside after the label, e.g. what a blank value means. */
  aside?: string;
  hint?: JSX.Element;
  /** Receives the id to put on the control so the label names it. */
  children: (id: string) => JSX.Element;
}

/** Label, control and optional hint, stacked. */
export function ProjectField(props: ProjectFieldProps) {
  const id = createUniqueId();
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
      <label for={id} style={sectionLabelStyle}>
        {props.label}
        <Show when={props.aside}>
          {' '}
          <span style={{ opacity: '0.6', 'text-transform': 'none', 'letter-spacing': 'normal' }}>
            ({props.aside})
          </span>
        </Show>
      </label>
      {props.children(id)}
      <Show when={props.hint}>
        <div style={projectHintStyle}>{props.hint}</div>
      </Show>
    </div>
  );
}

/** Checkbox with its label and, below, what it does. */
export function ProjectCheckbox(props: {
  label: string;
  description?: JSX.Element;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label style={{ display: 'flex', gap: '10px', 'align-items': 'flex-start', cursor: 'pointer' }}>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
        style={{ margin: '2px 0 0', cursor: 'pointer', 'accent-color': theme.accent }}
      />
      <span style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
        <span style={{ 'font-size': '14px', color: theme.fg }}>{props.label}</span>
        <Show when={props.description}>
          <span style={projectHintStyle}>{props.description}</span>
        </Show>
      </span>
    </label>
  );
}
