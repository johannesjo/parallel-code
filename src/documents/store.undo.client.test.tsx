import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { IPC } from '../../electron/ipc/channels';
import type { DocumentAnnotation } from '../../electron/documents/types';
import {
  closeDocumentWorkspace,
  deleteDocumentAnnotation,
  documentStore,
  loadDocumentAnnotations,
  openDocumentWorkspace,
  undoDeleteDocumentAnnotation,
} from './store';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('../lib/ipc', () => ({
  invoke,
  Channel: class {
    dispose() {}
  },
}));

afterEach(() => {
  closeDocumentWorkspace();
  setStore({ projects: [], activeDocumentProjectId: null, documentWorkspacesEnabled: false });
  vi.clearAllMocks();
});

function note(id: string): DocumentAnnotation {
  return {
    id,
    kind: 'note',
    anchor: { path: 'notes.md' } as DocumentAnnotation['anchor'],
    text: `Comment ${id}`,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    resolved: false,
  };
}

async function openWithNotes(notes: DocumentAnnotation[]): Promise<void> {
  invoke.mockImplementation(async (channel: string, args?: { annotation?: unknown }) => {
    if (channel === IPC.ReadDocument)
      return { content: '# Doc\n', headSha: 'abc1234', branch: 'main', dirty: false };
    if (channel === IPC.ListDocumentAnnotations) return notes;
    if (channel === IPC.SaveDocumentAnnotation) return args?.annotation;
    return [];
  });
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
  await loadDocumentAnnotations();
}

describe('undoing deleted comments', () => {
  it('restores each of several quick deletes, newest first', async () => {
    await openWithNotes([note('a'), note('b')]);

    await deleteDocumentAnnotation('a');
    await deleteDocumentAnnotation('b');
    expect(documentStore.annotations).toEqual([]);

    await undoDeleteDocumentAnnotation();
    expect(documentStore.annotations.map((a) => a.id)).toEqual(['b']);
    await undoDeleteDocumentAnnotation();
    expect(documentStore.annotations.map((a) => a.id).sort()).toEqual(['a', 'b']);
    expect(documentStore.recentlyDeleted).toEqual([]);
  });
});
