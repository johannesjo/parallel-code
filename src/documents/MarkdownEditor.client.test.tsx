import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { applyBlockWrite } from '../lib/canvas-blocks';
import { invoke } from '../lib/ipc';
import type { CanvasWrite } from '../components/TaskCanvasEditor';
import { MarkdownEditor } from './MarkdownEditor';
import { flushMarkdownEditor } from './markdown-editing';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));

let dispose: (() => void) | undefined;
let disk: string;
let host: HTMLElement;
const SOURCE = '# Notes\r\n\r\nOriginal.\r\n';

beforeEach(() => {
  disk = SOURCE;
  localStorage.clear();
  vi.mocked(invoke).mockImplementation(async (channel, args) => {
    if (channel === IPC.WriteDocumentBlock) {
      const write = args as unknown as CanvasWrite;
      if (write.expectedContent !== disk) throw new Error('The document changed while editing.');
      disk = applyBlockWrite(disk, write);
    }
  });
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

function mount() {
  const [source, setSource] = createSignal(disk);
  host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => (
      <MarkdownEditor
        projectRoot="/docs"
        documentPath="notes.md"
        source={source()}
        missing={false}
        onSaved={() => {
          setSource(disk);
        }}
      />
    ),
    host,
  );
  const container = host;
  return {
    get view() {
      const content = container.querySelector<HTMLElement>('.cm-content');
      if (!content) throw new Error('Editor did not mount');
      const view = EditorView.findFromDOM(content);
      if (!view) throw new Error('Editor did not mount');
      return view;
    },
    setSource,
  };
}

function deferNextWrite() {
  const writeToDisk = vi.mocked(invoke).getMockImplementation();
  if (!writeToDisk) throw new Error('IPC fixture is missing');
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(invoke).mockImplementationOnce(async (channel, args) => {
    await pending;
    return writeToDisk(channel, args);
  });
  return release;
}

it('retains undo made during a save across closing', async () => {
  const release = deferNextWrite();
  const { view } = mount();
  view.dispatch({ changes: { from: 0, insert: Text.of(['First edit', '']) } });
  const saving = flushMarkdownEditor();
  expect(undo(view)).toBe(true);
  dispose?.();
  release();
  await saving;
  expect(disk).toContain('First edit');
  const reopened = mount();
  expect(reopened.view.state.doc.toString()).toBe(SOURCE.replace(/\r\n/g, '\n'));
  expect(await flushMarkdownEditor()).toBe(true);
  expect(disk).toBe(SOURCE);
});

it('rebases subsequent typing on its own write when that write finishes after closing', async () => {
  const release = deferNextWrite();
  const { view } = mount();
  view.dispatch({ changes: { from: 0, insert: Text.of(['First edit', '']) } });
  const saving = flushMarkdownEditor();
  view.dispatch({ changes: { from: 0, insert: Text.of(['Second edit', '']) } });
  dispose?.();
  release();
  await saving;
  expect(disk).toContain('First edit');
  const reopened = mount();
  expect(reopened.view.state.doc.toString()).toContain('Second edit\nFirst edit');
  expect(await flushMarkdownEditor()).toBe(true);
  expect(disk).toContain('Second edit\r\nFirst edit');
});

it('waits for an older editor write before restoring and saving a reopened draft', async () => {
  const release = deferNextWrite();
  const { view } = mount();
  view.dispatch({ changes: { from: 0, insert: Text.of(['First edit', '']) } });
  const saving = flushMarkdownEditor();
  view.dispatch({ changes: { from: 0, insert: Text.of(['Second edit', '']) } });
  dispose?.();
  const reopened = mount();
  expect(host.querySelector('.cm-content')).toBeNull();
  const newSave = flushMarkdownEditor();
  release();
  await saving;
  expect(await newSave).toBe(true);
  expect(reopened.view.state.doc.toString()).toContain('Second edit\nFirst edit');
  expect(disk).toContain('Second edit\r\nFirst edit');
});

it('keeps a real external conflict after reconciling its own completed write', async () => {
  const release = deferNextWrite();
  const { view } = mount();
  view.dispatch({ changes: { from: 0, insert: Text.of(['First edit', '']) } });
  const saving = flushMarkdownEditor();
  view.dispatch({ changes: { from: 0, insert: Text.of(['Second edit', '']) } });
  dispose?.();
  release();
  await saving;
  disk = '# External revision\n';
  const reopened = mount();
  expect(reopened.view.state.doc.toString()).toContain('Second edit\nFirst edit');
  expect(await flushMarkdownEditor()).toBe(false);
  expect(disk).toBe('# External revision\n');
});

it('does not advance the recovery baseline when a write fails after closing', async () => {
  const release = deferNextWrite();
  const { view } = mount();
  view.dispatch({ changes: { from: 0, insert: Text.of(['First edit', '']) } });
  const saving = flushMarkdownEditor();
  view.dispatch({ changes: { from: 0, insert: Text.of(['Second edit', '']) } });
  dispose?.();
  disk = '# External revision\n';
  release();
  expect(await saving).toBe(false);
  disk = SOURCE;
  const reopened = mount();
  expect(reopened.view.state.doc.toString()).toContain('Second edit\nFirst edit');
  expect(await flushMarkdownEditor()).toBe(true);
});

it('saves directly with original line endings and preserves undo across saves', async () => {
  const { view } = mount();
  view.dispatch({
    changes: { from: view.state.doc.length, insert: Text.of('Added.\n'.split('\n')) },
  });
  expect(await flushMarkdownEditor()).toBe(true);
  expect(disk).toBe(SOURCE + 'Added.\r\n');
  expect(undo(view)).toBe(true);
  expect(await flushMarkdownEditor()).toBe(true);
  expect(disk).toBe(SOURCE);
});

it('keeps local text when a watcher reports an external edit and refuses to overwrite it', async () => {
  const { view, setSource } = mount();
  view.dispatch({ changes: { from: 0, insert: Text.of('My edit\n'.split('\n')) } });
  disk = '# Changed by the agent\n';
  setSource(disk);
  expect(view.state.doc.toString()).toContain('My edit');
  expect(await flushMarkdownEditor()).toBe(false);
  expect(disk).toBe('# Changed by the agent\n');
  expect(host.textContent).toContain('changed');
});

it('restores an unsaved draft after closing, keeping its original conflict baseline', async () => {
  const { view } = mount();
  view.dispatch({ changes: { from: 0, insert: Text.of('Unfinished\n'.split('\n')) } });
  dispose?.();
  disk = '# External edit\n';
  const reopened = mount();
  expect(reopened.view.state.doc.toString()).toContain('Unfinished');
  expect(await flushMarkdownEditor()).toBe(false);
  expect(disk).toBe('# External edit\n');
});

it('loads external changes while clean', () => {
  const { view, setSource } = mount();
  disk = '# Agent revision\n';
  setSource(disk);
  expect(view.state.doc.toString()).toBe(disk);
});

it('autosaves after typing pauses', async () => {
  const { view } = mount();
  view.dispatch({ changes: { from: 0, insert: Text.of('Autosaved\n'.split('\n')) } });
  await vi.waitFor(() => expect(disk).toContain('Autosaved'), { timeout: 3000 });
  await vi.waitFor(() => expect(host.textContent).not.toContain('Unsaved edits'));
});

it('keeps typing that happens while a save is in flight', async () => {
  const writeToDisk = vi.mocked(invoke).getMockImplementation();
  if (!writeToDisk) throw new Error('IPC fixture is missing');
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(invoke).mockImplementationOnce(async (channel, args) => {
    await pending;
    return writeToDisk(channel, args);
  });
  const { view } = mount();
  view.dispatch({ changes: { from: 0, insert: Text.of('First\n'.split('\n')) } });
  const saving = flushMarkdownEditor();
  view.dispatch({ changes: { from: 0, insert: Text.of('Second\n'.split('\n')) } });
  release?.();
  await saving;
  expect(view.state.doc.toString()).toContain('Second\nFirst');
  expect(disk).toContain('Second\r\nFirst');
});

it('does not resurrect an old draft when it already matches disk', () => {
  const { view } = mount();
  view.dispatch({ changes: { from: 0, insert: Text.of('Saved before close\n'.split('\n')) } });
  dispose?.();
  disk = 'Saved before close\r\n' + SOURCE;
  const reopened = mount();
  expect(reopened.view.state.doc.toString()).toContain('Saved before close');
  expect(host.textContent).not.toContain('Unsaved edits');
  expect(host.textContent).not.toContain('changed on disk');
});

it('warns if draft backup fails while still allowing a save to disk', async () => {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('Quota');
  });
  const { view } = mount();
  view.dispatch({ changes: { from: 0, insert: Text.of('Save me\n'.split('\n')) } });
  expect(host.textContent).toContain('Could not back up');
  expect(await flushMarkdownEditor()).toBe(true);
  expect(disk).toContain('Save me');
});

it('shows an external revision arriving during a save once the editor is clean', async () => {
  const writeToDisk = vi.mocked(invoke).getMockImplementation();
  if (!writeToDisk) throw new Error('IPC fixture is missing');
  vi.mocked(invoke).mockImplementationOnce(async (channel, args) => {
    await writeToDisk(channel, args);
    disk = '# New external revision\n';
  });
  const { view } = mount();
  view.dispatch({ changes: { from: 0, insert: 'My edit' } });
  await flushMarkdownEditor();
  expect(view.state.doc.toString()).toBe(disk);
});

it('asks a second time before a reload discards the draft', () => {
  const { view, setSource } = mount();
  view.dispatch({ changes: { from: 0, insert: Text.of('Mine\n'.split('\n')) } });
  setSource('# Theirs\r\n');
  const reload = () =>
    Array.from(host.querySelectorAll('button')).find((b) =>
      /Reload from disk|Discard my draft\?/.test(b.textContent ?? ''),
    );
  expect(host.textContent).toContain('changed on disk');

  reload()?.click();
  expect(view.state.doc.toString()).toContain('Mine');
  expect(reload()?.textContent).toContain('Discard my draft?');

  reload()?.click();
  expect(view.state.doc.toString()).toBe('# Theirs\n');
});

it('lets the discard offer lapse, so a later click only asks again', () => {
  const { view, setSource } = mount();
  view.dispatch({ changes: { from: 0, insert: Text.of('Mine\n'.split('\n')) } });
  setSource('# Theirs\r\n');
  const reload = () =>
    Array.from(host.querySelectorAll('button')).find((b) =>
      /Reload from disk|Discard my draft\?/.test(b.textContent ?? ''),
    );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    reload()?.click();
    vi.advanceTimersByTime(4000);
    expect(reload()?.textContent).toContain('Reload from disk');

    reload()?.click();
    expect(view.state.doc.toString()).toContain('Mine');
  } finally {
    vi.useRealTimers();
  }
});
