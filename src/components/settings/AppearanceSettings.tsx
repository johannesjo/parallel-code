import { For, Show, createSignal } from 'solid-js';
import { CustomThemeDialog } from '../CustomThemeDialog';
import { getTerminalFontFamily, LIGATURE_FONTS } from '../../lib/fonts';
import type { AppearanceMode } from '../../lib/look';
import { theme, readCssVarsForPreset, sectionLabelStyle } from '../../lib/theme';
import { themeToCss } from '../../lib/custom-theme';
import {
  store,
  setTerminalFont,
  setTerminalScreenReaderMode,
  setShowPlans,
  setShowPromptInput,
  setShowSidebarTips,
  setShowSidebarProgress,
  setSidebarNeedsInputFirst,
  setFontSmoothing,
  setInactiveColumnOpacity,
  setAppearanceMode,
  setCanvasOwnershipBadges,
} from '../../store/store';
import { PlusIcon } from '../icons';
import { SettingsCard, SettingsCheckboxRow, SettingsSection } from './settings-ui';
import { ThemeGrid, type ThemeSlot } from './ThemeCards';

export function AppearanceSettings(props: { fonts: string[] }) {
  const [customThemeDialogOpen, setCustomThemeDialogOpen] = createSignal(false);
  const [editingThemeId, setEditingThemeId] = createSignal<string | null>(null);
  const [cloneCss, setCloneCss] = createSignal<string | undefined>(undefined);

  function openCloneDialog(presetId: string, label: string) {
    const vars = readCssVarsForPreset(presetId);
    const bg = vars['--task-panel-bg'] ?? '#000000';
    setCloneCss(themeToCss(`${label} (copy)`, '', bg, vars));
    setEditingThemeId(null);
    setCustomThemeDialogOpen(true);
  }

  function openEditDialog(themeId: string | null) {
    setCloneCss(undefined);
    setEditingThemeId(themeId);
    setCustomThemeDialogOpen(true);
  }

  return (
    <>
      <SettingsSection title="Mode">
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
      </SettingsSection>

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
          class="btn-with-icon"
          onClick={() => openEditDialog(null)}
          style={{
            background: 'transparent',
            border: `1px solid ${theme.border}`,
            color: theme.fg,
            cursor: 'pointer',
            'font-size': '12px',
            padding: '4px 12px',
            'border-radius': 'var(--radius-sm)',
          }}
        >
          <PlusIcon size={12} />
          Create New
        </button>
      </div>

      {/* Single mode (Light or Dark): built-ins + matching custom themes in one grid */}
      <Show when={store.appearanceMode !== 'system'}>
        <ThemeGrid
          slot={store.appearanceMode as ThemeSlot}
          onClonePreset={openCloneDialog}
          onEditCustom={openEditDialog}
        />
      </Show>

      {/* System mode: dual grids, each with built-ins + tone-matching custom themes */}
      <Show when={store.appearanceMode === 'system'}>
        <For each={['dark', 'light'] as const}>
          {(slot) => (
            <SettingsSection title={slot === 'dark' ? 'Dark theme' : 'Light theme'}>
              <ThemeGrid
                slot={slot}
                onClonePreset={openCloneDialog}
                onEditCustom={openEditDialog}
              />
            </SettingsSection>
          )}
        </For>
      </Show>
      <SettingsSection title="Display">
        <SettingsCheckboxRow
          label="Show plans"
          checked={store.showPlans}
          onChange={setShowPlans}
          description="Show a Review Plan button in Notes when a plan file is available"
        />
        <SettingsCheckboxRow
          label="Pin actions that need attention to the top of the sidebar"
          checked={store.sidebarNeedsInputFirst}
          onChange={setSidebarNeedsInputFirst}
          description="Questions, reviews, and coordination failures appear directly under New Task"
        />
        <SettingsCheckboxRow
          label="Show progress section in sidebar"
          checked={store.showSidebarProgress}
          onChange={setShowSidebarProgress}
          description="Show today’s local task and tracked PR merge count when nonzero"
        />
        <SettingsCheckboxRow
          label="Show tips section in sidebar"
          checked={store.showSidebarTips}
          onChange={setShowSidebarTips}
          description="Keyboard shortcut hints at the bottom of the sidebar"
        />
        <SettingsCheckboxRow
          label="Show ownership badges on canvases"
          checked={store.canvasOwnershipBadges}
          onChange={setCanvasOwnershipBadges}
          description="Mark nodes you edited on mind maps and reasoning graphs; agents leave those alone until you release them"
        />
        <SettingsCheckboxRow
          label="Font smoothing"
          checked={store.fontSmoothing}
          onChange={setFontSmoothing}
          description="Enable antialiasing and geometric text rendering"
          align="flex-start"
        />
        <SettingsCard gap="8px">
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
            min="10"
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
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Terminal">
        <SettingsCheckboxRow
          label="Show prompt input box below terminal"
          checked={store.showPromptInput}
          onChange={setShowPromptInput}
          description="When hidden, the terminal occupies the full panel and auto-focuses on activation"
        />
        <div class="settings-font-grid">
          <For each={props.fonts}>
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
        <SettingsCheckboxRow
          label="Terminal screen reader mode"
          checked={store.terminalScreenReaderMode}
          onChange={setTerminalScreenReaderMode}
          description="Expose terminal output to assistive technologies. May reduce rendering performance."
          align="flex-start"
        />
      </SettingsSection>
      <CustomThemeDialog
        open={customThemeDialogOpen()}
        editId={editingThemeId()}
        initialCss={cloneCss()}
        onClose={() => setCustomThemeDialogOpen(false)}
      />
    </>
  );
}
