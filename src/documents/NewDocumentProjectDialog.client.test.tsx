import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { NewDocumentProjectDialog } from './NewDocumentProjectDialog';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../store/projects', () => ({ addDocumentProject: vi.fn(() => 'project') }));
vi.mock('./store', () => ({ openDocumentWorkspace: vi.fn() }));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.resetAllMocks();
});

function folderInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('[aria-label="Project folder"]');
  if (!input) throw new Error('Project folder input did not render');
  return input;
}

async function typeFolder(path: string) {
  const input = folderInput();
  input.value = path;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(IPC.InspectDocumentFolder, { projectRoot: path }),
  );
}

async function open(files: Array<{ path: string; committed: boolean }>) {
  vi.mocked(invoke).mockImplementation(async (channel, args) =>
    channel === IPC.InspectDocumentFolder
      ? // Only the first folder holds the files; any other path is empty.
        {
          exists: true,
          isRepo: true,
          files: (args as { projectRoot: string }).projectRoot === '/tmp/design-notes' ? files : [],
        }
      : { documentPath: files[0]?.path ?? 'design-notes.md', actions: [] },
  );
  dispose = render(() => <NewDocumentProjectDialog open onClose={() => {}} />, document.body);
  await typeFolder('/tmp/design-notes');
}

function submit() {
  Array.from(document.querySelectorAll('button'))
    .find((b) => b.textContent === 'Open workspace')
    ?.click();
}

it('creates Markdown without asking first-time users to choose a format', async () => {
  await open([]);
  expect(document.querySelector('[aria-label="Document format"]')).toBeNull();
  submit();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(IPC.PrepareDocumentProject, {
      projectRoot: '/tmp/design-notes',
      documentPath: 'design-notes.md',
      title: 'design-notes',
    }),
  );
});

it('focuses the folder path on open and opens the workspace on Enter', async () => {
  await open([]);
  await vi.waitFor(() => expect(document.activeElement).toBe(folderInput()));
  folderInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(IPC.PrepareDocumentProject, {
      projectRoot: '/tmp/design-notes',
      documentPath: 'design-notes.md',
      title: 'design-notes',
    }),
  );
});

it('lets a picked document go when the folder changes', async () => {
  await open([{ path: 'page.html', committed: true }]);
  await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull());
  Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
    .find((b) => b.textContent?.includes('page.html'))
    ?.click();
  await typeFolder('/tmp/other');
  await vi.waitFor(() => expect(document.body.textContent).not.toContain('page.html'));
  submit();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(IPC.PrepareDocumentProject, {
      projectRoot: '/tmp/other',
      documentPath: 'other.md',
      title: 'other',
    }),
  );
});

it('still opens an existing HTML document', async () => {
  await open([{ path: 'page.html', committed: true }]);
  submit();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(IPC.PrepareDocumentProject, {
      projectRoot: '/tmp/design-notes',
      documentPath: 'page.html',
      title: 'design-notes',
    }),
  );
});
