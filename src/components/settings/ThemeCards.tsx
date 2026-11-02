import { For, Show } from 'solid-js';
import { defaultPresetForTone, presetsForTone } from '../../lib/look';
import { theme } from '../../lib/theme';
import { detectThemeTone } from '../../lib/custom-theme';
import { store, setLightTheme, setDarkTheme } from '../../store/store';
import { CopyIcon, PencilIcon } from '../icons';

export type ThemeSlot = 'light' | 'dark';

export function PresetThemeCard(props: {
  preset: ReturnType<typeof presetsForTone>[number];
  active: boolean;
  onSelect: () => void;
  onClone: () => void;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        class={`settings-theme-card${props.active ? ' active' : ''}`}
        onClick={() => props.onSelect()}
      >
        <span class="settings-theme-title">
          {props.preset.label}{' '}
          <Show when={props.preset.id === defaultPresetForTone(props.preset.tone)}>
            <span class="settings-theme-default">Default</span>
          </Show>
        </span>
        <span class="settings-theme-desc">{props.preset.description}</span>
      </button>
      <button
        type="button"
        title="Clone as custom theme"
        onClick={(e) => {
          e.stopPropagation();
          props.onClone();
        }}
        style={{
          position: 'absolute',
          top: '4px',
          right: '4px',
          background: theme.bgElevated,
          border: `1px solid ${theme.border}`,
          'border-radius': 'var(--radius-xs)',
          color: theme.fgMuted,
          cursor: 'pointer',
          'font-size': '11px',
          padding: '2px 6px',
          opacity: '0',
          transition: 'opacity 0.15s',
        }}
        class="preset-clone-btn btn-with-icon"
      >
        <CopyIcon size={12} />
        Clone
      </button>
    </div>
  );
}

function CustomThemeCard(props: {
  customTheme: (typeof store.customThemes)[string];
  active: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) {
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        class={`settings-theme-card${props.active ? ' active' : ''}`}
        onClick={() => props.onSelect()}
      >
        <span class="settings-theme-title">{props.customTheme.name}</span>
        <span class="settings-theme-desc">{props.customTheme.description || 'Custom theme'}</span>
      </button>
      <button
        type="button"
        title="Edit custom theme"
        onClick={(e) => {
          e.stopPropagation();
          props.onEdit();
        }}
        style={{
          position: 'absolute',
          top: '4px',
          right: '4px',
          background: theme.bgElevated,
          border: `1px solid ${theme.border}`,
          'border-radius': 'var(--radius-xs)',
          color: theme.fgMuted,
          cursor: 'pointer',
          'font-size': '11px',
          padding: '2px 6px',
          opacity: '0',
          transition: 'opacity 0.15s',
        }}
        class="preset-clone-btn btn-with-icon"
      >
        <PencilIcon size={12} />
        Edit
      </button>
    </div>
  );
}

export function ThemeGrid(props: {
  slot: ThemeSlot;
  onClonePreset: (presetId: string, label: string) => void;
  onEditCustom: (themeId: string) => void;
}) {
  return (
    <div class="settings-theme-grid">
      <For each={presetsForTone(props.slot)}>
        {(preset) => {
          const active = () =>
            props.slot === 'light'
              ? store.lightThemeCustomId === null && store.lightThemePreset === preset.id
              : store.darkThemeCustomId === null && store.darkThemePreset === preset.id;
          return (
            <PresetThemeCard
              preset={preset}
              active={active()}
              onSelect={() => {
                if (props.slot === 'light') {
                  setLightTheme(preset.id, null);
                } else {
                  setDarkTheme(preset.id, null);
                }
              }}
              onClone={() => props.onClonePreset(preset.id, preset.label)}
            />
          );
        }}
      </For>
      <For
        each={Object.values(store.customThemes).filter(
          (customTheme) => detectThemeTone(customTheme.vars) === props.slot,
        )}
      >
        {(customTheme) => {
          const active = () =>
            props.slot === 'light'
              ? store.lightThemeCustomId === customTheme.id
              : store.darkThemeCustomId === customTheme.id;
          return (
            <CustomThemeCard
              customTheme={customTheme}
              active={active()}
              onSelect={() => {
                if (props.slot === 'light') {
                  setLightTheme(store.lightThemePreset, customTheme.id);
                } else {
                  setDarkTheme(store.darkThemePreset, customTheme.id);
                }
              }}
              onEdit={() => props.onEditCustom(customTheme.id)}
            />
          );
        }}
      </For>
    </div>
  );
}
