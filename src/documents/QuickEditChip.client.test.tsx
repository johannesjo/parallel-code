import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { QuickEditChip } from './QuickEditChip';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { addDocumentProject } from '../store/projects';
import { removeProjectAndHiddenAgents } from '../components/RemoveProjectConfirm';
import { openDocumentWorkspace } from './store';
import { showNotification } from '../store/notification';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../lib/dialog', () => ({ openDialog: vi.fn() }));
vi.mock('../store/projects', () => ({ addDocumentProject: vi.fn(() => 'moved') }));
vi.mock('../components/RemoveProjectConfirm', () => ({ removeProjectAndHiddenAgents: vi.fn() }));
vi.mock('./store', () => ({ openDocumentWorkspace: vi.fn() }));
vi.mock('../store/notification', () => ({ showNotification: vi.fn() }));

const quick = {
  id: 'quick',
  name: 'spec.md',
  path: '/data/quick-edits/abc',
  color: '#fff',
  documentPath: 'spec.md',
  quickEditSource: '/work/app/docs/spec.md',
};

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.resetAllMocks();
});

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label);
}

function typeFolder(folder: string): HTMLInputElement {
  dispose = render(() => <QuickEditChip project={quick} />, document.body);
  button('Quick edit')?.click();
  const input = document.querySelector<HTMLInputElement>('[aria-label="New project folder"]');
  if (!input) throw new Error('Folder input did not render');
  input.value = folder;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}

async function moveTo(folder: string) {
  typeFolder(folder);
  button('Create project')?.click();
}

it('moves the quick edit into a project of its own and drops the quick edit', async () => {
  vi.mocked(invoke).mockResolvedValue({ documentPath: 'spec.md', actions: [] });
  await moveTo('/notes/spec');
  await vi.waitFor(() => expect(removeProjectAndHiddenAgents).toHaveBeenCalledWith('quick', false));
  expect(invoke).toHaveBeenCalledWith(IPC.ConvertQuickEdit, {
    projectRoot: '/data/quick-edits/abc',
    documentPath: 'spec.md',
    folder: '/notes/spec',
  });
  expect(addDocumentProject).toHaveBeenCalledWith('spec', '/notes/spec', 'spec.md');
  expect(openDocumentWorkspace).toHaveBeenCalledWith('moved');
});

it('keeps the quick edit and says why when the move is refused', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('/work/app holds code.'));
  await moveTo('/work/app');
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('holds code'),
  );
  expect(addDocumentProject).not.toHaveBeenCalled();
  expect(removeProjectAndHiddenAgents).not.toHaveBeenCalled();
});

it('waits for an absolute folder, then moves on Enter', async () => {
  vi.mocked(invoke).mockResolvedValue({ documentPath: 'spec.md', actions: [] });
  const input = typeFolder('notes/spec');
  expect(button('Create project')?.disabled).toBe(true);
  input.value = '/notes/spec';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.waitFor(() => expect(removeProjectAndHiddenAgents).toHaveBeenCalledWith('quick', false));
});

it('drops the quick edit even when the new project fails to open', async () => {
  vi.mocked(invoke).mockResolvedValue({ documentPath: 'spec.md', actions: [] });
  vi.mocked(openDocumentWorkspace).mockRejectedValue(new Error('locked'));
  await moveTo('/notes/spec');
  await vi.waitFor(() => expect(removeProjectAndHiddenAgents).toHaveBeenCalledWith('quick', false));
  expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('locked'));
});

it('reports a quick edit that could not be removed after the move', async () => {
  vi.mocked(invoke).mockResolvedValue({ documentPath: 'spec.md', actions: [] });
  vi.mocked(removeProjectAndHiddenAgents).mockRejectedValue(new Error('busy'));
  await moveTo('/notes/spec');
  await vi.waitFor(() =>
    expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('busy')),
  );
});
