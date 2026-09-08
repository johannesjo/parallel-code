import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { IPC } from '../../electron/ipc/channels';
import { DocumentWorkspaceOverlay } from './DocumentWorkspaceOverlay';
import {
  closeDocumentWorkspace,
  documentStore,
  goBackDocument,
  openDocumentFile,
  openDocumentWorkspace,
  previousDocumentPath,
} from './store';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../lib/ipc', () => ({
  invoke,
  Channel: class {
    dispose() {}
  },
}));
vi.mock('../lib/shell', () => ({ openInEditor: vi.fn(), revealItemInDir: vi.fn() }));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  closeDocumentWorkspace();
  setStore({ projects: [], activeDocumentProjectId: null, documentWorkspacesEnabled: false });
  vi.clearAllMocks();
});

async function openWorkspace(): Promise<void> {
  invoke.mockImplementation(async (channel: string) =>
    channel === IPC.ReadDocument
      ? { content: '# Doc\n', headSha: 'abc1234', branch: 'main', dirty: false, missing: false }
      : [],
  );
  setStore({
    documentWorkspacesEnabled: true,
    projects: [
      {
        id: 'docs',
        name: 'Release notes',
        path: '/projects/release',
        color: '',
        kind: 'document',
        documentPath: 'notes.md',
      },
    ],
  });
  await openDocumentWorkspace('docs');
}

function backButton(host: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === '← Back') ??
    null
  );
}

describe('document trail', () => {
  it('remembers the document a link left and returns to it', async () => {
    await openWorkspace();
    expect(previousDocumentPath()).toBeNull();

    await openDocumentFile('notes/invoice.md');
    expect(documentStore.documentPath).toBe('notes/invoice.md');
    expect(previousDocumentPath()).toBe('notes.md');

    await openDocumentFile('notes/invoice.md');
    expect(previousDocumentPath()).toBe('notes.md');

    await goBackDocument();
    expect(documentStore.documentPath).toBe('notes.md');
    expect(previousDocumentPath()).toBeNull();

    await goBackDocument();
    expect(documentStore.documentPath).toBe('notes.md');
  });

  it('starts every workspace with an empty trail', async () => {
    await openWorkspace();
    await openDocumentFile('notes/invoice.md');
    closeDocumentWorkspace();
    expect(previousDocumentPath()).toBeNull();

    await openWorkspace();
    expect(previousDocumentPath()).toBeNull();
  });

  it('offers a Back button in the header once a link has been followed', async () => {
    await openWorkspace();
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(render(() => <DocumentWorkspaceOverlay />, host));
    expect(backButton(host)).toBeNull();

    await openDocumentFile('notes/invoice.md');
    const back = backButton(host);
    expect(back?.title).toBe('Back to notes.md');

    back?.click();
    await vi.waitFor(() => expect(documentStore.documentPath).toBe('notes.md'));
    expect(backButton(host)).toBeNull();
  });
});
