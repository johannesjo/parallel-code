import { For, Show, type JSX } from 'solid-js';
import { theme, sectionLabelStyle } from '../../lib/theme';

export function SettingsSection(props: { title: string; children: JSX.Element }) {
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
      <div style={{ ...sectionLabelStyle, 'font-weight': '600' }}>{props.title}</div>
      {props.children}
    </div>
  );
}

/** Base look of text inputs, selects and textareas inside a SettingsCard. */
export const settingsFieldStyle = {
  background: theme.taskPanelBg,
  border: `1px solid ${theme.border}`,
  'border-radius': 'var(--radius-sm)',
  padding: '6px 10px',
  color: theme.fg,
};

/** Bordered box that groups a field with its hint text inside a section. */
export function SettingsCard(props: { children: JSX.Element; gap?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        gap: props.gap ?? '6px',
        padding: '8px 12px',
        'border-radius': 'var(--radius-md)',
        background: theme.bgInput,
        border: `1px solid ${theme.border}`,
      }}
    >
      {props.children}
    </div>
  );
}

export function SettingsCheckboxRow(props: {
  label: string;
  description: JSX.Element;
  checked: boolean;
  onChange: (checked: boolean) => void;
  align?: 'center' | 'flex-start';
  disabled?: boolean;
}) {
  return (
    <label
      style={{
        display: 'flex',
        'align-items': props.align ?? 'center',
        gap: '10px',
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? '0.6' : '1',
        padding: '8px 0',
      }}
    >
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => {
          props.onChange(e.currentTarget.checked);
          e.currentTarget.checked = props.checked;
        }}
        style={{ 'accent-color': theme.accent, cursor: 'inherit' }}
      />
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
        <span style={{ 'font-size': '14px', color: theme.fg }}>{props.label}</span>
        <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>{props.description}</span>
      </div>
    </label>
  );
}

/** A labelled model picker in its own card, such as the naming or default AI model. */
export function ModelSelect(props: {
  label: string;
  value: string;
  choices: Record<string, { label: string }>;
  onChange: (id: string) => void;
  hint?: string;
}) {
  return (
    <SettingsCard>
      <label style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
        <span style={{ 'font-size': '13px', color: theme.fg, 'white-space': 'nowrap' }}>
          {props.label}
        </span>
        <select
          value={props.value}
          onChange={(e) => props.onChange(e.currentTarget.value)}
          style={{ flex: '1', ...settingsFieldStyle, 'font-size': '13px', cursor: 'pointer' }}
        >
          <For each={Object.entries(props.choices)}>
            {([id, choice]) => <option value={id}>{choice.label}</option>}
          </For>
        </select>
      </label>
      <Show when={props.hint}>
        <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>{props.hint}</span>
      </Show>
    </SettingsCard>
  );
}
