import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { IPC } from '../../electron/ipc/channels';
import { applyBlockWrite } from '../lib/canvas-blocks';
import { invoke } from '../lib/ipc';
import { openFileInEditor } from '../lib/shell';
import {
  sendPrompt,
  openCanvasDocument,
  activateCanvasTab,
  closeCanvasTab,
  closeTaskCanvas,
  registerAction,
  registerFocusFn,
  setTaskFocusedPanel,
  unregisterAction,
  unregisterFocusFn,
} from '../store/store';
import type { Task } from '../store/types';
import { TaskCanvasPanel } from './TaskCanvasPanel';
import { createUnderstandingTour } from '../lib/create-understanding-tour';
import { CANVAS_AUTOSAVE_IDLE_MS } from './TaskCanvasEditor';
import type { CanvasWrite } from './TaskCanvasEditor';

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(),
}));

vi.mock('../lib/shell', () => ({
  openFileInEditor: vi.fn(async () => undefined),
}));

vi.mock('../store/store', () => ({
  sendPrompt: vi.fn(async () => undefined),
  isAgentAskingQuestion: () => false,
  setTaskFocusedPanel: vi.fn(),
  registerFocusFn: vi.fn(),
  unregisterFocusFn: vi.fn(),
  registerAction: vi.fn(),
  unregisterAction: vi.fn(),
  isPanelFocused: () => false,
  showNotification: vi.fn(),
  openCanvasDocument: vi.fn(),
  openCanvasBrowser: vi.fn(),
  activateCanvasTab: vi.fn(),
  closeCanvasTab: vi.fn(),
  closeTaskCanvas: vi.fn(),
}));

const disposers: Array<() => void> = [];
let changedListeners: Array<(payload: unknown) => void> = [];

beforeEach(() => {
  vi.mocked(registerFocusFn).mockClear();
  vi.mocked(unregisterFocusFn).mockClear();
  vi.mocked(registerAction).mockClear();
  vi.mocked(unregisterAction).mockClear();
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

// The panel lazy-loads the document editor; transform it up front so the
// first test's polling budget is not spent compiling CodeMirror.
beforeAll(async () => {
  await import('./TaskCanvasDocument');
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
  vi.mocked(openFileInEditor).mockClear();
});

const SOURCE = '# Design\n\nKeep state in one **store**.\n';
/** Past TOUR_MIN_DOCUMENT_CHARS, so the strip offers a tour. */
const LONG_SOURCE = `${SOURCE}\n${'The store owns every task and its agents.\n'.repeat(60)}`;
const PARAGRAPH_START = SOURCE.indexOf('Keep');

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

function mount(canvasPath?: string, tour?: { onTakeTour: (path: string) => void }) {
  const [task, setTask] = createStore<Task>(baseTask(canvasPath));
  const [active, setActive] = createSignal(true);
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(
    render(
      () => (
        <TaskCanvasPanel
          task={task}
          agentId="agent-1"
          isActive={active()}
          understanding={tour ? createUnderstandingTour() : undefined}
          onTakeTour={tour?.onTakeTour}
        />
      ),
      container,
    ),
  );
  return { container, setTask, setActive };
}

function closeActiveCanvasTab(): void {
  const close = vi
    .mocked(registerAction)
    .mock.calls.find(([key]) => key === 'task-1:close-canvas-active-tab')?.[1];
  if (!close) throw new Error('Canvas close action was not registered');
  close();
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
const writtenContent = (args: unknown): string => {
  const write = args as CanvasWrite;
  return applyBlockWrite(write.expectedContent, write);
};
const options = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.textContent);
const saveButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('[title^="Save to disk"]');

/** Waits for the live Markdown editor to show `text`, then returns its line. */
async function editorLine(container: HTMLElement, text: string): Promise<HTMLElement> {
  const editor = await waitFor(() =>
    container.querySelector<HTMLElement>('[data-testid="canvas-editor"]'),
  );
  return waitFor(() => {
    const line = [...editor.querySelectorAll<HTMLElement>('.cm-line')].find(
      (candidate) => candidate.textContent === text,
    );
    return line ?? null;
  });
}

/** Replaces the prose before the bold run, as typing into that line would. */
function typeInto(line: HTMLElement, text: string): void {
  const view = EditorView.findFromDOM(line);
  if (!view) throw new Error('Line does not belong to a CodeMirror editor');
  const sourceLine = view.state.doc.lineAt(view.posAtDOM(line));
  const boldStart = sourceLine.text.indexOf('**');
  view.dispatch({
    changes: {
      from: sourceLine.from,
      to: sourceLine.from + (boldStart < 0 ? sourceLine.length : boldStart),
      insert: text,
    },
  });
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
    await editorLine(container, 'Keep state in one store.');
    const activePath = 'docs/notes "draft".md';
    setTask({
      canvasTabs: [md('docs/design.md'), md(activePath)],
      canvasActiveTab: `markdown:${activePath}`,
    });
    const activeEditor = await waitFor(() =>
      [...container.querySelectorAll<HTMLElement>('[data-testid="canvas-document"]')]
        .find((document) => document.dataset.path === activePath)
        ?.querySelector<HTMLElement>('.cm-content'),
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
    await editorLine(container, 'Keep state in one store.');
    const tab = container.querySelector<HTMLElement>('[role="tab"]');
    tab?.focus();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    tab?.dispatchEvent(enter);
    expect(activateCanvasTab).toHaveBeenCalledWith('task-1', 'markdown:docs/design.md');
    expect(document.activeElement).toBe(tab);
    expect(enter.defaultPrevented).toBe(false);
  });

  it('opens a markdown tab title context menu in the default editor', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    await editorLine(container, 'Keep state in one store.');
    const title = container.querySelector<HTMLElement>('[role="tab"] > span');

    title?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 23, clientY: 41 }),
    );
    const item = await waitFor(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (button) => button.textContent === 'Open in default editor',
      ),
    );
    item.click();

    expect(openFileInEditor).toHaveBeenCalledWith('/tmp/task', 'docs/design.md');
  });

  it('opens the markdown editor context menu and expands the same editor fullscreen', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    await editorLine(container, 'Keep state in one store.');
    const editor = container.querySelector<HTMLElement>('[data-testid="canvas-editor"]');

    editor?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const item = await waitFor(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (button) => button.textContent === 'Open in fullscreen editor',
      ),
    );
    item.click();

    const canvas = container.querySelector<HTMLElement>('[data-testid="task-canvas"]');
    expect(canvas?.dataset.fullscreen).toBe('true');
    expect(container.querySelectorAll('[data-testid="canvas-editor"]')).toHaveLength(1);
    expect(container.querySelector('[title="Exit fullscreen"]')).not.toBeNull();
    editor?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(canvas?.dataset.fullscreen).toBe('false');
  });

  it('opens the document in the default editor from the tab strip', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    await editorLine(container, 'Keep state in one store.');
    const button = container.querySelector<HTMLButtonElement>(
      '[title="Open docs/design.md in the default editor"]',
    );

    expect(button).not.toBeNull();
    button?.click();

    expect(openFileInEditor).toHaveBeenCalledWith('/tmp/task', 'docs/design.md');
  });

  it('expands the canvas from the tab strip, and Escape still comes back', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    await editorLine(container, 'Keep state in one store.');
    const canvas = container.querySelector<HTMLElement>('[data-testid="task-canvas"]');
    const expand = container.querySelector<HTMLButtonElement>(
      '[title="Fill the window with this canvas"]',
    );

    expect(expand).not.toBeNull();
    expand?.click();
    expect(canvas?.dataset.fullscreen).toBe('true');

    // The button unmounts itself in the act, so focus has to be put somewhere
    // the panel's Escape handler can still be reached from.
    expect(canvas?.contains(document.activeElement)).toBe(true);
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(canvas?.dataset.fullscreen).toBe('false');
  });

  it('leaves fullscreen when the last canvas tab is closed', async () => {
    mockIpc();
    const { container, setTask } = mount('docs/design.md');
    await editorLine(container, 'Keep state in one store.');
    container
      .querySelector<HTMLButtonElement>('[title="Fill the window with this canvas"]')
      ?.click();
    const canvas = container.querySelector<HTMLElement>('[data-testid="task-canvas"]');
    expect(canvas?.dataset.fullscreen).toBe('true');

    setTask({ canvasTabs: [], canvasActiveTab: undefined });

    // Otherwise a fixed overlay fills the window with the empty state.
    expect(canvas?.dataset.fullscreen).toBe('false');
  });

  it('leaves fullscreen when the task stops being the active one', async () => {
    mockIpc();
    const { container, setActive } = mount('docs/design.md');
    await editorLine(container, 'Keep state in one store.');
    const editor = container.querySelector<HTMLElement>('[data-testid="canvas-editor"]');
    editor?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const item = await waitFor(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (button) => button.textContent === 'Open in fullscreen editor',
      ),
    );
    item.click();
    const canvas = container.querySelector<HTMLElement>('[data-testid="task-canvas"]');
    expect(canvas?.dataset.fullscreen).toBe('true');

    setActive(false);

    // The panel stays mounted per task, so a left-behind fixed overlay would cover the
    // task the user switched to — and Escape no longer reaches it once focus moves away.
    expect(canvas?.dataset.fullscreen).toBe('false');
  });

  it('returns focus from the editor to the canvas with Escape without losing edits', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    const paragraph = await editorLine(container, 'Keep state in one store.');
    const editor = container.querySelector<HTMLElement>('.cm-content');
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
    await editorLine(container, 'Keep state in one store.');
    const focus = vi
      .mocked(registerFocusFn)
      .mock.calls.find(([key]) => key === 'task-1:canvas')?.[1];
    expect(focus).toBeDefined();
    focus?.();
    expect(document.activeElement).toBe(container.querySelector('[data-testid="task-canvas"]'));

    const editor = container.querySelector<HTMLElement>('.cm-content');
    editor?.focus();
    expect(setTaskFocusedPanel).toHaveBeenCalledWith('task-1', 'canvas');
    focus?.();
    expect(document.activeElement).toBe(editor);

    disposers.pop()?.();
    // Unregisters the function it registered, not just the key: another owner of the same key
    // must keep its own registration.
    expect(unregisterFocusFn).toHaveBeenCalledWith('task-1:canvas', focus);
  });

  it.each(['reasoning', 'mindmap'] as const)(
    'enters the %s canvas at the keyboard-selected node without stealing editor focus',
    (kind) => {
      mockIpc();
      const container = document.createElement('div');
      document.body.append(container);
      const content = (
        <div>
          <svg class="investigation-svg" tabIndex={0} />
          <button data-record-id="first" tabIndex={-1}>
            First
          </button>
          <button data-record-id="selected" tabIndex={0}>
            Selected
          </button>
          <textarea aria-label="Draft" />
        </div>
      );
      disposers.push(
        render(
          () => (
            <TaskCanvasPanel
              task={{ ...baseTask(), canvasTabs: [{ kind }], canvasActiveTab: kind }}
              agentId="agent-1"
              isActive={true}
              reasoning={kind === 'reasoning' ? content : undefined}
              mindmap={kind === 'mindmap' ? content : undefined}
            />
          ),
          container,
        ),
      );
      const focus = vi
        .mocked(registerFocusFn)
        .mock.calls.find(([key]) => key === 'task-1:canvas')?.[1];
      expect(focus).toBeDefined();
      focus?.();
      expect(document.activeElement?.getAttribute('data-record-id')).toBe('selected');
      const editor = container.querySelector('textarea');
      editor?.focus();
      focus?.();
      expect(document.activeElement).toBe(editor);
    },
  );

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

  it.each(['reasoning', 'mindmap'] as const)(
    'dismisses the initial Markdown picker when an external request opens %s',
    async (kind) => {
      mockIpc();
      const { container, setTask } = mount();
      await waitFor(() => options(container).length === 3);
      setTask({ canvasTabs: [{ kind }], canvasActiveTab: kind });
      expect(container.querySelector('[aria-label="Choose a Markdown file"]')).toBeNull();
      expect(container.querySelector('[placeholder="Filter files…"]')).toBeNull();
      expect(container.querySelector('.task-canvas-reasoning')).not.toBeNull();

      // Explicitly choosing Markdown must still reopen the picker.
      container.querySelector<HTMLButtonElement>('[title="Open another canvas"]')?.click();
      const item = await waitFor(() =>
        container.querySelector<HTMLButtonElement>('[role="menuitem"]'),
      );
      item.click();
      await waitFor(() => options(container).length === 3);
      expect(container.querySelector('[aria-label="Choose a Markdown file"]')).not.toBeNull();
    },
  );

  it('dismisses a Markdown picker when an existing canvas tab becomes active', async () => {
    mockIpc();
    const { container, setTask } = mount();
    setTask({
      canvasTabs: [{ kind: 'reasoning' }, { kind: 'mindmap' }],
      canvasActiveTab: 'mindmap',
    });
    container.querySelector<HTMLButtonElement>('[title="Open another canvas"]')?.click();
    const item = await waitFor(() =>
      container.querySelector<HTMLButtonElement>('[role="menuitem"]'),
    );
    item.click();
    await waitFor(() => options(container).length === 3);
    setTask('canvasActiveTab', 'reasoning');
    expect(container.querySelector('[aria-label="Choose a Markdown file"]')).toBeNull();
  });

  it('keeps keyboard focus inside the discard confirmation dialog', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    const paragraph = await editorLine(container, 'Keep state in one store.');
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

  it('offers a tour of a long open document from the strip', async () => {
    mockIpc(LONG_SOURCE);
    const onTakeTour = vi.fn();
    const { container, setTask } = mount('docs/design.md', { onTakeTour });
    await editorLine(container, 'Keep state in one store.');

    const button = container.querySelector<HTMLButtonElement>('.canvas-tour-btn');
    expect(button?.textContent?.trim()).toBe('Take Tour');
    button?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('docs/design.md');
    button?.click();
    expect(onTakeTour).toHaveBeenCalledWith('docs/design.md');

    // Only file-backed tabs have something to tour.
    setTask({ canvasTabs: [{ kind: 'reasoning' }], canvasActiveTab: 'reasoning' });
    expect(container.querySelector('.canvas-tour-btn')).toBeNull();
  });

  it('gives the task plan a plan tour and any other document a document tour', async () => {
    mockIpc(LONG_SOURCE);
    const { container, setTask } = mount('docs/design.md', { onTakeTour: vi.fn() });
    await editorLine(container, 'Keep state in one store.');
    const hintFor = () => {
      const button = container.querySelector<HTMLButtonElement>('.canvas-tour-btn');
      button?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      button?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      return document.querySelector('[role="tooltip"]')?.textContent ?? '';
    };
    expect(hintFor()).toContain('Guided tour of this document');
    setTask({ planPath: 'docs/design.md' });
    expect(hintFor()).toContain('Guided tour of this plan');
  });

  it('shows no tour button without a handler', async () => {
    mockIpc(LONG_SOURCE);
    const { container } = mount('docs/design.md');
    await editorLine(container, 'Keep state in one store.');
    expect(container.querySelector('.canvas-tour-btn')).toBeNull();
  });

  it('offers no tour of a document that is quicker to read than a tour', async () => {
    mockIpc();
    const { container } = mount('docs/design.md', { onTakeTour: vi.fn() });
    await editorLine(container, 'Keep state in one store.');
    expect(container.querySelector('.canvas-tour-btn')).toBeNull();

    // Growing past the threshold, as an agent writing the plan would, brings it up.
    pushFromDisk(LONG_SOURCE);
    await waitFor(() => container.querySelector('.canvas-tour-btn'));
  });

  it('shows the open file in the editor, watches it, and follows changes pushed from disk', async () => {
    mockIpc();
    const { container, setTask } = mount('docs/design.md');
    const paragraph = await editorLine(container, 'Keep state in one store.');
    expect(paragraph.querySelector('.cm-md-strong')?.textContent).toBe('store');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(calls(IPC.StartDocumentWatcher)[0][1]).toMatchObject({
      key: 'task-canvas:task-1:docs/design.md',
      projectRoot: '/tmp/task',
      documentPath: 'docs/design.md',
    });

    pushFromDisk('# Changed\n');
    await editorLine(container, 'Changed');
    expect(saveButton(container)).toBeNull();

    setTask({ canvasTabs: undefined, canvasActiveTab: undefined });
    await waitFor(() => calls(IPC.StopDocumentWatcher).length === 1);
    expect(container.querySelector('[data-testid="canvas-editor"]')).toBeNull();
  });

  it('styles Setext headings', async () => {
    mockIpc('First level\n===========\n\nSecond level\n------------\n');
    const { container } = mount('docs/design.md');

    expect((await editorLine(container, 'First level')).classList).toContain('cm-md-h1');
    expect((await editorLine(container, 'Second level')).classList).toContain('cm-md-h2');
  });

  it('writes the source-preserving document guarded by the source it came from', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    const paragraph = await editorLine(container, 'Keep state in one store.');
    typeInto(paragraph, 'Keep all state in one ');
    const save = await waitFor(() => saveButton(container));
    save.click();

    await waitFor(() => calls(IPC.WriteDocumentBlock).length === 1);
    expect(calls(IPC.WriteDocumentBlock)[0][1]).toMatchObject({
      projectRoot: '/tmp/task',
      documentPath: 'docs/design.md',
      expectedContent: SOURCE,
    });
    expect(writtenContent(calls(IPC.WriteDocumentBlock)[0][1])).toBe(
      '# Design\n\nKeep all state in one **store**.\n',
    );
    await waitFor(() => saveButton(container) === null);
    expect((await editorLine(container, 'Keep all state in one store.')).textContent).toBe(
      'Keep all state in one store.',
    );
    const view = EditorView.findFromDOM(paragraph);
    if (!view) throw new Error('CodeMirror editor was not found');
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(SOURCE);
  });

  it('falls back to a whole-document write for whitespace-only edits', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    const paragraph = await editorLine(container, 'Keep state in one store.');
    const view = EditorView.findFromDOM(paragraph);
    if (!view) throw new Error('CodeMirror editor was not found');
    view.dispatch({ changes: { from: PARAGRAPH_START, insert: '\n' } });

    const save = await waitFor(() => saveButton(container));
    save.click();

    await waitFor(() => calls(IPC.WriteDocumentBlock).length === 1);
    expect(writtenContent(calls(IPC.WriteDocumentBlock)[0][1])).toBe(
      '# Design\n\n\nKeep state in one **store**.\n',
    );
  });

  it('preserves CRLF line endings when saving', async () => {
    const source = '# Design\r\n\r\nOld text\r\n';
    mockIpc(source);
    const { container } = mount('docs/design.md');
    const line = await editorLine(container, 'Old text');
    const view = EditorView.findFromDOM(line);
    if (!view) throw new Error('CodeMirror editor was not found');
    const sourceLine = view.state.doc.line(3);
    view.dispatch({ changes: { from: sourceLine.from, to: sourceLine.to, insert: 'New text' } });
    saveButton(container)?.click();

    await waitFor(() => calls(IPC.WriteDocumentBlock).length === 1);
    expect(writtenContent(calls(IPC.WriteDocumentBlock)[0][1])).toBe(
      '# Design\r\n\r\nNew text\r\n',
    );
  });

  it('saves by itself once typing pauses', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    const paragraph = await editorLine(container, 'Keep state in one store.');
    typeInto(paragraph, 'Keep state in one place, one ');
    await waitFor(() => saveButton(container));
    await new Promise((resolve) => setTimeout(resolve, CANVAS_AUTOSAVE_IDLE_MS + 100));
    expect(calls(IPC.WriteDocumentBlock)).toHaveLength(1);
    expect(writtenContent(calls(IPC.WriteDocumentBlock)[0][1])).toBe(
      '# Design\n\nKeep state in one place, one **store**.\n',
    );
  });

  it('returns to clean without saving when undo restores the loaded source', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    const paragraph = await editorLine(container, 'Keep state in one store.');
    typeInto(paragraph, 'Keep temporary state in one ');
    const view = EditorView.findFromDOM(paragraph);
    if (!view) throw new Error('CodeMirror editor was not found');
    expect(undo(view)).toBe(true);

    await waitFor(() => saveButton(container) === null);
    await new Promise((resolve) => setTimeout(resolve, CANVAS_AUTOSAVE_IDLE_MS + 50));
    expect(calls(IPC.WriteDocumentBlock)).toHaveLength(0);
  });

  it('keeps edits typed while a save is in flight', async () => {
    let finishWrite: (() => void) | undefined;
    const pendingWrite = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    mockIpc();
    const baseInvoke = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation(((channel: string, args?: Record<string, unknown>) =>
      channel === IPC.WriteDocumentBlock
        ? pendingWrite
        : baseInvoke?.(channel as IPC, args)) as typeof invoke);
    const { container } = mount('docs/design.md');
    const paragraph = await editorLine(container, 'Keep state in one store.');
    typeInto(paragraph, 'Keep all state in one ');
    saveButton(container)?.click();
    await waitFor(() => calls(IPC.WriteDocumentBlock).length === 1);

    typeInto(
      await editorLine(container, 'Keep all state in one store.'),
      'Keep newer state in one ',
    );
    finishWrite?.();

    await editorLine(container, 'Keep newer state in one store.');
    expect(saveButton(container)).not.toBeNull();
  });

  it('flushes both an in-flight save and newer edits before sending a passage', async () => {
    let finishFirstWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      finishFirstWrite = resolve;
    });
    mockIpc();
    const baseInvoke = vi.mocked(invoke).getMockImplementation();
    let writeNumber = 0;
    vi.mocked(invoke).mockImplementation(((channel: string, args?: Record<string, unknown>) => {
      if (channel === IPC.WriteDocumentBlock) return writeNumber++ === 0 ? firstWrite : undefined;
      return baseInvoke?.(channel as IPC, args);
    }) as typeof invoke);
    const { container } = mount('docs/design.md');
    typeInto(await editorLine(container, 'Keep state in one store.'), 'Keep all state in one ');
    saveButton(container)?.click();
    await waitFor(() => calls(IPC.WriteDocumentBlock).length === 1);

    const newer = await editorLine(container, 'Keep all state in one store.');
    typeInto(newer, 'Keep newer state in one ');
    const view = EditorView.findFromDOM(newer);
    const line = view?.state.doc.line(3);
    if (!view || !line) throw new Error('CodeMirror line was not found');
    view.dispatch({ selection: { anchor: line.from, head: line.to } });
    const input = await waitFor(() =>
      container.querySelector<HTMLInputElement>('input[aria-label^="Instruction"]'),
    );
    input.value = 'Inspect this';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(vi.mocked(sendPrompt)).not.toHaveBeenCalled();

    finishFirstWrite?.();
    await waitFor(() => calls(IPC.WriteDocumentBlock).length === 2);
    await waitFor(() => vi.mocked(sendPrompt).mock.calls.length === 1);
    expect(calls(IPC.WriteDocumentBlock)[1][1]).toMatchObject({
      expectedContent: '# Design\n\nKeep all state in one **store**.\n',
    });
    expect(writtenContent(calls(IPC.WriteDocumentBlock)[1][1])).toBe(
      '# Design\n\nKeep newer state in one **store**.\n',
    );
  });

  it('honors an explicit reload while the matching save is in flight', async () => {
    let finishWrite: (() => void) | undefined;
    const pendingWrite = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    mockIpc();
    const baseInvoke = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation(((channel: string, args?: Record<string, unknown>) =>
      channel === IPC.WriteDocumentBlock
        ? pendingWrite
        : baseInvoke?.(channel as IPC, args)) as typeof invoke);
    const { container } = mount('docs/design.md');
    typeInto(await editorLine(container, 'Keep state in one store.'), 'Keep saved state in one ');
    saveButton(container)?.click();
    await waitFor(() => calls(IPC.WriteDocumentBlock).length === 1);
    typeInto(
      await editorLine(container, 'Keep saved state in one store.'),
      'Keep newer state in one ',
    );

    const saved = '# Design\n\nKeep saved state in one **store**.\n';
    pushFromDisk(saved);
    const reload = await waitFor(() =>
      [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Reload and drop my edits'),
      ),
    );
    reload.click();
    await editorLine(container, 'Keep saved state in one store.');
    finishWrite?.();

    await waitFor(() => saveButton(container) === null);
    await new Promise((resolve) => setTimeout(resolve, CANVAS_AUTOSAVE_IDLE_MS + 50));
    expect(calls(IPC.WriteDocumentBlock)).toHaveLength(1);
  });

  it('continues Markdown lists when Enter is pressed', async () => {
    mockIpc('- First item\n');
    const { container } = mount('docs/design.md');
    const item = await editorLine(container, '- First item');
    const view = EditorView.findFromDOM(item);
    if (!view) throw new Error('CodeMirror editor was not found');
    view.dispatch({ selection: { anchor: view.state.doc.line(1).to } });

    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(view.state.doc.toString()).toBe('- First item\n- \n');
  });

  it('renumbers following ordered-list items when inserting one', async () => {
    mockIpc('1. First\n2. Second\n');
    const { container } = mount('docs/design.md');
    const first = await editorLine(container, '1. First');
    const view = EditorView.findFromDOM(first);
    if (!view) throw new Error('CodeMirror editor was not found');
    view.dispatch({ selection: { anchor: view.state.doc.line(1).to } });

    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(view.state.doc.toString()).toBe('1. First\n2. \n3. Second\n');
  });

  it('leaves an empty quoted list without leaving its blockquote', async () => {
    mockIpc('> - \n');
    const { container } = mount('docs/design.md');
    const content = await waitFor(() => container.querySelector<HTMLElement>('.cm-content'));
    const view = EditorView.findFromDOM(content);
    if (!view) throw new Error('CodeMirror editor was not found');
    view.dispatch({ selection: { anchor: view.state.doc.line(1).to } });

    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(view.state.doc.toString()).toBe('> \n');
  });

  it.each(['- [ ]\n', '- [ ] \n'])('leaves an empty task item (%j)', async (source) => {
    mockIpc(source);
    const { container } = mount('docs/design.md');
    const content = await waitFor(() => container.querySelector<HTMLElement>('.cm-content'));
    const view = EditorView.findFromDOM(content);
    if (!view) throw new Error('CodeMirror editor was not found');
    view.dispatch({ selection: { anchor: view.state.doc.line(1).to } });

    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(view.state.doc.toString()).toBe('\n');
  });

  it('does not continue list-looking text inside fenced code', async () => {
    mockIpc('```text\n- output\n```\n');
    const { container } = mount('docs/design.md');
    const output = await editorLine(container, '- output');
    const view = EditorView.findFromDOM(output);
    if (!view) throw new Error('CodeMirror editor was not found');
    view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });

    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(view.state.doc.toString()).toBe('```text\n- output\n\n```\n');
  });

  it('synchronizes native task-checkbox activation with Markdown', async () => {
    mockIpc('- [ ] Ready\n');
    const { container } = mount('docs/design.md');
    const item = await editorLine(container, 'Ready');
    const view = EditorView.findFromDOM(item);
    const checkbox = item.querySelector<HTMLInputElement>('.cm-md-task-checkbox');
    if (!view || !checkbox) throw new Error('Rendered checkbox was not found');
    expect(checkbox.tabIndex).toBe(0);

    checkbox.focus();
    checkbox.click();

    expect(view.state.doc.toString()).toBe('- [x] Ready\n');
    expect(checkbox.checked).toBe(true);
    expect(item.querySelector('.cm-md-task-checkbox')).toBe(checkbox);
    expect(document.activeElement).toBe(checkbox);
  });

  it('keeps unsaved edits when the file changes on disk, until told to drop them', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    const paragraph = await editorLine(container, 'Keep state in one store.');
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
    await editorLine(container, 'Changed');
    const content = container.querySelector<HTMLElement>('.cm-content');
    if (!content) throw new Error('CodeMirror content was not found');
    const view = EditorView.findFromDOM(content);
    if (!view) throw new Error('CodeMirror editor was not found');
    expect(undo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('# Changed\n');
    expect(saveButton(container)).toBeNull();
    expect(container.textContent).not.toContain('changed on disk');
  });

  it('closes a tab or the column through the store when there is nothing to lose', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    await editorLine(container, 'Keep state in one store.');
    container.querySelector<HTMLButtonElement>('[aria-label="Close design.md"]')?.click();
    expect(closeCanvasTab).toHaveBeenCalledWith('task-1', 'markdown:docs/design.md');
    container.querySelector<HTMLButtonElement>('[title="Close the canvas"]')?.click();
    expect(closeTaskCanvas).toHaveBeenCalledWith('task-1');
  });

  it('closes the active tab through the canvas action used by Cmd/Ctrl+W', async () => {
    mockIpc();
    const { container, setTask } = mount('docs/design.md');
    await editorLine(container, 'Keep state in one store.');

    closeActiveCanvasTab();

    expect(closeCanvasTab).toHaveBeenCalledWith('task-1', 'markdown:docs/design.md');

    setTask({ canvasTabs: undefined, canvasActiveTab: undefined });
    closeActiveCanvasTab();
    expect(closeTaskCanvas).toHaveBeenCalledWith('task-1');

    disposers.pop()?.();
    expect(unregisterAction).toHaveBeenCalledWith('task-1:close-canvas-active-tab');
  });

  it('asks before the canvas action closes an active tab with unsaved edits', async () => {
    mockIpc();
    const { container } = mount('docs/design.md');
    const paragraph = await editorLine(container, 'Keep state in one store.');
    typeInto(paragraph, 'Keep all state in one ');
    await waitFor(() => saveButton(container));

    closeActiveCanvasTab();

    expect(closeCanvasTab).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('This tab has unsaved edits');
  });

  it('keeps every tab mounted, shows the active one, and marks unsaved edits on its tab', async () => {
    mockIpc();
    const { container, setTask } = mount('docs/design.md');
    const paragraph = await editorLine(container, 'Keep state in one store.');
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
    const paragraph = await editorLine(container, 'Keep state in one store.');
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
    await editorLine(container, 'Keep state in one store.');
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
    const paragraph = await editorLine(container, 'Keep state in one store.');
    const view = EditorView.findFromDOM(paragraph);
    const line = view?.state.doc.line(3);
    if (!view || !line) throw new Error('CodeMirror line was not found');
    view.dispatch({ selection: { anchor: line.from, head: line.to } });

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
        'The passage, verbatim:\n> Keep state in one **store**.',
      ].join('\n\n'),
    ]);
  });

  it('does not send a passage when its prerequisite save fails', async () => {
    mockIpc();
    const baseInvoke = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation(((channel: string, args?: Record<string, unknown>) =>
      channel === IPC.WriteDocumentBlock
        ? Promise.reject(new Error('write conflict'))
        : baseInvoke?.(channel as IPC, args)) as typeof invoke);
    const { container } = mount('docs/design.md');
    const paragraph = await editorLine(container, 'Keep state in one store.');
    typeInto(paragraph, 'Keep unsaved state in one ');
    const view = EditorView.findFromDOM(paragraph);
    const line = view?.state.doc.line(3);
    if (!view || !line) throw new Error('CodeMirror line was not found');
    view.dispatch({ selection: { anchor: line.from, head: line.to } });
    const input = await waitFor(() =>
      container.querySelector<HTMLInputElement>('input[aria-label^="Instruction"]'),
    );
    input.value = 'Inspect this';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await waitFor(() => container.querySelector('[role="alert"]'));
    expect(vi.mocked(sendPrompt)).not.toHaveBeenCalled();
    expect(input.value).toBe('Inspect this');
    expect(container.contains(input)).toBe(true);
  });
});
