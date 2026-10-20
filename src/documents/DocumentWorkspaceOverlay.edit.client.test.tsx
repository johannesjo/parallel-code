import { render } from 'solid-js/web';
import { Show } from 'solid-js';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { applyBlockWrite } from '../lib/canvas-blocks';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';
import type { CanvasWrite } from '../components/TaskCanvasEditor';
import { focusAnnotation } from './workspace-ui';
import { DocumentWorkspacePanel } from './DocumentWorkspacePanel';
import {
  closeDocumentWorkspace,
  documentStore,
  openDocumentFile,
  openDocumentWorkspace,
  openDocumentCompare,
  setDocumentView,
  commitDocumentEdits,
  addDocumentAnnotation,
  setDocumentSelection,
} from './store';

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(),
  Channel: class {
    dispose() {}
  },
}));
vi.mock('../lib/shell', () => ({ openInEditor: vi.fn(), revealItemInDir: vi.fn() }));
vi.mock('./RightPanel', () => ({ RightPanel: () => <div /> }));

let dispose: (() => void) | undefined;
let host: HTMLElement;
let files: Record<string, string>;
let dirty = false;

beforeEach(() => {
  localStorage.clear();
  dirty = false;
  files = { 'notes.md': '# Notes\n', 'other.markdown': '# Other\n', 'page.html': '<h1>HTML</h1>' };
  vi.mocked(invoke).mockClear();
  vi.mocked(invoke).mockImplementation(async (channel, args) => {
    const path = String(args?.documentPath);
    if (channel === IPC.ReadDocument)
      return {
        content: files[path] ?? '',
        missing: !(path in files),
        headSha: 'abc',
        branch: 'main',
        dirty,
      };
    if (channel === IPC.SaveDocumentAnnotation) return args?.annotation;
    if (channel === IPC.WriteDocumentBlock) {
      const write = args as unknown as CanvasWrite;
      if (write.expectedContent !== files[path]) throw new Error('Document changed on disk');
      files[path] = applyBlockWrite(files[path], write);
    }
    return [];
  });
  setStore({
    documentWorkspacesEnabled: true,
    availableAgents: [],
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
});

afterEach(() => {
  // Leaving commits asynchronously; a dirty mock must not leak into the next test.
  dirty = false;
  closeDocumentWorkspace();
  dispose?.();
  document.body.replaceChildren();
  localStorage.clear();
  setStore({
    projects: [],
    activeDocumentProjectId: null,
    documentWorkspacesEnabled: false,
    tasks: {},
    agents: {},
    activeTaskId: null,
    activeAgentId: null,
  });
  vi.restoreAllMocks();
});

async function mount() {
  await openDocumentWorkspace('docs');
  host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => (
      <Show when={store.activeDocumentProjectId}>
        <DocumentWorkspacePanel />
      </Show>
    ),
    host,
  );
}

function button(label: string) {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
}

function edit(text = 'My edit\n') {
  button('Edit')?.click();
  const content = host.querySelector<HTMLElement>('.cm-content');
  expect(content).not.toBeNull();
  if (!content) throw new Error('Editor did not mount');
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error('Editor view is missing');
  view.dispatch({ changes: { from: 0, insert: text } });
  return view;
}

it('offers editing only for Markdown and saves before returning to Preview', async () => {
  await mount();
  edit();
  button('Preview')?.click();
  await vi.waitFor(() => expect(files['notes.md']).toContain('My edit'));
  await vi.waitFor(() => expect(button('Preview')?.getAttribute('aria-pressed')).toBe('true'));
  expect(documentStore.snapshot?.content).toContain('My edit');
  await openDocumentFile('page.html');
  expect(button('Edit')).toBeUndefined();
  await openDocumentFile('other.markdown');
  expect(button('Edit')).toBeDefined();
});

it('keeps edits when switching files and when closing the workspace immediately', async () => {
  await mount();
  edit('Unfinished\n');
  await openDocumentFile('other.markdown');
  await vi.waitFor(() => expect(files['notes.md']).toContain('Unfinished'));
  await openDocumentFile('notes.md');
  closeDocumentWorkspace();
  // Leaving flushes the editor, so the text lands in the file rather than a draft.
  await vi.waitFor(() => expect(files['notes.md']).toContain('Unfinished'));
  await openDocumentWorkspace('docs');
  expect(documentStore.snapshot?.content).toContain('Unfinished');
});

const commits = () =>
  vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.CommitDocumentEdits);

it('records a version when the workspace closes with uncommitted edits', async () => {
  await mount();
  dirty = true;
  closeDocumentWorkspace();
  await vi.waitFor(() => expect(commits()).toHaveLength(1));
  expect(commits()[0][1]).toEqual({ projectRoot: '/docs' });
});

it('records a version when switching documents with uncommitted edits', async () => {
  await mount();
  dirty = true;
  await openDocumentFile('other.markdown');
  await vi.waitFor(() => expect(commits()).toHaveLength(1));
});

it('leaves silently when closing or switching with nothing changed', async () => {
  await mount();
  await openDocumentFile('other.markdown');
  closeDocumentWorkspace();
  await vi.waitFor(() =>
    expect(
      vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.ReadDocument).length,
    ).toBeGreaterThan(2),
  );
  // The commit is a no-op on a clean tree: nothing to announce.
  await vi.waitFor(() => expect(commits().length).toBeGreaterThan(0));
  expect(store.notification).toBeNull();
});

it("opens the live editor at the selected block's first line", async () => {
  files['notes.md'] = '# Notes\n\nFirst.\n\nSecond paragraph.\n';
  await mount();
  setDocumentSelection({
    startBlock: 2,
    endBlock: 2,
    startLine: 5,
    endLine: 5,
    quote: 'Second paragraph.',
    heading: 'Notes',
    wholeDocument: false,
  });
  button('Edit')?.click();
  const content = host.querySelector<HTMLElement>('.cm-content');
  const view = content && EditorView.findFromDOM(content);
  if (!view) throw new Error('Editor view is missing');
  expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(5);
  expect(host.textContent).not.toContain('Edit block');
});

it('flushes edits before opening comparison or history', async () => {
  await mount();
  edit();
  openDocumentCompare('run');
  await vi.waitFor(() => expect(documentStore.compareRunId).toBe('run'));
  expect(files['notes.md']).toContain('My edit');
  edit('Another edit\n');
  setDocumentView('history');
  await vi.waitFor(() => expect(documentStore.view).toBe('history'));
  expect(files['notes.md']).toContain('Another edit');
});

it('flushes edits before committing them, so the commit includes what is on screen', async () => {
  await mount();
  edit('Committed edit\n');
  expect(await commitDocumentEdits()).toBe(true);
  // The editor holds the newest text until autosave fires. Committing without flushing first
  // would commit the file as it was before the user's last keystrokes.
  expect(files['notes.md']).toContain('Committed edit');
  const order = vi
    .mocked(invoke)
    .mock.calls.map(([channel]) => channel)
    .filter((channel) => channel === IPC.WriteDocumentBlock || channel === IPC.CommitDocumentEdits);
  expect(order.at(-1)).toBe(IPC.CommitDocumentEdits);
  expect(order).toContain(IPC.WriteDocumentBlock);
});

it('stays in Edit on save conflict and does not open a comparison against stale text', async () => {
  await mount();
  edit();
  files['notes.md'] = '# Agent revision\n';
  button('Preview')?.click();
  await vi.waitFor(() => expect(host.textContent).toContain('Document changed on disk'));
  expect(button('Edit')?.getAttribute('aria-pressed')).toBe('true');
  openDocumentCompare('run');
  await Promise.resolve();
  expect(documentStore.compareRunId).toBeNull();
  expect(files['notes.md']).toBe('# Agent revision\n');
});

async function addNote(path = 'notes.md') {
  const note = await addDocumentAnnotation('note', 'A note to revisit', {
    path,
    baseSha: 'abc',
    startLine: 1,
    endLine: 1,
    quote: path === 'notes.md' ? '# Notes' : '<h1>HTML</h1>',
    prefix: '',
    suffix: '',
  });
  if (!note) throw new Error('Note was not saved');
  return note;
}

it('saves an editor draft and switches to Preview when revealing a note', async () => {
  await mount();
  const note = await addNote();
  edit('New text\n\n');
  focusAnnotation(note.id);
  await vi.waitFor(() => expect(button('Preview')?.getAttribute('aria-pressed')).toBe('true'));
  expect(files['notes.md']).toContain('New text');
  expect(host.querySelector('.docws-scroll')?.classList.contains('is-hidden')).toBe(false);
});

it('keeps the editor visible if saving fails while revealing a note, and permits retry', async () => {
  await mount();
  const note = await addNote();
  edit();
  const original = vi.mocked(invoke).getMockImplementation();
  if (!original) throw new Error('No IPC mock');
  vi.mocked(invoke).mockImplementation(async (channel, args) => {
    if (channel === IPC.WriteDocumentBlock) throw new Error('Save failed');
    return original(channel, args);
  });
  focusAnnotation(note.id);
  await vi.waitFor(() => expect(host.textContent).toContain('Save failed'));
  expect(button('Edit')?.getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('.docws-marker-pop.is-open')).toBeNull();
  vi.mocked(invoke).mockImplementation(original);
  focusAnnotation(note.id);
  await vi.waitFor(() => expect(button('Preview')?.getAttribute('aria-pressed')).toBe('true'));
});

it('keeps Rewrite in its place, hidden and off, while the Markdown is edited', async () => {
  await mount();
  const rewrite = button('Rewrite');
  expect(rewrite?.style.visibility).toBe('visible');

  edit();

  expect(button('Rewrite')).toBe(rewrite);
  expect(rewrite?.style.visibility).toBe('hidden');
  expect(rewrite?.disabled).toBe(true);
});
