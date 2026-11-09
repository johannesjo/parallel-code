import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    ['Branches and worktrees', 'Worktree setup', 'Agent collaboration', 'Environment', 'Terminal'],
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

describe('worktree setup settings', () => {
  function open(extra: Partial<Project> = {}) {
    const project: Project = {
      id: 'p',
      name: 'P',
      path: '/repo',
      color: 'hsl(0, 70%, 75%)',
      ...extra,
    };
    setStore('projects', [project]);
    const host = document.createElement('div');
    document.body.append(host);
    const onClose = vi.fn();
    dispose = render(
      () => <EditProjectDialog project={store.projects[0]} onClose={onClose} />,
      host,
    );
    const save = () => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.trim() === 'Save',
      );
      if (!button) throw new Error('Missing Save button');
      button.click();
    };
    return { onClose, save };
  }
  const field = (label: string) => {
    const el = [...document.querySelectorAll('label')].find((l) =>
      l.textContent?.startsWith(label),
    );
    const id = el?.getAttribute('for');
    const input = id ? document.getElementById(id) : null;
    if (!(input instanceof HTMLTextAreaElement)) throw new Error(`Missing ${label}`);
    return input;
  };
  const includesToggle = () => {
    const box = [...document.querySelectorAll('label')]
      .find((l) => l.textContent?.includes('Save which ignored files new tasks bring in'))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!box) throw new Error('Missing include-list checkbox');
    return box;
  };

  it('leaves an unconfigured project unconfigured and probes nothing', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const { onClose, save } = open();
    save();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(store.projects[0].worktreeSetupScript).toBeUndefined();
    expect(store.projects[0].worktreeTeardownScript).toBeUndefined();
    expect(store.projects[0].worktreeIncludes).toBeUndefined();
    expect(vi.mocked(invoke).mock.calls.some(([c]) => c === IPC.GetGitignoredDirs)).toBe(false);
  });

  it('saves setup and teardown scripts, and clears them when emptied', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const first = open();
    const setup = field('Setup script');
    setup.value = 'npm ci\ncp "$PARALLEL_CODE_ROOT_PATH/.env" .';
    setup.dispatchEvent(new Event('input', { bubbles: true }));
    const teardown = field('Teardown script');
    teardown.value = 'docker compose down';
    teardown.dispatchEvent(new Event('input', { bubbles: true }));
    first.save();
    await vi.waitFor(() => expect(first.onClose).toHaveBeenCalled());
    expect(store.projects[0].worktreeSetupScript).toBe(
      'npm ci\ncp "$PARALLEL_CODE_ROOT_PATH/.env" .',
    );
    expect(store.projects[0].worktreeTeardownScript).toBe('docker compose down');

    dispose?.();
    document.body.replaceChildren();
    const second = open(store.projects[0]);
    const again = field('Setup script');
    expect(again.value).toContain('npm ci');
    again.value = '   ';
    again.dispatchEvent(new Event('input', { bubbles: true }));
    second.save();
    await vi.waitFor(() => expect(second.onClose).toHaveBeenCalled());
    expect(store.projects[0].worktreeSetupScript).toBeUndefined();
  });

  it('seeds a saved include list from the defaults and stores per-entry modes', async () => {
    vi.mocked(invoke).mockImplementation(async (channel) =>
      channel === IPC.GetGitignoredDirs
        ? [
            { name: 'node_modules', isDefault: true },
            { name: '.env', isDefault: true },
            { name: 'docs-local', isDefault: false },
          ]
        : undefined,
    );
    const { onClose, save } = open();
    includesToggle().click();
    const envMode = await vi.waitFor(() => {
      const select = document.querySelector<HTMLSelectElement>(
        'select[aria-label="How new tasks get .env"]',
      );
      if (!select) throw new Error('rows not loaded');
      expect(select.value).toBe('symlink');
      return select;
    });
    envMode.value = 'copy';
    envMode.dispatchEvent(new Event('change', { bubbles: true }));
    const docs = document.querySelector<HTMLSelectElement>(
      'select[aria-label="How new tasks get docs-local"]',
    );
    expect(docs?.value).toBe('');
    save();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(store.projects[0].worktreeIncludes).toEqual([
      { name: 'node_modules', mode: 'symlink' },
      { name: '.env', mode: 'copy' },
    ]);
  });

  it('never saves an empty list when the defaults could not be loaded', async () => {
    vi.mocked(invoke).mockImplementation(async (channel) => {
      if (channel === IPC.GetGitignoredDirs) throw new Error('git missing');
      return undefined;
    });
    const { onClose, save } = open();
    includesToggle().click();
    await vi.waitFor(() => expect(includesToggle().checked).toBe(false));
    save();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(store.projects[0].worktreeIncludes).toBeUndefined();
  });

  it('saves the list as unset while the defaults are still loading', async () => {
    vi.mocked(invoke).mockImplementation((channel) =>
      channel === IPC.GetGitignoredDirs ? new Promise(() => {}) : Promise.resolve(undefined),
    );
    const { onClose, save } = open();
    includesToggle().click();
    save();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(store.projects[0].worktreeIncludes).toBeUndefined();
  });

  it('turning the list off returns to the per-task defaults', async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    const { onClose, save } = open({ worktreeIncludes: [{ name: '.env', mode: 'copy' }] });
    expect(includesToggle().checked).toBe(true);
    includesToggle().click();
    save();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(store.projects[0].worktreeIncludes).toBeUndefined();
  });
});
