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

async function open(files: Array<{ path: string; committed: boolean }>) {
  vi.mocked(invoke).mockImplementation(async (channel) =>
    channel === IPC.InspectDocumentFolder
      ? { exists: true, isRepo: true, files }
      : { documentPath: files[0]?.path ?? 'design-notes.md', actions: [] },
  );
  dispose = render(() => <NewDocumentProjectDialog open onClose={() => {}} />, document.body);
  const input = document.querySelector<HTMLInputElement>('[aria-label="Project folder"]');
  if (!input) throw new Error('Project folder input did not render');
  input.value = '/tmp/design-notes';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(IPC.InspectDocumentFolder, {
      projectRoot: '/tmp/design-notes',
    }),
  );
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
