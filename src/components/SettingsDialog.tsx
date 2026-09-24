import { For, Show, Switch, Match, createSignal, createEffect, createUniqueId, on } from 'solid-js';
import type { JSX } from 'solid-js';
import { Dialog } from './Dialog';
import {
  ASK_CODE_CLAUDE_MODELS,
  type AskCodeProvider,
} from '../../electron/shared/ask-code-models';
import { codexModels, loadCodexModels } from '../lib/codex-models';
import { CustomThemeDialog } from './CustomThemeDialog';
import {
  getAvailableTerminalFonts,
  fetchAvailableTerminalFonts,
  getTerminalFontFamily,
  LIGATURE_FONTS,
} from '../lib/fonts';
import { presetsForTone } from '../lib/look';
import type { AppearanceMode } from '../lib/look';
import { theme, sectionLabelStyle, readCssVarsForPreset } from '../lib/theme';
import { themeToCss, detectThemeTone } from '../lib/custom-theme';
import {
  store,
  setTerminalFont,
  setTerminalScreenReaderMode,
  setAutoTrustFolders,
  setShowPlans,
  setShowPromptInput,
  setShowSidebarTips,
  setShowSidebarProgress,
  setSidebarNeedsInputFirst,
  setFontSmoothing,
  setDesktopNotificationsEnabled,
  setVerboseLogging,
  setInactiveColumnOpacity,
  setEditorCommand,
  setDockerImage,
  setShareDockerAgentAuth,
  setAskCodeProvider,
  setAskCodeModel,
  setMinimaxApiKey,
  setAppearanceMode,
  setLightTheme,
  setDarkTheme,
  setMcpOrchestrationEnabled,
  setDocumentWorkspacesEnabled,
  setCoordinatorNotificationDelayMs,
  setDefaultStepsEnabled,
  setDefaultSkipPermissions,
  setCanvasOwnershipBadges,
  setDefaultPropagateSkipPermissions,
  updateStatus,
  checkForUpdates,
} from '../store/store';
import { CustomAgentEditor } from './CustomAgentEditor';
import { AgentEnvFileEditor } from './AgentEnvFileEditor';
import { SuperProductivitySettings } from './SuperProductivitySettings';
import { mod } from '../lib/platform';
import { DEFAULT_COORDINATOR_CONCURRENT_TASKS } from '../lib/coordinator-limits';
import { DEFAULT_DOCKER_IMAGE, PROJECT_DOCKERFILE_RELATIVE_PATH } from '../lib/docker';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

function ensureSelectedFont(available: string[]): string[] {
  if (available.includes(store.terminalFont)) return available;
  return [store.terminalFont, ...available];
}

/** What each code Q&A provider needs installed, for the row under the select. */
const ASK_CODE_PROVIDER_HINTS: Record<AskCodeProvider, string> = {
  claude:
    'Uses the claude CLI to answer questions about selected code. Requires Claude Code to be installed.',
  codex:
    'Uses the codex CLI (codex exec, read-only sandbox) to answer questions about selected code. Requires Codex to be installed.',
  minimax:
    'Uses MiniMax M2.7 (204K context) via the OpenAI-compatible API — no Claude Code CLI required.',
};

type SettingsTab = 'general' | 'themes' | 'mcp' | 'experimental';
type ThemeSlot = 'light' | 'dark';

function SettingsSection(props: { title: string; children: JSX.Element }) {
  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
      <div style={{ ...sectionLabelStyle, 'font-weight': '600' }}>{props.title}</div>
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
        cursor: 'pointer',
        padding: '8px 12px',
        'border-radius': 'var(--radius-md)',
        background: theme.bgInput,
        border: `1px solid ${theme.border}`,
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
        style={{ 'accent-color': theme.accent, cursor: 'pointer' }}
      />
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px' }}>
        <span style={{ 'font-size': '14px', color: theme.fg }}>{props.label}</span>
        <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>{props.description}</span>
      </div>
    </label>
  );
}

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
        <span class="settings-theme-title">{props.preset.label}</span>
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
        class="preset-clone-btn"
      >
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
        class="preset-clone-btn"
      >
        Edit
      </button>
    </div>
  );
}

function ThemeGrid(props: {
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

export function SettingsDialog(props: SettingsDialogProps) {
  const titleId = createUniqueId();
  const [fonts, setFonts] = createSignal<string[]>(ensureSelectedFont(getAvailableTerminalFonts()));
  const [activeTab, setActiveTab] = createSignal<SettingsTab>('general');
  const [customThemeDialogOpen, setCustomThemeDialogOpen] = createSignal(false);
  const [editingThemeId, setEditingThemeId] = createSignal<string | null>(null);
  const [cloneCss, setCloneCss] = createSignal<string | undefined>(undefined);
  const [savingMcpSetting, setSavingMcpSetting] = createSignal(false);
  const [mcpSettingError, setMcpSettingError] = createSignal<string | null>(null);

  async function changeMcpOrchestration(enabled: boolean) {
    setSavingMcpSetting(true);
    setMcpSettingError(null);
    try {
      await setMcpOrchestrationEnabled(enabled);
    } catch (error) {
      setMcpSettingError(`Could not change agent orchestration: ${String(error)}`);
    } finally {
      setSavingMcpSetting(false);
    }
  }

  function openCloneDialog(presetId: string, label: string) {
    const vars = readCssVarsForPreset(presetId);
    const bg = vars['--task-panel-bg'] ?? '#000000';
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
    'border-radius': 'var(--radius-sm)',
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

  // The Codex model select is filled from the CLI's cache, read on first need.
  createEffect(() => {
    if (props.open && store.askCodeProvider === 'codex') loadCodexModels();
  });

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
                'border-radius': 'var(--radius-xs)',
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
        <For each={['general', 'themes', 'mcp', 'experimental'] as SettingsTab[]}>
          {(tab) => (
            <button
              role="tab"
              aria-selected={activeTab() === tab}
              aria-controls={`settings-tab-${tab}`}
              id={`settings-tabbutton-${tab}`}
              type="button"
              onClick={() => setActiveTab(tab)}
              onKeyDown={(e) => {
                const tabs: SettingsTab[] = ['general', 'themes', 'mcp', 'experimental'];
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
              {tab === 'general'
                ? 'General'
                : tab === 'themes'
                  ? 'Themes'
                  : tab === 'mcp'
                    ? 'MCP'
                    : 'Experimental'}
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
          <SettingsSection title="Behavior">
            <SettingsCheckboxRow
              label="Auto-trust folders"
              checked={store.autoTrustFolders}
              onChange={setAutoTrustFolders}
              description="Automatically accept trust and permission dialogs from agents"
            />
            <SettingsCheckboxRow
              label="Show plans"
              checked={store.showPlans}
              onChange={setShowPlans}
              description="Show a Review Plan button in Notes when a plan file is available"
            />
            <SettingsCheckboxRow
              label="Show ownership badges on canvases"
              checked={store.canvasOwnershipBadges}
              onChange={setCanvasOwnershipBadges}
              description="Mark nodes you edited on mind maps and reasoning graphs; agents leave those alone until you release them"
            />
            <SettingsCheckboxRow
              label="Desktop notifications"
              checked={store.desktopNotificationsEnabled}
              onChange={setDesktopNotificationsEnabled}
              description="Show native notifications when tasks finish or need attention"
            />
            <SettingsCheckboxRow
              label="Show prompt input box below terminal"
              checked={store.showPromptInput}
              onChange={setShowPromptInput}
              description="When hidden, the terminal occupies the full panel and auto-focuses on activation"
            />
            <SettingsCheckboxRow
              label="Pin tasks that need input to the top of the sidebar"
              checked={store.sidebarNeedsInputFirst}
              onChange={setSidebarNeedsInputFirst}
              description="Tasks waiting on an answer appear directly under New Task, most recent question first"
            />
            <SettingsCheckboxRow
              label="Show progress section in sidebar"
              checked={store.showSidebarProgress}
              onChange={setShowSidebarProgress}
              description="Daily completed-task count and merged-line totals at the bottom of the sidebar"
            />
            <SettingsCheckboxRow
              label="Show tips section in sidebar"
              checked={store.showSidebarTips}
              onChange={setShowSidebarTips}
              description="Keyboard shortcut hints at the bottom of the sidebar"
            />
            <SettingsCheckboxRow
              label="Font smoothing"
              checked={store.fontSmoothing}
              onChange={setFontSmoothing}
              description="Enable antialiasing and geometric text rendering"
              align="flex-start"
            />
            <SettingsCheckboxRow
              label="Terminal screen reader mode"
              checked={store.terminalScreenReaderMode}
              onChange={setTerminalScreenReaderMode}
              description="Expose terminal output to assistive technologies. May reduce rendering performance."
              align="flex-start"
            />
          </SettingsSection>

          <SettingsSection title="New Task Defaults">
            <SettingsCheckboxRow
              label="Steps tracking"
              checked={store.defaultStepsEnabled}
              onChange={setDefaultStepsEnabled}
              description="Pre-tick Steps tracking in the New Task dialog"
            />
            <SettingsCheckboxRow
              label="Dangerously skip all confirms by default"
              checked={store.defaultSkipPermissions}
              onChange={setDefaultSkipPermissions}
              description="Pre-tick skip-permissions for every new task. The agent will run without asking for confirmation. Only honoured when the selected agent supports it."
            />
            <Show when={store.mcpOrchestrationEnabled}>
              <SettingsCheckboxRow
                label="Propagate skip-permissions to sub-tasks"
                checked={store.defaultPropagateSkipPermissions}
                onChange={setDefaultPropagateSkipPermissions}
                description="Pre-tick Propagate to sub-tasks when skip-permissions are enabled for an eligible worktree task"
              />
            </Show>
          </SettingsSection>

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
                'border-radius': 'var(--radius-md)',
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
                    'border-radius': 'var(--radius-sm)',
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
                'border-radius': 'var(--radius-md)',
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
                  onChange={(e) => setAskCodeProvider(e.currentTarget.value as AskCodeProvider)}
                  style={{
                    flex: '1',
                    background: theme.taskPanelBg,
                    border: `1px solid ${theme.border}`,
                    'border-radius': 'var(--radius-sm)',
                    padding: '6px 10px',
                    color: theme.fg,
                    'font-size': '13px',
                    outline: 'none',
                    cursor: 'pointer',
                  }}
                >
                  <option value="claude">Claude Code (claude CLI)</option>
                  <option value="codex">Codex (codex CLI)</option>
                  <option value="minimax">MiniMax (M2.7)</option>
                </select>
              </label>
              <Show when={store.askCodeProvider !== 'minimax'}>
                <label style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
                  <span style={{ 'font-size': '13px', color: theme.fg, 'white-space': 'nowrap' }}>
                    Model
                  </span>
                  <select
                    value={store.askCodeModel}
                    onChange={(e) => setAskCodeModel(e.currentTarget.value)}
                    style={{
                      flex: '1',
                      background: theme.taskPanelBg,
                      border: `1px solid ${theme.border}`,
                      'border-radius': 'var(--radius-sm)',
                      padding: '6px 10px',
                      color: theme.fg,
                      'font-size': '13px',
                      outline: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    <Show
                      when={store.askCodeProvider === 'codex'}
                      fallback={
                        <For each={ASK_CODE_CLAUDE_MODELS}>
                          {(model) => <option value={model}>{model}</option>}
                        </For>
                      }
                    >
                      {/* Empty keeps whatever model the codex CLI defaults to. */}
                      <option value="">CLI default</option>
                      <For each={codexModels()}>
                        {(model) => <option value={model.slug}>{model.displayName}</option>}
                      </For>
                    </Show>
                  </select>
                </label>
              </Show>
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
                      'border-radius': 'var(--radius-sm)',
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
                {ASK_CODE_PROVIDER_HINTS[store.askCodeProvider]}
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
                  'border-radius': 'var(--radius-md)',
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
                      'border-radius': 'var(--radius-sm)',
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
              <SettingsCheckboxRow
                label="Share agent auth across Linux containers"
                checked={store.shareDockerAgentAuth}
                onChange={setShareDockerAgentAuth}
                description="Persist agent credentials in a user-owned host directory so you only need to sign in once per agent type. Auth on first run is saved automatically for future containers."
              />
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
                'border-radius': 'var(--radius-md)',
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

          <SettingsSection title="Agent Environment">
            <AgentEnvFileEditor />
          </SettingsSection>

          <SettingsSection title="Super Productivity">
            <SuperProductivitySettings />
          </SettingsSection>

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

          <SettingsSection title="Diagnostics">
            <SettingsCheckboxRow
              label="Verbose logging"
              checked={store.verboseLogging}
              onChange={setVerboseLogging}
              description="Emit debug-level logs to the developer console. Verbose logs may include file paths, branch names, commit messages, IPC channel activity, and pty lifecycle events. Review the contents before sharing."
            />
          </SettingsSection>

          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
            <div style={{ ...sectionLabelStyle, 'font-weight': '600' }}>Updates</div>
            <div
              style={{
                display: 'flex',
                'flex-direction': 'column',
                gap: '10px',
                padding: '12px',
                'border-radius': 'var(--radius-md)',
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
                        'border-radius': 'var(--radius-xs)',
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
                'border-radius': 'var(--radius-md)',
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
                      'border-radius': 'var(--radius-sm)',
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
                'border-radius': 'var(--radius-sm)',
              }}
            >
              + Create New
            </button>
          </div>

          {/* Single mode (Light or Dark): built-ins + matching custom themes in one grid */}
          <Show when={store.appearanceMode !== 'system'}>
            <ThemeGrid
              slot={store.appearanceMode as ThemeSlot}
              onClonePreset={openCloneDialog}
              onEditCustom={(themeId) => {
                setCloneCss(undefined);
                setEditingThemeId(themeId);
                setCustomThemeDialogOpen(true);
              }}
            />
          </Show>

          {/* System mode: dual grids, each with built-ins + tone-matching custom themes */}
          <Show when={store.appearanceMode === 'system'}>
            <For each={['dark', 'light'] as const}>
              {(slot) => (
                <div style={{ display: 'flex', 'flex-direction': 'column', gap: '10px' }}>
                  <div style={{ ...sectionLabelStyle, 'font-weight': '600' }}>
                    {slot === 'dark' ? 'Dark Theme' : 'Light Theme'}
                  </div>
                  <ThemeGrid
                    slot={slot}
                    onClonePreset={openCloneDialog}
                    onEditCustom={(themeId) => {
                      setCloneCss(undefined);
                      setEditingThemeId(themeId);
                      setCustomThemeDialogOpen(true);
                    }}
                  />
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

      <Show when={activeTab() === 'mcp'}>
        <div
          id="settings-tab-mcp"
          role="tabpanel"
          aria-labelledby="settings-tabbutton-mcp"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '18px' }}
        >
          <SettingsSection title="Agent orchestration">
            <SettingsCheckboxRow
              label="Allow agents to orchestrate tasks"
              checked={store.mcpOrchestrationEnabled}
              disabled={savingMcpSetting()}
              onChange={(enabled) => void changeMcpOrchestration(enabled)}
              description="Allow supported agents in top-level worktree tasks to create and manage Parallel Code tasks through MCP by default in new sessions. Peer access between tasks also requires project permission."
            />
            <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
              Child tasks launch additional agent sessions and may incur provider charges. The
              default concurrent child limit is {DEFAULT_COORDINATOR_CONCURRENT_TASKS}; each parent
              can have a configured limit. This is not a spending cap.
            </span>
            <span style={{ 'font-size': '12px', color: theme.fgSubtle }}>
              Turning this off blocks new agent orchestration actions. Existing tasks keep running,
              worktrees are preserved, and canvas tools remain available. After enabling, restart
              agent sessions if their orchestration tools are not available. Use restart and resume
              to preserve the conversation where supported.
            </span>
            <Show when={mcpSettingError()}>
              <span role="alert" style={{ 'font-size': '12px', color: theme.error }}>
                {mcpSettingError()}
              </span>
            </Show>
          </SettingsSection>
          <SettingsSection title="Automatic child updates">
            <div
              style={{
                display: 'flex',
                'flex-direction': 'column',
                gap: '6px',
                padding: '8px 12px',
                'border-radius': 'var(--radius-md)',
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
                  Child update delay (seconds)
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
                    'border-radius': 'var(--radius-sm)',
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
                How long to wait before automatically sending an update after a child task
                completes. Default: 60s. Failed sub-tasks use max(10s, delay ÷ 4).
              </span>
            </div>
          </SettingsSection>
        </div>
      </Show>

      <Show when={activeTab() === 'experimental'}>
        <div
          id="settings-tab-experimental"
          role="tabpanel"
          aria-labelledby="settings-tabbutton-experimental"
          style={{ display: 'flex', 'flex-direction': 'column', gap: '18px' }}
        >
          <SettingsSection title="Document workspaces">
            <SettingsCheckboxRow
              label="Document workspaces"
              checked={store.documentWorkspacesEnabled}
              onChange={setDocumentWorkspacesEnabled}
              description="Add document projects: a folder with one Markdown document, set up for you if it is not a Git repository yet. Select a passage, send the same instruction to one or more agents running headlessly in isolated worktrees, compare the proposals side by side, and accept one as a single readable commit. Adds Document project to the + button next to Projects."
            />
          </SettingsSection>
        </div>
      </Show>
    </Dialog>
  );
}
