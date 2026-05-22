import { For, Show, Switch, Match, createSignal, createEffect, createUniqueId, on } from 'solid-js';
import { Dialog } from './Dialog';
import { CustomThemeDialog } from './CustomThemeDialog';
import {
  getAvailableTerminalFonts,
  fetchAvailableTerminalFonts,
  getTerminalFontFamily,
  LIGATURE_FONTS,
} from '../lib/fonts';
import { presetsForTone } from '../lib/look';
import type { AppearanceMode } from '../lib/look';
import { theme, sectionLabelStyle, readCssVarsForPreset, terminalBackground } from '../lib/theme';
import { themeToCss, detectThemeTone } from '../lib/custom-theme';
import {
  store,
  setTerminalFont,
  setAutoTrustFolders,
  setShowPlans,
  setShowPromptInput,
  setShowSidebarTips,
  setShowSidebarProgress,
  setFontSmoothing,
  setDesktopNotificationsEnabled,
  setVerboseLogging,
  setInactiveColumnOpacity,
  setEditorCommand,
  setDockerImage,
  setShareDockerAgentAuth,
  setAskCodeProvider,
  setMinimaxApiKey,
  setAppearanceMode,
  setLightTheme,
  setDarkTheme,
  setCoordinatorModeEnabled,
  setCoordinatorNotificationDelayMs,
  updateStatus,
  checkForUpdates,
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

type SettingsTab = 'general' | 'themes' | 'experimental';

export function SettingsDialog(props: SettingsDialogProps) {
  const titleId = createUniqueId();
  const [fonts, setFonts] = createSignal<string[]>(ensureSelectedFont(getAvailableTerminalFonts()));
  const [activeTab, setActiveTab] = createSignal<SettingsTab>('general');
  const [customThemeDialogOpen, setCustomThemeDialogOpen] = createSignal(false);
  const [editingThemeId, setEditingThemeId] = createSignal<string | null>(null);
  const [cloneCss, setCloneCss] = createSignal<string | undefined>(undefined);

  function openCloneDialog(presetId: string, label: string) {
    const vars = readCssVarsForPreset(presetId);
    const bg = terminalBackground[presetId as keyof typeof terminalBackground] ?? '#000000';
    setCloneCss(themeToCss(`${label} (copy)`, '', bg, vars));
    setEditingThemeId(null);
    setCustomThemeDialogOpen(true);
  }

  // Styles shared across the Updates section's rows, buttons and messages.
  const updateRowStyle = {
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'space-between',
    gap: '12px',
  };
  const updateSecondaryButtonStyle = (disabled: boolean) => ({
    padding: '6px 12px',
    'border-radius': '6px',
    border: `1px solid ${theme.border}`,
    background: theme.bgElevated,
    color: theme.fg,
    'font-size': '13px',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? '0.6' : '1',
  });
  const updateMessageStyle = (color: string) => ({ 'font-size': '12px', color });

  // Phases that permit a manual check. An allow-list keeps a future phase
  // from defaulting to "shown" the way excluding non-checkable phases would.
  const canCheckForUpdates = () =>
    ['idle', 'checking', 'up-to-date', 'available', 'error'].includes(updateStatus().phase);

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
      labelledBy={titleId}
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
            id={titleId}
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
          aria-label="Close settings"
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

      <div
        role="tablist"
        aria-label="Settings tabs"
        style={{
          display: 'flex',
          gap: '2px',
          'border-bottom': `1px solid ${theme.border}`,
          'padding-bottom': '0',
          'margin-bottom': '2px',
        }}
      >
        <For each={['general', 'themes', 'experimental'] as SettingsTab[]}>
          {(tab) => (
            <button
              role="tab"
              aria-selected={activeTab() === tab}
              aria-controls={`settings-tab-${tab}`}
              id={`settings-tabbutton-${tab}`}
              type="button"
              onClick={() => setActiveTab(tab)}
              onKeyDown={(e) => {
                const tabs: SettingsTab[] = ['general', 'themes', 'experimental'];
                const idx = tabs.indexOf(tab);
                if (e.key === 'ArrowRight') setActiveTab(tabs[(idx + 1) % tabs.length]);
                else if (e.key === 'ArrowLeft')
                  setActiveTab(tabs[(idx + tabs.length - 1) % tabs.length]);
              }}
              style={{
                background: 'transparent',
                border: 'none',
                'border-bottom':
                  activeTab() === tab ? `2px solid ${theme.accent}` : '2px solid transparent',
                color: activeTab() === tab ? theme.fg : theme.fgMuted,
                cursor: 'pointer',
                'font-size': '14px',
                'font-weight': activeTab() === tab ? '600' : '400',
                padding: '6px 14px',
                'margin-bottom': '-1px',
                'border-radius': '0',
                transition: 'color 0.15s, border-color 0.15s',
              }}
            >
              {tab === 'general' ? 'General' : tab === 'themes' ? 'Themes' : 'Experimental'}
            </button>
          )}
        </For>
      </div>

      <Show when={activeTab() === 'general'}>
        <div
          id="settings-tab-general"
          role="tabpanel"
          aria-labelledby="settings-tabbutton-general"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '18px' }}
        >
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
                checked={store.showSidebarProgress}
                onChange={(e) => setShowSidebarProgress(e.currentTarget.checked)}
                style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
              />
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                <span style={{ 'font-size': '14px', color: theme.fg }}>
                  Show progress section in sidebar
                </span>
                <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
                  Daily completed-task count and merged-line totals at the bottom of the sidebar
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
                checked={store.showSidebarTips}
                onChange={(e) => setShowSidebarTips(e.currentTarget.checked)}
                style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
              />
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                <span style={{ 'font-size': '14px', color: theme.fg }}>
                  Show tips section in sidebar
                </span>
                <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
                  Keyboard shortcut hints at the bottom of the sidebar
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

          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
            <div
              style={{
                ...sectionLabelStyle,
                'font-weight': '600',
              }}
            >
              Ask about Code
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
                <span style={{ 'font-size': '13px', color: theme.fg, 'white-space': 'nowrap' }}>
                  LLM provider
                </span>
                <select
                  value={store.askCodeProvider}
                  onChange={(e) =>
                    setAskCodeProvider(e.currentTarget.value as 'claude' | 'minimax')
                  }
                  style={{
                    flex: '1',
                    background: theme.taskPanelBg,
                    border: `1px solid ${theme.border}`,
                    'border-radius': '6px',
                    padding: '6px 10px',
                    color: theme.fg,
                    'font-size': '13px',
                    outline: 'none',
                    cursor: 'pointer',
                  }}
                >
                  <option value="claude">Claude Code (claude CLI)</option>
                  <option value="minimax">MiniMax (M2.7)</option>
                </select>
              </label>
              <Show when={store.askCodeProvider === 'minimax'}>
                <label
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    gap: '10px',
                    'margin-top': '4px',
                  }}
                >
                  <span style={{ 'font-size': '13px', color: theme.fg, 'white-space': 'nowrap' }}>
                    MiniMax API key
                  </span>
                  <input
                    type="password"
                    onInput={(e) => setMinimaxApiKey(e.currentTarget.value)}
                    placeholder="Enter your MINIMAX_API_KEY (stored in memory only)"
                    style={{
                      flex: '1',
                      background: theme.taskPanelBg,
                      border: `1px solid ${theme.border}`,
                      'border-radius': '6px',
                      padding: '6px 10px',
                      color: theme.fg,
                      'font-size': '13px',
                      'font-family': "'JetBrains Mono', monospace",
                      outline: 'none',
                    }}
                  />
                </label>
              </Show>
              <span style={{ 'font-size': '11px', color: theme.fgSubtle }}>
                {store.askCodeProvider === 'minimax'
                  ? 'Uses MiniMax M2.7 (204K context) via the OpenAI-compatible API — no Claude Code CLI required.'
                  : 'Uses the claude CLI to answer questions about selected code. Requires Claude Code to be installed.'}
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
                  Docker image used when "Run in Docker container" is enabled for a task. The agent
                  runs inside the container with only the project directory mounted.
                </span>
                <div style={{ 'font-size': '11px', color: theme.fgMuted, 'margin-top': '4px' }}>
                  Projects with a{' '}
                  <code
                    style={{ 'font-family': "'JetBrains Mono', monospace", 'font-size': '11px' }}
                  >
                    {PROJECT_DOCKERFILE_RELATIVE_PATH}
                  </code>{' '}
                  will use a project-specific image instead.
                </div>
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
                  checked={store.shareDockerAgentAuth}
                  onChange={(e) => setShareDockerAgentAuth(e.currentTarget.checked)}
                  style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
                />
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                  <span style={{ 'font-size': '14px', color: theme.fg }}>
                    Share agent auth across Linux containers
                  </span>
                  <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
                    Persist agent credentials in a user-owned host directory so you only need to
                    sign in once per agent type. Auth on first run is saved automatically for future
                    containers.
                  </span>
                </div>
              </label>
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
                <span style={{ 'font-size': '14px', color: theme.fg }}>
                  Inactive column opacity
                </span>
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

          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
            <div style={{ ...sectionLabelStyle, 'font-weight': '600' }}>Diagnostics</div>
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
                checked={store.verboseLogging}
                onChange={(e) => setVerboseLogging(e.currentTarget.checked)}
                style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
              />
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                <span style={{ 'font-size': '14px', color: theme.fg }}>Verbose logging</span>
                <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
                  Emit debug-level logs to the developer console. Verbose logs may include file
                  paths, branch names, commit messages, IPC channel activity, and pty lifecycle
                  events. Review the contents before sharing.
                </span>
              </div>
            </label>
          </div>

          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
            <div style={{ ...sectionLabelStyle, 'font-weight': '600' }}>Updates</div>
            <div
              style={{
                display: 'flex',
                'flex-direction': 'column',
                gap: '10px',
                padding: '12px',
                'border-radius': '8px',
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
              }}
            >
              <div style={updateRowStyle}>
                <span style={{ 'font-size': '14px', color: theme.fg }}>
                  Current version
                  <Show when={updateStatus().currentVersion}>
                    {' '}
                    <span style={{ color: theme.fgMuted }}>v{updateStatus().currentVersion}</span>
                  </Show>
                </span>
                <Show when={canCheckForUpdates()}>
                  <button
                    type="button"
                    disabled={updateStatus().phase === 'checking'}
                    onClick={() => void checkForUpdates()}
                    style={updateSecondaryButtonStyle(updateStatus().phase === 'checking')}
                  >
                    {updateStatus().phase === 'checking' ? 'Checking…' : 'Check for updates'}
                  </button>
                </Show>
              </div>

              <Switch>
                <Match when={updateStatus().phase === 'unsupported'}>
                  <span style={updateMessageStyle(theme.fgSubtle)}>
                    Automatic updates are not available for this build. Download the latest release
                    from GitHub to update.
                  </span>
                </Match>

                <Match when={updateStatus().phase === 'up-to-date'}>
                  <span style={updateMessageStyle(theme.fgSubtle)}>
                    You are on the latest version.
                  </span>
                </Match>

                <Match when={updateStatus().phase === 'available'}>
                  <span style={updateMessageStyle(theme.fg)}>
                    Version {updateStatus().latestVersion} is available. Use the update button in
                    the sidebar to install.
                  </span>
                </Match>

                <Match when={updateStatus().phase === 'downloading'}>
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
                    <span style={updateMessageStyle(theme.fgSubtle)}>
                      Downloading update… {updateStatus().downloadPercent}%
                    </span>
                    <div
                      style={{
                        height: '6px',
                        'border-radius': '3px',
                        background: theme.bgElevated,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${updateStatus().downloadPercent}%`,
                          background: theme.accent,
                          transition: 'width 0.2s',
                        }}
                      />
                    </div>
                  </div>
                </Match>

                <Match when={updateStatus().phase === 'downloaded'}>
                  <span style={updateMessageStyle(theme.fg)}>
                    Version {updateStatus().latestVersion} is downloaded. Use the update button in
                    the sidebar to restart &amp; install.
                  </span>
                </Match>

                <Match when={updateStatus().phase === 'error'}>
                  <span style={updateMessageStyle(theme.error)}>
                    Update check failed: {updateStatus().error}
                  </span>
                </Match>
              </Switch>
            </div>
          </div>
        </div>
      </Show>

      <Show when={activeTab() === 'themes'}>
        <div
          id="settings-tab-themes"
          role="tabpanel"
          aria-labelledby="settings-tabbutton-themes"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '18px' }}
        >
          {/* Appearance mode selector */}
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
            <div style={{ ...sectionLabelStyle, 'font-weight': '600' }}>Appearance</div>
            <div
              style={{
                display: 'flex',
                gap: '4px',
                background: theme.bgInput,
                border: `1px solid ${theme.border}`,
                'border-radius': '8px',
                padding: '4px',
              }}
            >
              <For each={['light', 'dark', 'system'] as AppearanceMode[]}>
                {(mode) => (
                  <button
                    type="button"
                    style={{
                      flex: '1',
                      padding: '6px',
                      'border-radius': '6px',
                      border: 'none',
                      background: store.appearanceMode === mode ? theme.bgElevated : 'transparent',
                      color: store.appearanceMode === mode ? theme.fg : theme.fgMuted,
                      cursor: 'pointer',
                      'font-size': '13px',
                      'font-weight': store.appearanceMode === mode ? '600' : '400',
                      transition: 'background 0.15s, color 0.15s',
                    }}
                    onClick={() => setAppearanceMode(mode)}
                  >
                    {mode === 'light' ? 'Light' : mode === 'dark' ? 'Dark' : 'System'}
                  </button>
                )}
              </For>
            </div>
          </div>

          {/* Theme section header with Create New button */}
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
            }}
          >
            <div style={{ ...sectionLabelStyle, 'font-weight': '600' }}>Themes</div>
            <button
              type="button"
              onClick={() => {
                setCloneCss(undefined);
                setEditingThemeId(null);
                setCustomThemeDialogOpen(true);
              }}
              style={{
                background: theme.accent,
                border: 'none',
                color: theme.accentText,
                cursor: 'pointer',
                'font-size': '12px',
                'font-weight': '600',
                padding: '4px 12px',
                'border-radius': '5px',
              }}
            >
              + Create New
            </button>
          </div>

          {/* Single mode (Light or Dark): built-ins + matching custom themes in one grid */}
          <Show when={store.appearanceMode !== 'system'}>
            <div class="settings-theme-grid">
              <For each={presetsForTone(store.appearanceMode as 'light' | 'dark')}>
                {(preset) => {
                  const isActive = () =>
                    store.appearanceMode === 'light'
                      ? store.lightThemeCustomId === null && store.lightThemePreset === preset.id
                      : store.darkThemeCustomId === null && store.darkThemePreset === preset.id;
                  return (
                    <div style={{ position: 'relative' }}>
                      <button
                        type="button"
                        class={`settings-theme-card${isActive() ? ' active' : ''}`}
                        onClick={() => {
                          if (store.appearanceMode === 'light') {
                            setLightTheme(preset.id, null);
                          } else {
                            setDarkTheme(preset.id, null);
                          }
                        }}
                      >
                        <span class="settings-theme-title">{preset.label}</span>
                        <span class="settings-theme-desc">{preset.description}</span>
                      </button>
                      <button
                        type="button"
                        title="Clone as custom theme"
                        onClick={(e) => {
                          e.stopPropagation();
                          openCloneDialog(preset.id, preset.label);
                        }}
                        style={{
                          position: 'absolute',
                          top: '4px',
                          right: '4px',
                          background: theme.bgElevated,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '4px',
                          color: theme.fgMuted,
                          cursor: 'pointer',
                          'font-size': '10px',
                          padding: '2px 6px',
                          opacity: '0',
                          transition: 'opacity 0.15s',
                        }}
                        class="preset-clone-btn"
                      >
                        Clone
                      </button>
                    </div>
                  );
                }}
              </For>
              <For
                each={Object.values(store.customThemes).filter(
                  (ct) => detectThemeTone(ct.vars) === store.appearanceMode,
                )}
              >
                {(ct) => {
                  const isActive = () =>
                    store.appearanceMode === 'light'
                      ? store.lightThemeCustomId === ct.id
                      : store.darkThemeCustomId === ct.id;
                  return (
                    <div style={{ position: 'relative' }}>
                      <button
                        type="button"
                        class={`settings-theme-card${isActive() ? ' active' : ''}`}
                        onClick={() => {
                          if (store.appearanceMode === 'light') {
                            setLightTheme(store.lightThemePreset, ct.id);
                          } else {
                            setDarkTheme(store.darkThemePreset, ct.id);
                          }
                        }}
                      >
                        <span class="settings-theme-title">{ct.name}</span>
                        <span class="settings-theme-desc">{ct.description || 'Custom theme'}</span>
                      </button>
                      <button
                        type="button"
                        title="Edit custom theme"
                        onClick={(e) => {
                          e.stopPropagation();
                          setCloneCss(undefined);
                          setEditingThemeId(ct.id);
                          setCustomThemeDialogOpen(true);
                        }}
                        style={{
                          position: 'absolute',
                          top: '4px',
                          right: '4px',
                          background: theme.bgElevated,
                          border: `1px solid ${theme.border}`,
                          'border-radius': '4px',
                          color: theme.fgMuted,
                          cursor: 'pointer',
                          'font-size': '10px',
                          padding: '2px 6px',
                          opacity: '0',
                          transition: 'opacity 0.15s',
                        }}
                        class="preset-clone-btn"
                      >
                        Edit
                      </button>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>

          {/* System mode: dual grids, each with built-ins + tone-matching custom themes */}
          <Show when={store.appearanceMode === 'system'}>
            <For each={['dark', 'light'] as const}>
              {(slot) => (
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
                  <div style={{ ...sectionLabelStyle, 'font-weight': '600' }}>
                    {slot === 'dark' ? 'Dark Theme' : 'Light Theme'}
                  </div>
                  <div class="settings-theme-grid">
                    <For each={presetsForTone(slot)}>
                      {(preset) => {
                        const isActive = () =>
                          slot === 'light'
                            ? store.lightThemeCustomId === null &&
                              store.lightThemePreset === preset.id
                            : store.darkThemeCustomId === null &&
                              store.darkThemePreset === preset.id;
                        return (
                          <div style={{ position: 'relative' }}>
                            <button
                              type="button"
                              class={`settings-theme-card${isActive() ? ' active' : ''}`}
                              onClick={() => {
                                if (slot === 'light') {
                                  setLightTheme(preset.id, null);
                                } else {
                                  setDarkTheme(preset.id, null);
                                }
                              }}
                            >
                              <span class="settings-theme-title">{preset.label}</span>
                              <span class="settings-theme-desc">{preset.description}</span>
                            </button>
                            <button
                              type="button"
                              title="Clone as custom theme"
                              onClick={(e) => {
                                e.stopPropagation();
                                openCloneDialog(preset.id, preset.label);
                              }}
                              style={{
                                position: 'absolute',
                                top: '4px',
                                right: '4px',
                                background: theme.bgElevated,
                                border: `1px solid ${theme.border}`,
                                'border-radius': '4px',
                                color: theme.fgMuted,
                                cursor: 'pointer',
                                'font-size': '10px',
                                padding: '2px 6px',
                                opacity: '0',
                                transition: 'opacity 0.15s',
                              }}
                              class="preset-clone-btn"
                            >
                              Clone
                            </button>
                          </div>
                        );
                      }}
                    </For>
                    <For
                      each={Object.values(store.customThemes).filter(
                        (ct) => detectThemeTone(ct.vars) === slot,
                      )}
                    >
                      {(ct) => {
                        const isActive = () =>
                          slot === 'light'
                            ? store.lightThemeCustomId === ct.id
                            : store.darkThemeCustomId === ct.id;
                        return (
                          <div style={{ position: 'relative' }}>
                            <button
                              type="button"
                              class={`settings-theme-card${isActive() ? ' active' : ''}`}
                              onClick={() => {
                                if (slot === 'light') {
                                  setLightTheme(store.lightThemePreset, ct.id);
                                } else {
                                  setDarkTheme(store.darkThemePreset, ct.id);
                                }
                              }}
                            >
                              <span class="settings-theme-title">{ct.name}</span>
                              <span class="settings-theme-desc">
                                {ct.description || 'Custom theme'}
                              </span>
                            </button>
                            <button
                              type="button"
                              title="Edit custom theme"
                              onClick={(e) => {
                                e.stopPropagation();
                                setCloneCss(undefined);
                                setEditingThemeId(ct.id);
                                setCustomThemeDialogOpen(true);
                              }}
                              style={{
                                position: 'absolute',
                                top: '4px',
                                right: '4px',
                                background: theme.bgElevated,
                                border: `1px solid ${theme.border}`,
                                'border-radius': '4px',
                                color: theme.fgMuted,
                                cursor: 'pointer',
                                'font-size': '10px',
                                padding: '2px 6px',
                                opacity: '0',
                                transition: 'opacity 0.15s',
                              }}
                              class="preset-clone-btn"
                            >
                              Edit
                            </button>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>

      <CustomThemeDialog
        open={customThemeDialogOpen()}
        editId={editingThemeId()}
        initialCss={cloneCss()}
        onClose={() => setCustomThemeDialogOpen(false)}
      />

      <Show when={activeTab() === 'experimental'}>
        <div
          id="settings-tab-experimental"
          role="tabpanel"
          aria-labelledby="settings-tabbutton-experimental"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '18px' }}
        >
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
            <div style={{ ...sectionLabelStyle, 'font-weight': '600' }}>Coordinator</div>
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
                checked={store.coordinatorModeEnabled}
                onChange={(e) => setCoordinatorModeEnabled(e.currentTarget.checked)}
                style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
              />
              <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
                <span style={{ 'font-size': '14px', color: theme.fg }}>Coordinator mode</span>
                <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
                  Enable the Coordinator option when creating tasks. Coordinators can spawn
                  sub-tasks, send prompts, and merge branches automatically via MCP tools. Requires
                  app restart to fully disable.
                </span>
              </div>
            </label>
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
                  Coordinator notification delay (seconds)
                </span>
                <input
                  type="number"
                  min="5"
                  max="300"
                  step="5"
                  value={Math.round(store.coordinatorNotificationDelayMs / 1000)}
                  onInput={(e) => {
                    const seconds = Number(e.currentTarget.value);
                    if (Number.isFinite(seconds)) {
                      setCoordinatorNotificationDelayMs(seconds * 1000);
                    }
                  }}
                  style={{
                    width: '80px',
                    background: theme.taskPanelBg,
                    border: `1px solid ${theme.border}`,
                    'border-radius': '6px',
                    padding: '6px 10px',
                    color: theme.fg,
                    'font-size': '14px',
                    'font-family': "'JetBrains Mono', monospace",
                    outline: 'none',
                    'text-align': 'right',
                  }}
                />
              </label>
              <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
                How long the coordinator waits before firing a notification after a sub-task
                completes. Default: 60s. Failed sub-tasks use max(10s, delay ÷ 4).
              </span>
            </div>
          </div>
        </div>
      </Show>
    </Dialog>
  );
}
