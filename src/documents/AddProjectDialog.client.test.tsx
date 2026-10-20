import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { AddProjectDialog } from './AddProjectDialog';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { addDocumentProject, addProject } from '../store/projects';
import { openDocumentWorkspace, openQuickEdit } from './store';
import type { DocumentFolderInfo } from './types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../store/projects', () => ({
  addDocumentProject: vi.fn(() => 'project'),
  addProject: vi.fn(() => 'code-project'),
}));
vi.mock('./store', () => ({ openDocumentWorkspace: vi.fn(), openQuickEdit: vi.fn() }));

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
  renderDialog();
  await typeFolder('/tmp/design-notes');
}

const onCodeProjectAdded = vi.fn();

function renderDialog() {
  dispose = render(
    () => <AddProjectDialog open onClose={() => {}} onCodeProjectAdded={onCodeProjectAdded} />,
    document.body,
  );
}

/** Renders the dialog over one folder that `inspect` describes. */
async function openFolder(path: string, inspect: Partial<DocumentFolderInfo>) {
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.InspectDocumentFolder
      ? {
          exists: true,
          isRepo: false,
          enclosingRepo: null,
          looksLikeCode: false,
          files: [],
          ...inspect,
        }
      : true,
  );
  renderDialog();
  await typeFolder(path);
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === label);
}

function submit(label = 'Open workspace') {
  button(label)?.click();
}

it('creates Markdown without asking first-time users to choose a format', async () => {
  await open([]);
  expect(document.querySelector('[aria-label="Document format"]')).toBeNull();
  submit('Create document');
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
  submit('Create document');
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

it('suggests Code for a code repository and adds it as a code project', async () => {
  await openFolder('/work/app', { isRepo: true, looksLikeCode: true });
  await vi.waitFor(() => expect(button('Code')?.getAttribute('aria-checked')).toBe('true'));
  submit('Add project');
  await vi.waitFor(() => expect(addProject).toHaveBeenCalledWith('app', '/work/app', true));
  expect(onCodeProjectAdded).toHaveBeenCalledWith('code-project');
  expect(invoke).not.toHaveBeenCalledWith(IPC.PrepareDocumentProject, expect.anything());
});

it('opens a document in a code repository as a quick edit, committing nothing there', async () => {
  await openFolder('/work/app', {
    isRepo: true,
    looksLikeCode: true,
    files: [{ path: 'README.md', committed: true }],
  });
  await vi.waitFor(() => expect(button('Documents')).toBeDefined());
  button('Documents')?.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('quick edit'));
  submit('Open document');
  await vi.waitFor(() =>
    expect(openQuickEdit).toHaveBeenCalledWith('/work/app/README.md', false, expect.any(Function)),
  );
  expect(invoke).not.toHaveBeenCalledWith(IPC.PrepareDocumentProject, expect.anything());
});

it('creates a new document in a docs folder of a repository as a quick edit', async () => {
  await openFolder('/work/app/docs', { enclosingRepo: '/work/app' });
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain('Nothing is committed in /work/app'),
  );
  submit('Create document');
  await vi.waitFor(() =>
    expect(openQuickEdit).toHaveBeenCalledWith(
      '/work/app/docs/docs.md',
      true,
      expect.any(Function),
    ),
  );
});

it('waits for the folder to be read before it creates anything', async () => {
  let inspected: (info: unknown) => void = () => {};
  vi.mocked(invoke).mockImplementation((channel) =>
    channel === IPC.InspectDocumentFolder
      ? new Promise((resolve) => (inspected = resolve))
      : Promise.resolve(true),
  );
  renderDialog();
  await typeFolder('/work/app');
  folderInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(invoke).not.toHaveBeenCalledWith(IPC.PrepareDocumentProject, expect.anything());
  inspected({ exists: true, isRepo: true, enclosingRepo: null, looksLikeCode: true, files: [] });
  await vi.waitFor(() => expect(button('Add project')).toBeDefined());
});

it('moves between Code and Documents with the arrow keys', async () => {
  await openFolder('/work/app', { isRepo: true, looksLikeCode: true });
  await vi.waitFor(() => expect(button('Code')?.tabIndex).toBe(0));
  expect(button('Documents')?.tabIndex).toBe(-1);
  button('Code')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await vi.waitFor(() => expect(button('Documents')?.getAttribute('aria-checked')).toBe('true'));
  expect(document.activeElement).toBe(button('Documents'));
});

it('says it creates a project for a folder that is not one yet, and offers no Code there', async () => {
  await openFolder('/tmp/new-notes', { exists: false, files: [] });
  await vi.waitFor(() => expect(button('Create project')).toBeDefined());
  expect(button('Code')?.disabled).toBe(true);
  expect(document.body.textContent).toContain('Parallel will create the folder');
});

it('keeps what it knew about the folder on screen while the next path is read', async () => {
  await openFolder('/work/app', { isRepo: true, looksLikeCode: true });
  await vi.waitFor(() => expect(button('Add project')?.disabled).toBe(false));
  const input = folderInput();
  input.value = '/work/app2';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(document.body.textContent).toContain('Checking folder…');
  expect(button('Add project')?.disabled).toBe(true);
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(IPC.InspectDocumentFolder, { projectRoot: '/work/app2' }),
  );
  await vi.waitFor(() => expect(button('Add project')?.disabled).toBe(false));
});

it('says Create document for a new file in a writing repository, Open workspace for an existing one', async () => {
  await openFolder('/notes', { isRepo: true, hasCommits: true, files: [] });
  await vi.waitFor(() => expect(button('Create document')).toBeDefined());
  dispose?.();
  document.body.replaceChildren();
  await openFolder('/notes', {
    isRepo: true,
    hasCommits: true,
    files: [{ path: 'notes.md', committed: true }],
  });
  await vi.waitFor(() => expect(button('Open workspace')).toBeDefined());
});

it('closes at once on Cancel during setup and adds or opens nothing when it ends', async () => {
  let finish: (value: unknown) => void = () => {};
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.InspectDocumentFolder
      ? { exists: true, isRepo: true, files: [] }
      : new Promise((resolve) => (finish = resolve)),
  );
  const onClose = vi.fn();
  dispose = render(
    () => <AddProjectDialog open onClose={onClose} onCodeProjectAdded={onCodeProjectAdded} />,
    document.body,
  );
  await typeFolder('/tmp/design-notes');
  submit('Create document');
  await vi.waitFor(() => expect(button('Setting up…')).toBeDefined());

  button('Cancel')?.click();
  expect(onClose).toHaveBeenCalledOnce();

  finish({ documentPath: 'design-notes.md', actions: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(addDocumentProject).not.toHaveBeenCalled();
  expect(openDocumentWorkspace).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

it('drops a quick edit cancelled during setup and is ready again when reopened', async () => {
  let finish: () => void = () => {};
  vi.mocked(openQuickEdit).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  await openFolder('/work/app/docs', { enclosingRepo: '/work/app' });
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain('Nothing is committed in /work/app'),
  );
  submit('Create document');
  await vi.waitFor(() => expect(button('Setting up…')).toBeDefined());
  const stillWanted = vi.mocked(openQuickEdit).mock.calls[0]?.[2];
  expect(stillWanted?.()).toBe(true);

  button('Cancel')?.click();
  expect(stillWanted?.()).toBe(false);
  // The dialog stays mounted; reopened, it must not still be setting up.
  expect(button('Setting up…')).toBeUndefined();
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(button('Setting up…')).toBeUndefined();
});
