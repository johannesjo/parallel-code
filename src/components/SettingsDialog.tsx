import { For, Show, createSignal, createEffect, on } from 'solid-js';
import { Dialog } from './Dialog';
import {
  getAvailableTerminalFonts,
  fetchAvailableTerminalFonts,
  getTerminalFontFamily,
  LIGATURE_FONTS,
} from '../lib/fonts';
import { LOOK_PRESETS } from '../lib/look';
import { theme, sectionLabelStyle } from '../lib/theme';
import {
  store,
  setTerminalFont,
  setThemePreset,
  setAutoTrustFolders,
  setShowPlans,
  setShowPromptInput,
  setFontSmoothing,
  setDesktopNotificationsEnabled,
  setInactiveColumnOpacity,
  setEditorCommand,
  setDockerImage,
} from '../store/store';
import { CustomAgentEditor } from './CustomAgentEditor';
import { mod } from '../lib/platform';
import { DEFAULT_DOCKER_IMAGE, PROJECT_DOCKERFILE_RELATIVE_PATH } from '../lib/docker';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

function ensureSelectedFont(available: string[]): string[] {
  if (available.includes(store.terminalFont)) return available;
  return [store.terminalFont, ...available];
}

export function SettingsDialog(props: SettingsDialogProps) {
  const [fonts, setFonts] = createSignal<string[]>(ensureSelectedFont(getAvailableTerminalFonts()));

  // Fetch system fonts when the dialog opens
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) {
          fetchAvailableTerminalFonts().then((available) =>
            setFonts(ensureSelectedFont(available)),
          );
        }
      },
    ),
  );

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width="640px"
      zIndex={1100}
      panelStyle={{ 'max-width': 'calc(100vw - 32px)', padding: '24px', gap: '18px' }}
    >
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
        }}
      >
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
          <h2
            style={{
              margin: '0',
              'font-size': '17px',
              color: theme.fg,
              'font-weight': '600',
            }}
          >
            Settings
          </h2>
          <span style={{ 'font-size': '13px', color: theme.fgSubtle }}>
            Customize your workspace. Shortcut:{' '}
            <kbd
              style={{
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': '4px',
                padding: '1px 6px',
                'font-family': "'JetBrains Mono', monospace",
                color: theme.fgMuted,
              }}
            >
              {mod}+,
            </kbd>
          </span>
        </div>
        <button
          onClick={() => props.onClose()}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-size': '19px',
            padding: '0 4px',
            'line-height': '1',
          }}
        >
          &times;
        </button>
      </div>

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
        <div
          style={{
            ...sectionLabelStyle,
            'font-weight': '600',
          }}
        >
          Theme
        </div>
        <div class="settings-theme-grid">
          <For each={LOOK_PRESETS}>
            {(preset) => (
              <button
                type="button"
                class={`settings-theme-card${store.themePreset === preset.id ? ' active' : ''}`}
                onClick={() => setThemePreset(preset.id)}
              >
                <span class="settings-theme-title">{preset.label}</span>
                <span class="settings-theme-desc">{preset.description}</span>
              </button>
            )}
          </For>
        </div>
      </div>

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
        <div
          style={{
            ...sectionLabelStyle,
            'font-weight': '600',
          }}
        >
          Behavior
        </div>
        <label
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '10px',
            cursor: 'pointer',
            padding: '8px 12px',
            'border-radius': '8px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
          }}
        >
          <input
            type="checkbox"
            checked={store.autoTrustFolders}
            onChange={(e) => setAutoTrustFolders(e.currentTarget.checked)}
            style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
          />
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
            <span style={{ 'font-size': '14px', color: theme.fg }}>Auto-trust folders</span>
            <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
              Automatically accept trust and permission dialogs from agents
            </span>
          </div>
        </label>
        <label
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '10px',
            cursor: 'pointer',
            padding: '8px 12px',
            'border-radius': '8px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
          }}
        >
          <input
            type="checkbox"
            checked={store.showPlans}
            onChange={(e) => setShowPlans(e.currentTarget.checked)}
            style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
          />
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
            <span style={{ 'font-size': '14px', color: theme.fg }}>Show plans</span>
            <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
              Display Claude Code plan files in a tab next to Notes
            </span>
          </div>
        </label>
        <label
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '10px',
            cursor: 'pointer',
            padding: '8px 12px',
            'border-radius': '8px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
          }}
        >
          <input
            type="checkbox"
            checked={store.desktopNotificationsEnabled}
            onChange={(e) => setDesktopNotificationsEnabled(e.currentTarget.checked)}
            style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
          />
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
            <span style={{ 'font-size': '14px', color: theme.fg }}>Desktop notifications</span>
            <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
              Show native notifications when tasks finish or need attention
            </span>
          </div>
        </label>
        <label
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '10px',
            cursor: 'pointer',
            padding: '8px 12px',
            'border-radius': '8px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
          }}
        >
          <input
            type="checkbox"
            checked={store.showPromptInput}
            onChange={(e) => setShowPromptInput(e.currentTarget.checked)}
            style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
          />
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
            <span style={{ 'font-size': '14px', color: theme.fg }}>
              Show prompt input box below terminal
            </span>
            <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
              When hidden, the terminal occupies the full panel and auto-focuses on activation
            </span>
          </div>
        </label>
        <label
          style={{
            display: 'flex',
            'align-items': 'flex-start',
            gap: '10px',
            cursor: 'pointer',
            padding: '8px 12px',
            'border-radius': '8px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
          }}
        >
          <input
            type="checkbox"
            checked={store.fontSmoothing}
            onChange={(e) => setFontSmoothing(e.currentTarget.checked)}
            style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
          />
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
            <span style={{ 'font-size': '14px', color: theme.fg }}>Font smoothing</span>
            <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
              Enable antialiasing and geometric text rendering
            </span>
          </div>
        </label>
      </div>

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
        <div
          style={{
            ...sectionLabelStyle,
            'font-weight': '600',
          }}
        >
          Editor
        </div>
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '6px',
            padding: '8px 12px',
            'border-radius': '8px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
          }}
        >
          <label
            style={{
              display: 'flex',
              'align-items': 'center',
              gap: '10px',
            }}
          >
            <span style={{ 'font-size': '14px', color: theme.fg, 'white-space': 'nowrap' }}>
              Editor command
            </span>
            <input
              type="text"
              value={store.editorCommand}
              onInput={(e) => setEditorCommand(e.currentTarget.value)}
              placeholder="e.g. code, cursor, zed, subl"
              style={{
                flex: '1',
                background: theme.taskPanelBg,
                border: `1px solid ${theme.border}`,
                'border-radius': '6px',
                padding: '6px 10px',
                color: theme.fg,
                'font-size': '14px',
                'font-family': "'JetBrains Mono', monospace",
                outline: 'none',
              }}
            />
          </label>
          <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
            CLI command to open worktree folders. Click the path bar in a task to open it.
          </span>
        </div>
      </div>

      <Show when={store.dockerAvailable}>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
          <div
            style={{
              'font-size': '12px',
              color: theme.fgMuted,
              'text-transform': 'uppercase',
              'letter-spacing': '0.05em',
              'font-weight': '600',
            }}
          >
            Docker Isolation
          </div>
          <div
            style={{
              display: 'flex',
              'flex-direction': 'column',
              gap: '6px',
              padding: '8px 12px',
              'border-radius': '8px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
            }}
          >
            <label
              style={{
                display: 'flex',
                'align-items': 'center',
                gap: '10px',
              }}
            >
              <span style={{ 'font-size': '14px', color: theme.fg, 'white-space': 'nowrap' }}>
                Default image
              </span>
              <input
                type="text"
                value={store.dockerImage}
                onInput={(e) => setDockerImage(e.currentTarget.value)}
                placeholder={DEFAULT_DOCKER_IMAGE}
                style={{
                  flex: '1',
                  background: theme.taskPanelBg,
                  border: `1px solid ${theme.border}`,
                  'border-radius': '6px',
                  padding: '6px 10px',
                  color: theme.fg,
                  'font-size': '14px',
                  'font-family': "'JetBrains Mono', monospace",
                  outline: 'none',
                }}
              />
            </label>
            <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
              Docker image used when "Run in Docker container" is enabled for a task. The agent runs
              inside the container with only the project directory mounted.
            </span>
            <div style={{ 'font-size': '11px', color: theme.fgMuted, 'margin-top': '4px' }}>
              Projects with a{' '}
              <code style={{ 'font-family': "'JetBrains Mono', monospace", 'font-size': '11px' }}>
                {PROJECT_DOCKERFILE_RELATIVE_PATH}
              </code>{' '}
              will use a project-specific image instead.
            </div>
          </div>
        </div>
      </Show>

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
        <div
          style={{
            ...sectionLabelStyle,
            'font-weight': '600',
          }}
        >
          Focus Dimming
        </div>
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            gap: '8px',
            padding: '8px 12px',
            'border-radius': '8px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
          }}
        >
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
            }}
          >
            <span style={{ 'font-size': '14px', color: theme.fg }}>Inactive column opacity</span>
            <span
              style={{
                'font-size': '13px',
                color: theme.fgMuted,
                'font-family': "'JetBrains Mono', monospace",
                'min-width': '36px',
                'text-align': 'right',
              }}
            >
              {Math.round(store.inactiveColumnOpacity * 100)}%
            </span>
          </div>
          <input
            type="range"
            min="30"
            max="100"
            step="5"
            value={store.inactiveColumnOpacity * 100}
            onInput={(e) => setInactiveColumnOpacity(Number(e.currentTarget.value) / 100)}
            style={{
              width: '100%',
              'accent-color': theme.accent,
              cursor: 'pointer',
            }}
          />
          <div
            style={{
              display: 'flex',
              'justify-content': 'space-between',
              'font-size': '11px',
              color: theme.fgSubtle,
            }}
          >
            <span>More dimmed</span>
            <span>No dimming</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
        <div
          style={{
            ...sectionLabelStyle,
            'font-weight': '600',
          }}
        >
          Custom Agents
        </div>
        <CustomAgentEditor />
      </div>

      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
        <div
          style={{
            ...sectionLabelStyle,
            'font-weight': '600',
          }}
        >
          Terminal Font
        </div>
        <div class="settings-font-grid">
          <For each={fonts()}>
            {(font) => (
              <button
                type="button"
                class={`settings-font-card${store.terminalFont === font ? ' active' : ''}`}
                onClick={() => setTerminalFont(font)}
              >
                <span class="settings-font-name">{font}</span>
                <span
                  class="settings-font-preview"
                  style={{ 'font-family': getTerminalFontFamily(font) }}
                >
                  AaBb 0Oo1Il →
                </span>
              </button>
            )}
          </For>
        </div>
        <Show when={LIGATURE_FONTS.has(store.terminalFont)}>
          <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
            This font includes ligatures which may impact rendering performance.
          </span>
        </Show>
      </div>
    </Dialog>
  );
}
