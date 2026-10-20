import { afterEach, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { IPC } from '../../electron/ipc/channels';
import { showNotification } from '../store/notification';
import { closeDocumentWorkspace, initDocumentListeners, openQuickEdit } from './store';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../lib/ipc', () => ({
  invoke,
  Channel: class {
    dispose() {}
  },
}));
vi.mock('../store/notification', () => ({ showNotification: vi.fn() }));

afterEach(async () => {
  closeDocumentWorkspace();
  await new Promise((resolve) => setTimeout(resolve, 0));
  setStore({ projects: [], activeDocumentProjectId: null, documentWorkspacesEnabled: false });
  vi.clearAllMocks();
});

function backend(warning?: string) {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === IPC.OpenQuickEdit)
      return {
        projectRoot: '/data/quick-edits/abc',
        documentPath: 'spec.md',
        sourcePath: '/work/app/docs/spec.md',
        ...(warning ? { warning } : {}),
      };
    if (channel === IPC.ReadDocument)
      return { content: '# Spec\n', headSha: 'h', branch: 'main', dirty: false, missing: false };
    return [];
  });
}

it('reopens the quick edit it already has instead of adding another', async () => {
  backend();
  setStore({ documentWorkspacesEnabled: true });
  await openQuickEdit('/work/app/docs/spec.md');
  closeDocumentWorkspace();
  await openQuickEdit('/work/app/docs/spec.md');
  expect(store.projects.filter((p) => p.quickEditSource)).toHaveLength(1);
});

it('opens nothing when the quick edit is no longer wanted once it is ready', async () => {
  backend();
  setStore({ documentWorkspacesEnabled: true });
  await openQuickEdit('/work/app/docs/spec.md', false, () => false);
  expect(store.projects).toHaveLength(0);
  expect(store.activeDocumentProjectId).toBeNull();
});

it('tells the user when opening set a clashing copy aside', async () => {
  backend('Quick edit changed on both sides; saved the copy to /data/x.conflict.md');
  setStore({ documentWorkspacesEnabled: true });
  await openQuickEdit('/work/app/docs/spec.md');
  expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('x.conflict.md'));
});

it('tells the user about a clash the running sync found', () => {
  const handlers = new Map<string, (payload: unknown) => void>();
  vi.stubGlobal('electron', {
    ipcRenderer: {
      on: (channel: string, handler: (payload: unknown) => void) => {
        handlers.set(channel, handler);
        return () => handlers.delete(channel);
      },
    },
  });
  const dispose = initDocumentListeners();
  handlers.get(IPC.QuickEditWarning)?.({ sourcePath: '/s.md', message: 'kept at /x.conflict.md' });
  dispose();
  vi.unstubAllGlobals();
  expect(showNotification).toHaveBeenCalledWith('kept at /x.conflict.md');
});
