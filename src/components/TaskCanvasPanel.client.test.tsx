import { render } from 'solid-js/web';
import { createStore } from 'solid-js/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import {
  sendPrompt,
  openCanvasDocument,
  activateCanvasTab,
  closeCanvasTab,
  closeTaskCanvas,
  registerFocusFn,
  setTaskFocusedPanel,
  unregisterFocusFn,
} from '../store/store';
import type { Task } from '../store/types';
import { TaskCanvasPanel } from './TaskCanvasPanel';
import { CANVAS_AUTOSAVE_IDLE_MS } from './TaskCanvasEditor';

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(),
}));

vi.mock('../store/store', () => ({
  sendPrompt: vi.fn(async () => undefined),
  isAgentAskingQuestion: () => false,
  setTaskFocusedPanel: vi.fn(),
  registerFocusFn: vi.fn(),
  unregisterFocusFn: vi.fn(),
  isPanelFocused: () => false,
  openCanvasDocument: vi.fn(),
  activateCanvasTab: vi.fn(),
  closeCanvasTab: vi.fn(),
  closeTaskCanvas: vi.fn(),
}));

const disposers: Array<() => void> = [];
let changedListeners: Array<(payload: unknown) => void> = [];

beforeEach(() => {
  vi.mocked(registerFocusFn).mockClear();
  vi.mocked(unregisterFocusFn).mockClear();
  vi.mocked(setTaskFocusedPanel).mockImplementation((taskId, panel) => {
    vi.mocked(registerFocusFn).mock.calls.find(([key]) => key === `${taskId}:${panel}`)?.[1]();
  });
  vi.mocked(setTaskFocusedPanel).mockClear();
  changedListeners = [];
  Object.assign(window, {
    electron: {
      ipcRenderer: {
        on: (channel: string, cb: (payload: unknown) => void) => {
          if (channel === IPC.DocumentChanged) changedListeners.push(cb);
          return () => undefined;
        },
      },
    },
  });
});

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  vi.mocked(invoke).mockReset();
  vi.mocked(sendPrompt).mockClear();
  vi.mocked(openCanvasDocument).mockClear();
  vi.mocked(activateCanvasTab).mockClear();
  vi.mocked(closeCanvasTab).mockClear();
  vi.mocked(closeTaskCanvas).mockClear();
});

const SOURCE = '# Design\n\nKeep state in one **store**.\n';
const PARAGRAPH_START = SOURCE.indexOf('Keep');
const PARAGRAPH_END = SOURCE.length - 1;

function mockIpc(content = SOURCE) {
  vi.mocked(invoke).mockImplementation(((channel: string) => {
    switch (channel) {
      case IPC.ListDocumentFiles:
        return Promise.resolve(['README.md', 'docs/design.md', 'docs/notes.md', 'src/a.ts']);
      case IPC.GetUncommittedChangedFiles:
        return Promise.resolve([
          {
            path: 'docs/notes.md',
            status: 'M',
            lines_added: 1,
            lines_removed: 0,
            committed: false,
          },
          { path: 'src/a.ts', status: 'M', lines_added: 1, lines_removed: 0, committed: false },
        ]);
      case IPC.ReadDocument:
        return Promise.resolve({
          content,
          headSha: 'abc',
          branch: 'main',
          dirty: false,
          missing: false,
        });
      default:
        return Promise.resolve(undefined);
    }
  }) as typeof invoke);
}

const md = (path: string) => ({ kind: 'markdown' as const, path });

function baseTask(canvasPath?: string): Task {
  return {
    id: 'task-1',
    name: 'Task',
    projectId: 'project-1',
    branchName: 'task/canvas',
    worktreePath: '/tmp/task',
    agentIds: ['agent-1'],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
    canvasTabs: canvasPath ? [md(canvasPath)] : undefined,
    canvasActiveTab: canvasPath ? `markdown:${canvasPath}` : undefined,
    canvasOpen: true,
  };
}

function mount(canvasPath?: string) {
  const [task, setTask] = createStore<Task>(baseTask(canvasPath));
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(render(() => <TaskCanvasPanel task={task} agentId="agent-1" />, container));
  return { container, setTask };
}

async function waitFor<T>(probe: () => T | null | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Condition never became true');
}

const calls = (channel: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === channel);
const options = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.textContent);
const saveButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('[title^="Save to disk"]');

/** Waits for the editor to show `text`, then returns its paragraph. */
async function editorParagraph(container: HTMLElement, text: string): Promise<HTMLElement> {
  const editor = await waitFor(() =>
    container.querySelector<HTMLElement>('[data-testid="canvas-editor"]'),
  );
  return waitFor(() => {
    const p = editor.querySelector<HTMLElement>('.ProseMirror p');
    return p?.textContent === text ? p : null;
  });
}

/** Types by changing the DOM, which is what ProseMirror watches for. */
function typeInto(paragraph: HTMLElement, text: string): void {
  const node = paragraph.firstChild;
  if (!(node instanceof Text)) throw new Error('Paragraph does not start with text');
  node.textContent = text;
}

function pushFromDisk(content: string): void {
  for (const cb of changedListeners) {
    cb({
      key: 'task-canvas:task-1:docs/design.md',
      snapshot: { content, headSha: 'abc', branch: 'main', dirty: true, missing: false },
    });
  }
}

describe('TaskCanvasPanel', () => {
  it('enters the active document editor with Enter from the canvas panel', async () => {
    mockIpc();
    const { container, setTask } = mount('docs/design.md');
    await editorParagraph(container, 'Keep state in one store.');
    const activePath = 'docs/notes "draft".md';
    setTask({
      canvasTabs: [md('docs/design.md'), md(activePath)],
      canvasActiveTab: `markdown:${activePath}`,
    });
    const activeEditor = await waitFor(() =>
      [...container.querySelectorAll<HTMLElement>('[data-testid="canvas-document"]')]
        .find((document) => document.dataset.path === activePath)
        ?.querySelector<HTMLElement>('.ProseMirror'),
    );
    const panel = container.querySelector<HTMLElement>('[data-testid="task-canvas"]');
    panel?.focus();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    panel?.dispatchEvent(enter);
    expect(document.activeElement).toBe(activeEditor);
    expect(enter.defaultPrevented).toBe(true);
    expect(saveButton(container)).toBeNull();
    expect(calls(IPC.WriteDocumentBlock)).toHaveLength(0);
  });

  it('leaves Enter on canvas tabs to their own activation handler', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    await editorParagraph(container, 'Keep state in one store.');
    const tab = container.querySelector<HTMLElement>('[role="tab"]');
    tab?.focus();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    tab?.dispatchEvent(enter);
    expect(activateCanvasTab).toHaveBeenCalledWith('task-1', 'markdown:docs/design.md');
    expect(document.activeElement).toBe(tab);
    expect(enter.defaultPrevented).toBe(false);
  });

  it('returns focus from the editor to the canvas with Escape without losing edits', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    const paragraph = await editorParagraph(container, 'Keep state in one store.');
    const editor = container.querySelector<HTMLElement>('.ProseMirror');
    editor?.focus();
    typeInto(paragraph, 'Keep all state in one ');
    await waitFor(() => saveButton(container));
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      keyCode: 27,
      bubbles: true,
      cancelable: true,
    });
    editor?.dispatchEvent(escape);
    const panel = container.querySelector<HTMLElement>('[data-testid="task-canvas"]');
    expect(document.activeElement).toBe(panel);
    expect(escape.defaultPrevented).toBe(true);
    expect(paragraph.textContent).toBe('Keep all state in one store.');
    expect(saveButton(container)).not.toBeNull();
    panel?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.activeElement).toBe(editor);
  });

  it('receives keyboard focus without stealing focus from its editor', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    await editorParagraph(container, 'Keep state in one store.');
    const focus = vi
      .mocked(registerFocusFn)
      .mock.calls.find(([key]) => key === 'task-1:canvas')?.[1];
    expect(focus).toBeDefined();
    focus?.();
    expect(document.activeElement).toBe(container.querySelector('[data-testid="task-canvas"]'));

    const editor = container.querySelector<HTMLElement>('.ProseMirror');
    editor?.focus();
    expect(setTaskFocusedPanel).toHaveBeenCalledWith('task-1', 'canvas');
    focus?.();
    expect(document.activeElement).toBe(editor);

    disposers.pop()?.();
    expect(unregisterFocusFn).toHaveBeenCalledWith('task-1:canvas');
  });

  it('opens the picker by itself when the column has no file, changed files first', async () => {
    mockIpc();
    const { container } = mount();
    await waitFor(() => options(container).length === 3);
    expect(options(container)).toEqual(['docs/notes.md', 'README.md', 'docs/design.md']);
    expect(container.textContent).toContain('Changed in this task');
    expect(calls(IPC.StartDocumentWatcher)).toHaveLength(0);

    const input = await waitFor(() => container.querySelector('input'));
    input.value = 'des';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => options(container).length === 1);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(openCanvasDocument).toHaveBeenCalledWith('task-1', 'docs/design.md');
  });

  it('keeps keyboard focus inside the discard confirmation dialog', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    const paragraph = await editorParagraph(container, 'Keep state in one store.');
    typeInto(paragraph, 'Keep all state in one ');
    await waitFor(() => saveButton(container));
    container.querySelector<HTMLButtonElement>('[aria-label="Close design.md"]')?.click();
    const dialog = await waitFor(() => document.querySelector<HTMLElement>('[role="dialog"]'));
    const buttons = dialog.querySelectorAll<HTMLButtonElement>('button');
    const cancel = [...buttons].find((button) => button.textContent === 'Cancel');
    const discard = [...buttons].find((button) => button.textContent === 'Discard');
    expect(cancel).toBeDefined();
    expect(discard).toBeDefined();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(document.activeElement).toBe(cancel);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(discard);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(cancel);
  });

  it('shows the open file in the editor, watches it, and follows changes pushed from disk', async () => {
    mockIpc();
    const { container, setTask } = mount('docs/design.md');
    const paragraph = await editorParagraph(container, 'Keep state in one store.');
    expect(paragraph.querySelector('strong')?.textContent).toBe('store');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(calls(IPC.StartDocumentWatcher)[0][1]).toMatchObject({
      key: 'task-canvas:task-1:docs/design.md',
      projectRoot: '/tmp/task',
      documentPath: 'docs/design.md',
    });

    pushFromDisk('# Changed\n');
    await waitFor(() => container.querySelector('h1')?.textContent === 'Changed');
    expect(saveButton(container)).toBeNull();

    setTask({ canvasTabs: undefined, canvasActiveTab: undefined });
    await waitFor(() => calls(IPC.StopDocumentWatcher).length === 1);
    expect(container.querySelector('[data-testid="canvas-editor"]')).toBeNull();
  });

  it('writes an edited paragraph back as one block, guarded by the source it came from', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    const paragraph = await editorParagraph(container, 'Keep state in one store.');
    typeInto(paragraph, 'Keep all state in one ');
    const save = await waitFor(() => saveButton(container));
    save.click();

    await waitFor(() => calls(IPC.WriteDocumentBlock).length === 1);
    expect(calls(IPC.WriteDocumentBlock)[0][1]).toEqual({
      projectRoot: '/tmp/task',
      documentPath: 'docs/design.md',
      expectedContent: SOURCE,
      startOffset: PARAGRAPH_START,
      endOffset: PARAGRAPH_END,
      replacement: 'Keep all state in one **store**.',
    });
    await waitFor(() => saveButton(container) === null);
    expect(paragraph.textContent).toBe('Keep all state in one store.');
  });

  it('saves by itself once typing pauses', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    const paragraph = await editorParagraph(container, 'Keep state in one store.');
    typeInto(paragraph, 'Keep state in one place, one ');
    await waitFor(() => saveButton(container));
    await new Promise((resolve) => setTimeout(resolve, CANVAS_AUTOSAVE_IDLE_MS + 100));
    expect(calls(IPC.WriteDocumentBlock)).toHaveLength(1);
    expect(calls(IPC.WriteDocumentBlock)[0][1]).toMatchObject({
      replacement: 'Keep state in one place, one **store**.',
    });
  });

  it('keeps unsaved edits when the file changes on disk, until told to drop them', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    const paragraph = await editorParagraph(container, 'Keep state in one store.');
    typeInto(paragraph, 'Keep all state in one ');
    await waitFor(() => saveButton(container));

    pushFromDisk('# Changed\n');
    await waitFor(() => container.textContent?.includes('changed on disk'));
    expect(paragraph.textContent).toBe('Keep all state in one store.');

    const reload = await waitFor(() =>
      [...container.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Reload and drop my edits'),
      ),
    );
    reload.click();
    await waitFor(() => container.querySelector('h1')?.textContent === 'Changed');
    expect(saveButton(container)).toBeNull();
    expect(container.textContent).not.toContain('changed on disk');
  });

  it('closes a tab or the column through the store when there is nothing to lose', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    await editorParagraph(container, 'Keep state in one store.');
    container.querySelector<HTMLButtonElement>('[aria-label="Close design.md"]')?.click();
    expect(closeCanvasTab).toHaveBeenCalledWith('task-1', 'markdown:docs/design.md');
    container.querySelector<HTMLButtonElement>('[title="Close the canvas"]')?.click();
    expect(closeTaskCanvas).toHaveBeenCalledWith('task-1');
  });

  it('keeps every tab mounted, shows the active one, and marks unsaved edits on its tab', async () => {
    mockIpc();
    const { container, setTask } = mount('docs/design.md');
    const paragraph = await editorParagraph(container, 'Keep state in one store.');
    setTask({
      canvasTabs: [md('docs/design.md'), md('docs/notes.md')],
      canvasActiveTab: 'markdown:docs/notes.md',
    });
    await waitFor(() => container.querySelectorAll('[data-testid="canvas-document"]').length === 2);
    const documents = container.querySelectorAll<HTMLElement>('[data-testid="canvas-document"]');
    expect(documents[0].style.display).toBe('none');
    expect(documents[1].style.display).toBe('flex');
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      'notes.md',
    );

    typeInto(paragraph, 'Keep all state in one ');
    const closeDesign = await waitFor(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Close design.md"]'),
    );
    await waitFor(() => closeDesign.title.startsWith('Unsaved'));
    closeDesign.click();
    expect(closeCanvasTab).not.toHaveBeenCalled();
    // The dialog renders in a portal on the body.
    expect(document.body.textContent).toContain('This tab has unsaved edits');
  });

  it('forgets the unsaved edits of a tab once it is gone', async () => {
    mockIpc();
    const { container, setTask } = mount('docs/design.md');
    const paragraph = await editorParagraph(container, 'Keep state in one store.');
    typeInto(paragraph, 'Keep all state in one ');
    await waitFor(() => saveButton(container));
    setTask({ canvasTabs: [md('docs/notes.md')], canvasActiveTab: 'markdown:docs/notes.md' });
    await waitFor(() => container.querySelector('[data-path="docs/notes.md"]'));

    container.querySelector<HTMLButtonElement>('[title="Close the canvas"]')?.click();
    expect(closeTaskCanvas).toHaveBeenCalledWith('task-1');
    expect(document.body.textContent).not.toContain('unsaved edits');
  });

  it('offers the kinds of canvas behind + and opens the file picker for Markdown', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    await editorParagraph(container, 'Keep state in one store.');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    container.querySelector<HTMLButtonElement>('[title="Open another canvas"]')?.click();
    const item = await waitFor(() =>
      container.querySelector<HTMLButtonElement>('[role="menuitem"]'),
    );
    expect(item.textContent).toBe('Markdown file…');
    item.click();
    await waitFor(() => options(container).length === 3);
    expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toBe(
      'docs/design.md',
    );
  });

  it('sends a selected passage to the agent with the instruction and its lines in the file', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    const paragraph = await editorParagraph(container, 'Keep state in one store.');
    // ProseMirror reads the DOM selection only while it has focus.
    container.querySelector<HTMLElement>('.ProseMirror')?.focus();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    const input = await waitFor(() =>
      container.querySelector<HTMLInputElement>('input[aria-label^="Instruction"]'),
    );
    input.value = 'Why one store?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => vi.mocked(sendPrompt).mock.calls.length === 1);
    expect(vi.mocked(sendPrompt).mock.calls[0]).toEqual([
      'task-1',
      'agent-1',
      [
        'Why one store?',
        'Document: docs/design.md',
        'Scope: lines 3-3 (under "Design").',
        'The passage, verbatim:\n> Keep state in one store.',
      ].join('\n\n'),
    ]);
  });
});
