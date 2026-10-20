import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { setStore } from '../store/core';
import { RunComposer } from './RunComposer';
import {
  closeDocumentWorkspace,
  documentStore,
  openDocumentWorkspace,
  setDocumentComposerDraft,
  setDocumentSelection,
} from './store';
import type { DocumentBlock } from './markdown-blocks';

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(),
  Channel: class {
    dispose() {}
  },
}));
vi.mock('./agent-task', () => ({ sendToDocumentAgent: vi.fn() }));

const blocks: DocumentBlock[] = [
  {
    index: 0,
    type: 'paragraph',
    raw: 'Body text.',
    html: '<p>Body text.</p>',
    startLine: 1,
    endLine: 1,
  },
];
const passage = {
  startBlock: 0,
  endBlock: 0,
  startLine: 1,
  endLine: 1,
  quote: 'Body text.',
  wholeDocument: false,
};
let dispose: (() => void) | undefined;
let host: HTMLDivElement;
let release: (() => void) | undefined;
let failure = false;
let saveCount = 0;

beforeEach(async () => {
  saveCount = 0;
  failure = false;
  vi.mocked(invoke).mockImplementation(async (channel, args) => {
    if (channel === IPC.ReadDocument)
      return { content: 'Body text.', headSha: 'abc', missing: false };
    if (channel === IPC.SaveDocumentAnnotation) {
      saveCount++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (failure) throw new Error('Disk unavailable');
      return args?.annotation;
    }
    return [];
  });
  setStore({
    documentWorkspacesEnabled: true,
    projects: [
      {
        id: 'docs',
        name: 'Docs',
        path: '/docs',
        color: '',
        kind: 'document',
        documentPath: 'notes.md',
      },
    ],
  });
  await openDocumentWorkspace('docs');
  setDocumentSelection(passage);
  setDocumentComposerDraft({ text: 'Remember this.', mode: 'note' });
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  dispose?.();
  setDocumentComposerDraft({ text: ' ', mode: 'note' });
  closeDocumentWorkspace();
  document.body.replaceChildren();
  setStore({ projects: [], documentWorkspacesEnabled: false });
  vi.clearAllMocks();
});

function mount() {
  dispose = render(
    () => (
      <RunComposer
        selection={passage}
        blocks={blocks}
        onClose={() => setDocumentComposerDraft(null)}
      />
    ),
    host,
  );
  const textarea = host.querySelector('textarea');
  if (!textarea) throw new Error('No note field');
  return textarea;
}

it('shares one pending save across blur, close and remount', async () => {
  mount().dispatchEvent(new FocusEvent('blur'));
  expect(documentStore.composerDraft?.noteSaveStatus).toBe('saving');
  dispose?.();
  const textarea = mount();
  expect(textarea.disabled).toBe(true);
  textarea.dispatchEvent(new FocusEvent('blur'));
  host.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click();
  expect(saveCount).toBe(1);
  release?.();
  await vi.waitFor(() => expect(documentStore.composerDraft).toBeNull());
  expect(documentStore.annotations).toHaveLength(1);
});

it('retains a failed note and retries with the same annotation ID', async () => {
  failure = true;
  mount().dispatchEvent(new FocusEvent('blur'));
  const id = documentStore.composerDraft?.id;
  release?.();
  await vi.waitFor(() => expect(documentStore.composerDraft?.noteSaveStatus).toBe('error'));
  expect(host.querySelector('textarea')?.value).toBe('Remember this.');
  expect(host.textContent).toContain('Not saved');
  failure = false;
  Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent === 'Retry')
    ?.click();
  release?.();
  await vi.waitFor(() => expect(documentStore.composerDraft).toBeNull());
  expect(documentStore.annotations[0]?.id).toBe(id);
});

it('does not clear a newer draft when an earlier note finishes saving', async () => {
  mount().dispatchEvent(new FocusEvent('blur'));
  setDocumentComposerDraft({ text: 'A different instruction', mode: 'proposals' });
  release?.();
  await vi.waitFor(() => expect(documentStore.annotations).toHaveLength(1));
  expect(documentStore.composerDraft?.text).toBe('A different instruction');
  expect(documentStore.selection).not.toBeNull();
});

it('does not put a saved note into a workspace that has been closed', async () => {
  mount().dispatchEvent(new FocusEvent('blur'));
  closeDocumentWorkspace();
  release?.();
  await vi.waitFor(() => expect(documentStore.composerDraft).toBeNull());
  await Promise.resolve();
  expect(documentStore.annotations).toHaveLength(0);
});

it('recovers a note when saving fails after its workspace was closed', async () => {
  failure = true;
  mount().dispatchEvent(new FocusEvent('blur'));
  const id = documentStore.composerDraft?.id;
  closeDocumentWorkspace();
  release?.();
  await vi.waitFor(() =>
    expect(localStorage.getItem('document-note-draft:["/docs","notes.md"]')).toContain(
      'Remember this.',
    ),
  );
  await Promise.resolve();
  await openDocumentWorkspace('docs');
  expect(documentStore.composerDraft).toMatchObject({ id, text: 'Remember this.', mode: 'note' });
  expect(documentStore.selection).toBeNull();
});

it('allows an unanchored note to close and restores its draft when reopened', () => {
  dispose = render(
    () => (
      <RunComposer
        selection={null}
        blocks={blocks}
        onClose={() => setDocumentComposerDraft(null)}
      />
    ),
    host,
  );
  host.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click();
  expect(documentStore.composerDraft).toBeNull();
  setDocumentComposerDraft({ text: '', mode: 'note' });
  expect(documentStore.composerDraft?.text).toBe('Remember this.');
  expect(saveCount).toBe(0);
});

it('clears keys a replacing draft leaves out instead of merging them in', () => {
  setDocumentComposerDraft({ text: 'Make it a task.', annotationId: 'a1', mode: 'proposals' });
  setDocumentComposerDraft({ text: 'Fresh.', mode: 'task' });
  expect(documentStore.composerDraft?.annotationId).toBeUndefined();
  expect(documentStore.composerDraft?.mode).toBe('task');
});

it('closes without retrying once a save has failed, keeping the draft for later', async () => {
  failure = true;
  mount().dispatchEvent(new FocusEvent('blur'));
  release?.();
  await vi.waitFor(() => expect(documentStore.composerDraft?.noteSaveStatus).toBe('error'));
  host.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click();
  expect(documentStore.composerDraft).toBeNull();
  expect(saveCount).toBe(1);
  setDocumentComposerDraft({ text: '', mode: 'note' });
  expect(documentStore.composerDraft?.text).toBe('Remember this.');
});

it('keeps the note open when the whole window loses focus', () => {
  const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  mount().dispatchEvent(new FocusEvent('blur'));
  hasFocus.mockRestore();
  expect(saveCount).toBe(0);
  expect(documentStore.composerDraft?.text).toBe('Remember this.');
});

it('forgets a comment once its text moves to Rewrite or Ask', () => {
  setDocumentComposerDraft({
    ...documentStore.composerDraft,
    text: 'Remember this.',
    mode: 'proposals',
  });
  setDocumentComposerDraft(null);
  setDocumentComposerDraft({ text: '', mode: 'note' });
  expect(documentStore.composerDraft?.text).toBe('');
  expect(localStorage.getItem('document-note-draft:["/docs","notes.md"]')).toBeNull();
});

it('lets a comment whose save failed move to Ask without coming back later', async () => {
  failure = true;
  mount().dispatchEvent(new FocusEvent('blur'));
  release?.();
  await vi.waitFor(() => expect(documentStore.composerDraft?.noteSaveStatus).toBe('error'));
  setDocumentComposerDraft({ text: 'Remember this.', mode: 'question' });
  expect(documentStore.composerDraft?.noteSaveStatus).toBeUndefined();
  expect(localStorage.getItem('document-note-draft:["/docs","notes.md"]')).toBeNull();
});
