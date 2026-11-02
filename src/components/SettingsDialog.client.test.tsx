import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';
import { SettingsDialog } from './SettingsDialog';
import * as codexModelsModule from '../lib/codex-models';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../lib/fonts', () => ({
  DEFAULT_TERMINAL_FONT: 'monospace',
  getAvailableTerminalFonts: () => ['monospace'],
  fetchAvailableTerminalFonts: async () => ['monospace'],
  getTerminalFontFamily: () => 'monospace',
  LIGATURE_FONTS: new Set(),
}));

vi.mock('../lib/codex-models', async () => {
  const { createSignal } = await import('solid-js');
  const [models, setModels] = createSignal<unknown[]>([]);
  return { codexModels: models, loadCodexModels: vi.fn(), setCodexModels: setModels };
});

let dispose: (() => void) | undefined;

function selectTab(label: string): void {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (element) => element.textContent === label,
  );
  if (!tab) throw new Error(`Missing ${label} tab`);
  tab.click();
}

function orchestrationCheckbox(): HTMLInputElement {
  const label = [...document.querySelectorAll('#settings-panel-agents label')].find((element) =>
    element.textContent?.includes('Allow agents to orchestrate tasks'),
  );
  const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!input) throw new Error('Missing agent orchestration switch');
  return input;
}

beforeEach(() => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  setStore('mcpOrchestrationEnabled', true);
  setStore('preferUiMode', false);
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <SettingsDialog open onClose={() => {}} />, host);
});

afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

it('groups agent orchestration and child update controls in the Agents tab', () => {
  selectTab('Agents');
  expect(document.querySelector('#settings-panel-agents')?.textContent).toContain(
    'Allow agents to orchestrate tasks',
  );
  expect(document.querySelector('#settings-panel-agents')?.textContent).toContain(
    'Child update delay',
  );
  expect(document.querySelector('#settings-panel-agents')?.textContent).not.toContain(
    'Coordinator mode',
  );
  selectTab('Experimental');
  expect(document.querySelector('#settings-panel-experimental')?.textContent).toContain(
    'Document workspaces',
  );
  expect(document.querySelector('#settings-panel-experimental')?.textContent).not.toContain(
    'Coordinator mode',
  );
});

it('waits for backend acknowledgement before displaying the disabled setting', async () => {
  let acknowledge: (() => void) | undefined;
  vi.mocked(invoke).mockImplementation(
    () => new Promise<void>((resolve) => (acknowledge = resolve)),
  );
  selectTab('Agents');
  const checkbox = orchestrationCheckbox();
  checkbox.click();
  expect(invoke).toHaveBeenCalledWith(IPC.DelegationRequest, {
    action: 'orchestrationSetting',
    enabled: false,
  });
  expect(store.mcpOrchestrationEnabled).toBe(true);
  expect(checkbox.checked).toBe(true);
  expect(checkbox.disabled).toBe(true);
  acknowledge?.();
  await vi.waitFor(() => expect(checkbox.disabled).toBe(false));
  expect(store.mcpOrchestrationEnabled).toBe(false);
  expect(checkbox.checked).toBe(false);
});

it('keeps the setting enabled and reports a rejected backend change', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('Backend unavailable'));
  selectTab('Agents');
  const checkbox = orchestrationCheckbox();
  checkbox.click();
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Backend unavailable'),
  );
  expect(store.mcpOrchestrationEnabled).toBe(true);
  expect(checkbox.checked).toBe(true);
  expect(checkbox.disabled).toBe(false);
});

it('toggles the global UI mode preference in Agents settings', () => {
  selectTab('Agents');
  const label = [...document.querySelectorAll('label')].find((element) =>
    element.textContent?.includes('Always prefer UI mode'),
  );
  const checkbox = label?.querySelector('input');
  expect(checkbox).toBeDefined();
  expect(checkbox?.checked).toBe(false);
  checkbox?.click();
  expect(store.preferUiMode).toBe(true);
  expect(checkbox?.checked).toBe(true);
  checkbox?.click();
  expect(store.preferUiMode).toBe(false);
});

it('scrolls the active tab from the dialog while keeping its heading and tabs outside', () => {
  const panel = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!panel) throw new Error('Missing settings dialog');

  for (const label of ['General', 'Appearance', 'Agents', 'AI assist', 'Experimental']) {
    selectTab(label);
    const body = panel.querySelector<HTMLElement>('[data-dialog-scroll]');
    if (!body) throw new Error(`Missing ${label} scroll region`);
    expect(body.getAttribute('role')).toBe('tabpanel');
    expect(body.contains(panel.querySelector('h2'))).toBe(false);
    expect(body.contains(panel.querySelector('[role="tablist"]'))).toBe(false);
    expect(body.contains(panel.querySelector('[aria-label="Close settings"]'))).toBe(false);

    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    expect(body.scrollTop).toBe(200);
    expect(panel.scrollTop).toBe(0);
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(body.scrollTop).toBe(160);
  }
});

it('leaves native select keyboard handling alone inside the scrolling tab', () => {
  selectTab('AI assist');
  const body = document.querySelector<HTMLElement>('[data-dialog-scroll]');
  const select = body?.querySelector('select');
  if (!body || !select) throw new Error('Missing settings select');
  const key = new KeyboardEvent('keydown', {
    key: 'ArrowDown',
    bubbles: true,
    cancelable: true,
  });
  select.dispatchEvent(key);
  expect(key.defaultPrevented).toBe(false);
  expect(body.scrollTop).toBe(0);
});

it("names Codex's own default model once its list loads, with no placeholder before", async () => {
  const { setCodexModels } = codexModelsModule as unknown as {
    setCodexModels: (models: unknown[]) => void;
  };
  setStore('askCodeProvider', 'codex');
  setStore('askCodeModel', '');
  selectTab('AI assist');
  // MiniMax is offered only for code Q&A, which tells its select from the reviewer's.
  const select = () =>
    [...document.querySelectorAll<HTMLSelectElement>('select')]
      .find((element) => [...element.options].some((option) => option.value === 'minimax'))
      ?.parentElement?.parentElement?.querySelectorAll('select')[1];
  await vi.waitFor(() => expect(select()?.options.length).toBe(0));
  setCodexModels([
    { slug: 'gpt-6-astra', displayName: 'GPT-6-Astra' },
    { slug: 'gpt-6-sol', displayName: 'GPT-6-Sol', isDefault: true },
  ]);
  await vi.waitFor(() => expect(select()?.value).toBe('gpt-6-sol'));
  expect([...(select()?.options ?? [])].map((option) => option.text)).toEqual([
    'GPT-6-Astra',
    'GPT-6-Sol',
  ]);
  setStore('askCodeProvider', 'claude');
});

it('moves selection and focus between tabs with arrow, Home and End keys', () => {
  const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const press = (key: string) =>
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  tabs()[0].focus();
  expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1]);

  press('ArrowLeft');
  expect(document.activeElement?.textContent).toBe('Experimental');
  expect(document.querySelector('#settings-panel-experimental')).not.toBeNull();
  press('ArrowRight');
  expect(document.activeElement?.textContent).toBe('General');
  press('End');
  expect(document.activeElement?.textContent).toBe('Experimental');
  press('Home');
  expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement?.textContent).toBe('General');
});

it('loads Codex models only once the AI assist tab shows the Codex provider', () => {
  setStore('askCodeProvider', 'codex');
  expect(codexModelsModule.loadCodexModels).not.toHaveBeenCalled();
  selectTab('AI assist');
  expect(codexModelsModule.loadCodexModels).toHaveBeenCalled();
  setStore('askCodeProvider', 'claude');
});

it('keeps the propagate default in place but disabled while orchestration is off', () => {
  setStore('mcpOrchestrationEnabled', false);
  selectTab('Agents');
  const label = [...document.querySelectorAll('#settings-panel-agents label')].find((element) =>
    element.textContent?.includes('Propagate skip-permissions to sub-tasks'),
  );
  expect(label?.querySelector('input')?.disabled).toBe(true);
  setStore('mcpOrchestrationEnabled', true);
  expect(label?.querySelector('input')?.disabled).toBe(false);
});
