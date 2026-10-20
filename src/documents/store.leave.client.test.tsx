import { afterEach, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { IPC } from '../../electron/ipc/channels';
import { closeDocumentWorkspace, openDocumentFile, openDocumentWorkspace } from './store';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../lib/ipc', () => ({
  invoke,
  Channel: class {
    dispose() {}
  },
}));

afterEach(async () => {
  closeDocumentWorkspace();
  // The leave-commit is async; let it land before the next test counts calls.
  await new Promise((resolve) => setTimeout(resolve, 0));
  setStore({ projects: [], activeDocumentProjectId: null, documentWorkspacesEnabled: false });
  vi.clearAllMocks();
});

function project(id: string, path: string) {
  return { id, name: id, path, color: '', kind: 'document' as const, documentPath: 'a.md' };
}

function commits(): unknown[] {
  return invoke.mock.calls.filter(([channel]) => channel === IPC.CommitDocumentEdits);
}

async function setup(): Promise<void> {
  invoke.mockImplementation(async (channel: string) =>
    channel === IPC.ReadDocument
      ? { content: '# A\n', headSha: 'h', branch: 'main', dirty: false, missing: false }
      : [],
  );
  setStore({
    documentWorkspacesEnabled: true,
    projects: [project('one', '/p/one'), project('two', '/p/two')],
  });
  await openDocumentWorkspace('one');
}

it('saves the edits of the document left for another one, without asking first', async () => {
  await setup();
  await openDocumentFile('b.md');

  await vi.waitFor(() => expect(commits()).toHaveLength(1));
  expect(commits()[0]).toEqual([IPC.CommitDocumentEdits, { projectRoot: '/p/one' }]);
});

it('saves the edits of the project a different project replaces', async () => {
  await setup();
  await openDocumentWorkspace('two');

  await vi.waitFor(() => expect(commits()).toHaveLength(1));
  expect(commits()[0]).toEqual([IPC.CommitDocumentEdits, { projectRoot: '/p/one' }]);
});

it('still saves when the project was removed from the app', async () => {
  await setup();
  setStore({ projects: [] });
  closeDocumentWorkspace();

  await vi.waitFor(() => expect(commits()).toHaveLength(1));
  expect(commits()[0]).toEqual([IPC.CommitDocumentEdits, { projectRoot: '/p/one' }]);
});
