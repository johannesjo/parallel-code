import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';
import type { Project } from '../store/types';
import { EditProjectDialog } from './EditProjectDialog';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  setStore('projects', []);
  vi.clearAllMocks();
});

it('saves project fields even when the peer-access update fails', async () => {
  const project: Project = {
    id: 'project',
    name: 'Old name',
    path: '/repo',
    color: 'hsl(0, 70%, 75%)',
  };
  setStore('projects', [project]);
  let rejectSave: (error: Error) => void = () => {
    throw new Error('Save has not started');
  };
  vi.mocked(invoke).mockImplementation(() => new Promise((_, reject) => (rejectSave = reject)));
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <EditProjectDialog project={store.projects[0]} onClose={onClose} />, host);

  const name = document.querySelector<HTMLInputElement>('input.input-field');
  if (!name) throw new Error('Missing project name input');
  name.value = 'New name';
  name.dispatchEvent(new Event('input', { bubbles: true }));
  const peerAccess = [...document.querySelectorAll('label')]
    .find((label) => label.textContent?.includes('Allow peer access between tasks'))
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!peerAccess) throw new Error('Missing peer access checkbox');
  peerAccess.click();
  const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === 'Save',
  );
  if (!save) throw new Error('Missing Save button');
  save.click();
  expect(save.disabled).toBe(true);
  expect(save.textContent).toBe('Saving…');
  expect(save.getAttribute('aria-busy')).toBe('true');
  rejectSave(new Error('backend unavailable'));
  await vi.waitFor(() => expect(document.body.textContent).toContain('backend unavailable'));
  expect(save.disabled).toBe(false);
  expect(save.textContent).toBe('Save');
  expect(save.getAttribute('aria-busy')).toBe('false');

  expect(store.projects[0].name).toBe('New name');
  expect(store.projects[0].allowPeerAccess).toBeUndefined();
  // The unsaved choice stays so Save can retry it.
  expect(peerAccess.checked).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
});

function renderDialog(extra: Partial<Project> = {}, focusChecks = false) {
  const project: Project = {
    id: 'p',
    name: 'P',
    path: '/repo',
    color: 'hsl(0, 70%, 75%)',
    ...extra,
  };
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => <EditProjectDialog project={project} focusChecks={focusChecks} onClose={vi.fn()} />,
    host,
  );
}

const tabLabels = () => [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
const selectedTab = () => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
const headings = () => [...document.querySelectorAll('h3')].map((h) => h.textContent);

it.each([
  [
    {},
    ['General', 'Tasks', 'Verification'],
    ['Branches and worktrees', 'Agent collaboration', 'Environment', 'Terminal'],
  ],
  [{ isGitRepo: false }, ['General', 'Tasks', 'Verification'], ['Environment', 'Terminal']],
  [{ kind: 'document', documentPath: 'doc.md' }, [], []],
] as const)('shows only the tabs and sections a %o project uses', (extra, tabs, sections) => {
  renderDialog(extra);
  expect(tabLabels()).toEqual(tabs);
  expect(headings()).toEqual(sections);
});

it('opens on General, or on Verification when asked to focus the checks', () => {
  renderDialog();
  expect(selectedTab()).toBe('General');
  dispose?.();
  document.body.replaceChildren();
  renderDialog({}, true);
  expect(selectedTab()).toBe('Verification');
  const panel = document.getElementById(
    document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-controls') ??
      '',
  );
  expect(panel?.hidden).toBe(false);
  expect(panel?.textContent).toContain('Verify command');
});

it('switches tabs with the arrow keys and moves focus along', () => {
  renderDialog();
  const general = document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  general?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(selectedTab()).toBe('Tasks');
  expect(document.activeElement?.textContent).toBe('Tasks');
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
  );
  expect(selectedTab()).toBe('General');
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
  );
  expect(selectedTab()).toBe('Verification');
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
  );
  expect(selectedTab()).toBe('General');
});

it('saves the chosen icon and clears it with "No icon"', async () => {
  setStore('projects', [{ id: 'project', name: 'App', path: '/repo', color: 'hsl(0, 70%, 75%)' }]);
  vi.mocked(invoke).mockResolvedValue(undefined);
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <EditProjectDialog project={store.projects[0]} onClose={onClose} />, host);
  const button = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
    );
    if (!found) throw new Error(`Missing ${label} button`);
    return found;
  };

  const terminal = button('terminal icon');
  terminal.click();
  expect(terminal.getAttribute('aria-pressed')).toBe('true');
  button('Save').click();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(store.projects[0].icon).toBe('terminal');

  button('No icon').click();
  expect(terminal.getAttribute('aria-pressed')).toBe('false');
  button('Save').click();
  await vi.waitFor(() => expect(store.projects[0].icon).toBeUndefined());
});

it('saves project env vars and blocks save on an invalid name', async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  const project: Project = { id: 'p', name: 'P', path: '/repo', color: 'hsl(0, 70%, 75%)' };
  setStore('projects', [project]);
  const host = document.createElement('div');
  document.body.append(host);
  const onClose = vi.fn();
  dispose = render(() => <EditProjectDialog project={store.projects[0]} onClose={onClose} />, host);

  const add = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === 'Add variable',
  );
  if (!add) throw new Error('Missing Add variable button');
  add.click();
  const key = document.querySelector<HTMLInputElement>('input[aria-label="Variable name"]');
  if (!key) throw new Error('Missing variable name input');
  const type = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === 'Save',
  );
  if (!save) throw new Error('Missing Save button');

  type(key, 'BAD-NAME');
  expect(save.disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('"BAD-NAME"');

  type(key, 'CLAUDE_CONFIG_DIR');
  const value = document.querySelector<HTMLInputElement>(
    'input[aria-label="Value of CLAUDE_CONFIG_DIR"]',
  );
  if (!value) throw new Error('Missing value input');
  type(value, '~/.claude-work');
  expect(save.disabled).toBe(false);
  save.click();

  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(store.projects[0].agentEnv).toEqual({ CLAUDE_CONFIG_DIR: '~/.claude-work' });
  expect(invoke).toHaveBeenCalledWith(IPC.SetProjectAgentEnv, {
    projectId: 'p',
    env: { CLAUDE_CONFIG_DIR: '~/.claude-work' },
  });
});
