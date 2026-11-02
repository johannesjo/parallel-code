import { Show, createSignal, createEffect, createUniqueId, on } from 'solid-js';
import type { JSX } from 'solid-js';
import { Dialog } from './Dialog';
import { DialogCloseButton } from './DialogCloseButton';
import { DialogTabs, dialogTabId, dialogTabPanelId, type DialogTab } from './DialogTabs';
import { getAvailableTerminalFonts, fetchAvailableTerminalFonts } from '../lib/fonts';
import { theme } from '../lib/theme';
import { store, setDocumentWorkspacesEnabled } from '../store/store';
import { mod } from '../lib/platform';
import { SettingsCheckboxRow, SettingsSection, type SettingsTab } from './settings/settings-ui';
import { GeneralSettings } from './settings/GeneralSettings';
import { AppearanceSettings } from './settings/AppearanceSettings';
import { AgentSettings } from './settings/AgentSettings';
import { AiAssistSettings } from './settings/AiAssistSettings';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

function ensureSelectedFont(available: string[]): string[] {
  if (available.includes(store.terminalFont)) return available;
  return [store.terminalFont, ...available];
}

const SETTINGS_TABS: DialogTab<SettingsTab>[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'agents', label: 'Agents' },
  { id: 'ai', label: 'AI assist' },
  { id: 'experimental', label: 'Experimental' },
];

function SettingsTabPanel(props: { tab: SettingsTab; children: JSX.Element }) {
  return (
    <div
      id={dialogTabPanelId('settings', props.tab)}
      role="tabpanel"
      aria-labelledby={dialogTabId('settings', props.tab)}
      data-dialog-scroll
      style={{
        'min-height': '0',
        'overflow-y': 'auto',
        padding: '4px',
        display: 'flex',
        'flex-direction': 'column',
        gap: '18px',
      }}
    >
      {props.children}
    </div>
  );
}

export function SettingsDialog(props: SettingsDialogProps) {
  const titleId = createUniqueId();
  const [fonts, setFonts] = createSignal<string[]>(ensureSelectedFont(getAvailableTerminalFonts()));
  const [activeTab, setActiveTab] = createSignal<SettingsTab>('general');

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
      panelStyle={{
        'max-width': 'calc(100vw - 32px)',
        padding: '24px',
        gap: '18px',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          'flex-shrink': '0',
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
        <DialogCloseButton label="Close settings" onClick={() => props.onClose()} />
      </div>

      <DialogTabs
        tabs={SETTINGS_TABS}
        active={activeTab()}
        onChange={setActiveTab}
        idPrefix="settings"
        label="Settings tabs"
      />

      <Show when={activeTab() === 'general'}>
        <SettingsTabPanel tab="general">
          <GeneralSettings />
        </SettingsTabPanel>
      </Show>
      <Show when={activeTab() === 'appearance'}>
        <SettingsTabPanel tab="appearance">
          <AppearanceSettings fonts={fonts()} />
        </SettingsTabPanel>
      </Show>
      <Show when={activeTab() === 'agents'}>
        <SettingsTabPanel tab="agents">
          <AgentSettings />
        </SettingsTabPanel>
      </Show>
      <Show when={activeTab() === 'ai'}>
        <SettingsTabPanel tab="ai">
          <AiAssistSettings />
        </SettingsTabPanel>
      </Show>
      <Show when={activeTab() === 'experimental'}>
        <SettingsTabPanel tab="experimental">
          <SettingsSection title="Document workspaces">
            <SettingsCheckboxRow
              label="Document workspaces"
              checked={store.documentWorkspacesEnabled}
              onChange={setDocumentWorkspacesEnabled}
              description="Add document projects: a folder with one Markdown document, set up for you if it is not a Git repository yet. Select a passage, send the same instruction to one or more agents running headlessly in isolated worktrees, compare the proposals side by side, and accept one as a single readable commit. Adds Documents as an Open as choice when adding a project."
            />
          </SettingsSection>
        </SettingsTabPanel>
      </Show>
    </Dialog>
  );
}
