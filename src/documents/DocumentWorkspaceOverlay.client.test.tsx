import { render } from 'solid-js/web';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { DocumentWorkspacePanel } from './DocumentWorkspacePanel';
import {
  documentStore,
  setDocumentComposerDraft,
  setDocumentSelection,
  openDocumentWorkspace,
  openDocumentFile,
  refreshDocumentSnapshot,
  setDocumentView,
} from './store';
import { IPC } from '../../electron/ipc/channels';
import * as ipc from '../lib/ipc';
import { createRenderedBlocks } from './use-blocks';
import { clearBlockEdits } from './block-edit-state';
import { createTask, uncollapseTask } from '../store/tasks';
import { createTerminal } from '../store/terminals';
import { setActiveTask } from '../store/navigation';
import type { Task } from '../store/types';
import { clearAgentActivity } from '../store/taskStatus';

vi.mock('./use-blocks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./use-blocks')>()),
  createRenderedBlocks: vi.fn(
    (await importOriginal<typeof import('./use-blocks')>()).createRenderedBlocks,
  ),
}));

const { openInEditor, revealItemInDir } = vi.hoisted(() => ({
  openInEditor: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/shell', () => ({ openInEditor, revealItemInDir }));
vi.mock('../lib/platform', () => ({
  isMac: false,
  windowChromeTopInset: 34,
  mod: 'Ctrl',
  alt: 'Alt',
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  clearBlockEdits();
  for (const id of Object.keys(store.agents)) clearAgentActivity(id);
  document.body.replaceChildren();
  setStore({
    projects: [],
    activeDocumentProjectId: null,
    editorCommand: '',
    documentFullWidth: false,
    documentWorkspacesEnabled: false,
    focusMode: false,
    tasks: {},
    agents: {},
    terminals: {},
    taskOrder: [],
    collapsedTaskOrder: [],
    activeTaskId: null,
    activeAgentId: null,
    panelUserSize: {},
  });
  setDocumentComposerDraft(null);
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function openWorkspace(): HTMLElement {
  setStore({
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
    activeDocumentProjectId: 'docs',
  });
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(render(() => <DocumentWorkspacePanel />, host));
  return host;
}

/** Selects the text of one block the way dragging across it would. */
function selectText(host: HTMLElement, index: number): void {
  const target = host.querySelector(`[data-block-index="${index}"] > div`);
  if (!target) throw new Error('No paragraph to select');
  const range = document.createRange();
  range.selectNodeContents(target);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  window.getSelection()?.removeAllRanges();
}

function button(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) ?? null
  );
}

/** An action of the toolbar over the selected or hovered passage. */
function blockAction(kind: 'proposals' | 'note' | 'question'): HTMLButtonElement | null {
  return document.querySelector(`.docws-block-action[data-kind="${kind}"]`);
}

describe('DocumentWorkspacePanel', () => {
  it('switches document views with arrow keys and keeps keyboard focus on the selected tab', () => {
    const host = openWorkspace();
    const tabs = host.querySelectorAll<HTMLButtonElement>('[aria-label="Document views"] button');
    tabs[0].focus();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(documentStore.view).toBe('history');
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[0].tabIndex).toBe(-1);
    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(documentStore.view).toBe('document');
    expect(document.activeElement).toBe(tabs[0]);
    const shortcut = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    tabs[0].dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(false);
    expect(documentStore.view).toBe('document');
  });

  it('focuses the document from its header and returns to tiling without closing it', () => {
    const host = openWorkspace();
    const focus = host.querySelector<HTMLButtonElement>('[aria-label="Focus on this document"]');
    expect(focus).not.toBeNull();
    focus?.click();
    expect(store.focusMode).toBe(true);
    expect(store.activeTaskId).toBe('doc-agent-docs');
    host.querySelector<HTMLButtonElement>('[aria-label="Exit focus mode"]')?.click();
    expect(store.focusMode).toBe(false);
    expect(store.activeDocumentProjectId).toBe('docs');
  });

  it('opens the file list from the current document path', () => {
    const host = openWorkspace();
    const path = host.querySelector<HTMLButtonElement>('[aria-label="Switch document: notes.md"]');
    expect(path?.textContent).toContain('notes.md');
    path?.click();
    expect(host.querySelector('[aria-label="Project files"]')).not.toBeNull();
    path?.click();
    expect(host.querySelector('[aria-label="Project files"]')).toBeNull();
  });

  it('stacks the document above the agent in a narrow panel', () => {
    const host = openWorkspace();
    expect(host.querySelector('.docws-body .resize-handle-v')).not.toBeNull();
    expect(host.querySelector('.docws-body .resize-handle-h')).toBeNull();
  });

  it('refocuses the open document without replacing its draft', async () => {
    vi.spyOn(ipc, 'invoke').mockResolvedValue([]);
    openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    setDocumentComposerDraft({ text: 'Keep my draft' });
    setStore('activeTaskId', 'other');
    await openDocumentWorkspace('docs');
    expect(store.activeTaskId).toBe('doc-agent-docs');
    expect(documentStore.composerDraft?.text).toBe('Keep my draft');
  });
  it('bounds the composer to the document pane and remeasures on pane resize', async () => {
    let reflow: (() => void) | undefined;
    const observe = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          reflow ??= callback;
        }
        observe = observe;
        unobserve() {}
        disconnect() {}
      },
    );
    try {
      vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
        channel === IPC.ReadDocument ? { content: '# Notes', missing: false } : [],
      );
      const host = openWorkspace();
      setStore('documentWorkspacesEnabled', true);
      await openDocumentWorkspace('docs');
      button(host, 'Rewrite')?.click();
      const main = host.querySelector<HTMLElement>('.docws-doc-main');
      const scroll = host.querySelector<HTMLElement>('.docws-scroll');
      if (!main || !scroll) throw new Error('Document pane did not mount');
      vi.spyOn(main, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 200 } as DOMRect);
      vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ top: 50 } as DOMRect);
      expect(observe).toHaveBeenCalledWith(main);
      expect(observe).toHaveBeenCalledWith(scroll);
      reflow?.();
      expect(
        host
          .querySelector<HTMLElement>('.docws-composer-layer')
          ?.style.getPropertyValue('--docws-composer-space'),
      ).toBe('134px');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['select', 'restore', 'create', 'terminal'] as const)(
    'keeps the document open when navigating via %s',
    async (action) => {
      vi.spyOn(ipc, 'invoke').mockResolvedValue(undefined);
      const task: Task = {
        id: 'code-task',
        projectId: 'code',
        name: 'Coding',
        branchName: '',
        worktreePath: '/code',
        gitIsolation: 'none',
        agentIds: [],
        shellAgentIds: [],
        notes: '',
        lastPrompt: '',
        collapsed: action === 'restore',
      };
      setStore({ tasks: { [task.id]: task }, activeTaskId: null });
      openWorkspace();
      setStore('projects', (projects) => [
        ...projects,
        {
          id: 'code',
          name: 'Code',
          path: '/code',
          color: '',
        },
      ]);
      expect(store.activeDocumentProjectId).toBe('docs');
      if (action === 'select') setActiveTask(task.id);
      else if (action === 'restore') uncollapseTask(task.id);
      else if (action === 'terminal') createTerminal();
      else
        await createTask({
          name: 'New coding task',
          projectId: 'code',
          gitIsolation: 'none',
          baseBranch: '',
          agentDef: {
            id: 'test',
            name: 'Test',
            command: 'test',
            args: [],
            resume_args: [],
            skip_permissions_args: [],
            description: '',
          },
        });
      expect(store.activeDocumentProjectId).toBe('docs');
      expect(store.activeTaskId).not.toBeNull();
    },
  );

  it('zooms the preview independently and remembers the scale when reopened', () => {
    const host = openWorkspace();
    const zoomIn = host.querySelector<HTMLButtonElement>('[aria-label="Zoom in document"]');
    const reset = host.querySelector<HTMLButtonElement>('[aria-label="Reset document zoom"]');
    expect(zoomIn).not.toBeNull();
    zoomIn?.click();
    expect(reset?.textContent).toBe('110%');
    expect(host.querySelector<HTMLElement>('.docws-doc')?.style.zoom).toBe('1.1');
    expect(host.querySelector<HTMLElement>('.docws-agent-pane')?.style.zoom).toBe('');

    disposers.pop()?.();
    const reopened = document.createElement('div');
    document.body.append(reopened);
    disposers.push(render(() => <DocumentWorkspacePanel />, reopened));
    expect(reopened.querySelector('[aria-label="Reset document zoom"]')?.textContent).toBe('110%');
    for (let i = 0; i < 20; i++)
      reopened.querySelector<HTMLButtonElement>('[aria-label="Zoom out document"]')?.click();
    expect(
      reopened.querySelector<HTMLButtonElement>('[aria-label="Zoom out document"]')?.disabled,
    ).toBe(true);
    expect(reopened.querySelector('[aria-label="Reset document zoom"]')?.textContent).toBe('50%');
    reopened.querySelector<HTMLButtonElement>('[aria-label="Reset document zoom"]')?.click();
    expect(reopened.querySelector('[aria-label="Reset document zoom"]')?.textContent).toBe('100%');
  });

  it('offers Full width for Markdown only, since an HTML page already fills the column', async () => {
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
      channel === IPC.ReadDocument
        ? { content: '<!doctype html><html><body><h1>Guide</h1></body></html>', missing: false }
        : [],
    );
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('.docws-page')).not.toBeNull());
    expect(host.querySelector('[aria-label="Full width"]')).toBeNull();
    // Double-click or E edits a block; the bar keeps no button for it.
    expect(button(host, 'Edit block')).toBeNull();
  });

  it("edits an HTML page's block in a dialog, on a double-click or E", async () => {
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
      channel === IPC.ReadDocument
        ? {
            content:
              '<!doctype html>\n<html>\n<body>\n<p>One.</p>\n\n<p>Two.</p>\n</body>\n</html>\n',
            missing: false,
          }
        : [],
    );
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() =>
      expect(host.querySelector('.docws-page [data-block-index="1"]')).not.toBeNull(),
    );
    const source = () =>
      document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.value;
    const marked = (text: string) =>
      Array.from(host.querySelectorAll('.docws-page [data-block-index]')).find(
        (el) => el.textContent?.trim() === text,
      );
    await vi.waitFor(() => expect(marked('One.')).toBeDefined());
    const block = marked('One.');
    // Like E, a double-click waits out a render of the page's blocks in progress.
    await vi.waitFor(async () => {
      for (const detail of [1, 2]) {
        block?.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      expect(source()).toContain('One.');
    });
    button(document.body, 'Cancel')?.click();
    await vi.waitFor(() => expect(source()).toBeUndefined());

    const second = host.querySelector('.docws-page [data-block-index="1"]');
    if (!second) throw new Error('No second block');
    const range = document.createRange();
    range.selectNodeContents(second);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    second.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    window.getSelection()?.removeAllRanges();
    await vi.waitFor(() => {
      host
        .querySelector('.docws-workspace')
        ?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'e', bubbles: true, cancelable: true }),
        );
      expect(source()).toContain('Two.');
    });
  });

  it('uses the entire title-bar background as the window drag region', () => {
    setStore({
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
      activeDocumentProjectId: 'docs',
    });
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(render(() => <DocumentWorkspacePanel />, host));

    const header = host.querySelector<HTMLElement>('.docws-header');

    expect(header?.hasAttribute('data-tauri-drag-region')).toBe(true);
  });

  it('keeps the document actions in the header, one bar with the window controls', () => {
    const host = openWorkspace();
    const header = host.querySelector('.docws-header');
    expect(header?.querySelector('.docws-toolbar')).not.toBeNull();
    expect(host.querySelectorAll('.docws-toolbar')).toHaveLength(1);
    expect(button(host, 'Hide panel')).toBeNull();
    expect(header?.querySelector('[aria-label="Close document workspace"]')).toBeNull();
    header?.querySelector<HTMLButtonElement>('[aria-label="Minimize document workspace"]')?.click();
    expect(store.activeDocumentProjectId).toBeNull();
  });

  it('asks about the selected passage from its own toolbar, not the bar above', async () => {
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
      channel === IPC.ReadDocument
        ? { content: 'First paragraph.\n', missing: false, dirty: false }
        : [],
    );
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="0"]')).not.toBeNull());
    expect(button(host, 'Ask')).toBeNull();
    expect(button(host, 'Comment')).toBeNull();
    selectText(host, 0);
    blockAction('question')?.click();
    expect(documentStore.composerDraft?.mode).toBe('question');
    expect(host.querySelector('[aria-label="Ask about this passage"]')).not.toBeNull();
  });

  it('comments on, asks about or edits a selected passage from the keyboard', async () => {
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
      channel === IPC.ReadDocument
        ? { content: 'First paragraph.\n', missing: false, dirty: false }
        : [],
    );
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="0"]')).not.toBeNull());
    const key = (k: string, init: KeyboardEventInit = {}) => {
      const press = new KeyboardEvent('keydown', {
        key: k,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      // A click or a closed editor leaves the focus on the workspace itself.
      host.querySelector<HTMLElement>('.docws-workspace')?.dispatchEvent(press);
      return press;
    };
    // Nothing selected, nothing to act on: the keys stay ordinary keys.
    expect(key('c').defaultPrevented).toBe(false);
    selectText(host, 0);
    // The selection's label names the keys, as no button shows E.
    expect(document.querySelector('.docws-toolbar-label')?.getAttribute('title')).toContain(
      'E edits its block',
    );
    expect(key('c', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(documentStore.composerDraft).toBeNull();

    expect(key('c').defaultPrevented).toBe(true);
    expect(documentStore.composerDraft?.mode).toBe('note');
    setDocumentComposerDraft(null);
    key('a');
    expect(documentStore.composerDraft?.mode).toBe('question');
    setDocumentComposerDraft(null);
    // Like a double-click, E waits out a render of the blocks in progress.
    await vi.waitFor(() => {
      key('e');
      expect(host.querySelector('[data-block-index="0"] .cm-content')).not.toBeNull();
    });
    expect(blockAction('note')?.getAttribute('aria-keyshortcuts')).toBe('C');
    expect(blockAction('question')?.getAttribute('aria-keyshortcuts')).toBe('A');
  });

  it('leaves the passage keys to a focused link and to the Markdown editor', async () => {
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
      channel === IPC.ReadDocument
        ? {
            content: 'First [link](https://example.com) paragraph.\n',
            missing: false,
            dirty: false,
          }
        : [],
    );
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="0"] a')).not.toBeNull());
    const press = (target: Element | null) => {
      const e = new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true });
      target?.dispatchEvent(e);
      return e.defaultPrevented;
    };
    selectText(host, 0);

    // A link or button in the page has the key while it has the focus.
    expect(press(host.querySelector('[data-block-index="0"] a'))).toBe(false);
    expect(documentStore.composerDraft).toBeNull();
    // The prose around it does not; Chromium can focus the scroller itself.
    expect(press(host.querySelector('[data-block-index="0"] > div'))).toBe(true);
    expect(documentStore.composerDraft?.mode).toBe('note');
    setDocumentComposerDraft(null);

    // Editing the Markdown hides the page; nothing opens over it unseen.
    button(document.body, 'Edit')?.click();
    await vi.waitFor(() => expect(host.querySelector('.docws-scroll.is-hidden')).not.toBeNull());
    expect(press(host.querySelector('.docws-workspace'))).toBe(false);
    expect(documentStore.composerDraft).toBeNull();
  });

  it('moves a comment to the next clicked block at once, while the first still saves', async () => {
    let landSave: (() => void) | undefined;
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel, args) => {
      if (channel === IPC.ReadDocument)
        return { content: 'First paragraph.\n\nSecond paragraph.\n', missing: false, dirty: false };
      if (channel === IPC.SaveDocumentAnnotation) {
        await new Promise<void>((resolve) => (landSave = resolve));
        return (args as { annotation: unknown }).annotation;
      }
      return [];
    });
    // A save left hanging would hold later tests' comments open.
    onTestFinished(() => landSave?.());
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="1"]')).not.toBeNull());
    const press = (index: number) => {
      const el = host.querySelector(`[data-block-index="${index}"] > div`);
      el?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1 }),
      );
      el?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    };

    press(0);
    await vi.waitFor(() => expect(documentStore.selection?.startBlock).toBe(0));
    const field = host.querySelector<HTMLTextAreaElement>('textarea');
    if (!field) throw new Error('No comment field');
    field.value = 'First comment.';
    field.dispatchEvent(new InputEvent('input', { bubbles: true }));

    press(1);
    // Opens without waiting for the first comment's save, which is still out.
    await vi.waitFor(() => expect(documentStore.selection?.startBlock).toBe(1));
    expect(landSave).toBeDefined();
    const next = documentStore.composerDraft?.id;
    expect(documentStore.composerDraft?.text).toBe('');

    landSave?.();
    await vi.waitFor(() =>
      expect(documentStore.annotations.map((a) => a.text)).toEqual(['First comment.']),
    );
    expect(documentStore.composerDraft?.id).toBe(next);
  });

  it('hands a comment whose save failed behind it to the empty one that replaced it', async () => {
    let failSave: ((err: Error) => void) | undefined;
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) => {
      if (channel === IPC.ReadDocument)
        return { content: 'First paragraph.\n\nSecond paragraph.\n', missing: false, dirty: false };
      if (channel === IPC.SaveDocumentAnnotation)
        return new Promise((_, reject) => (failSave = reject));
      return [];
    });
    onTestFinished(() => failSave?.(new Error('done')));
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="1"]')).not.toBeNull());
    const press = (index: number) =>
      host
        .querySelector(`[data-block-index="${index}"] > div`)
        ?.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1 }),
        );

    press(0);
    await vi.waitFor(() => expect(documentStore.selection?.startBlock).toBe(0));
    const field = host.querySelector<HTMLTextAreaElement>('textarea');
    if (!field) throw new Error('No comment field');
    field.value = 'First comment.';
    field.dispatchEvent(new InputEvent('input', { bubbles: true }));
    press(1);
    await vi.waitFor(() => expect(documentStore.selection?.startBlock).toBe(1));
    expect(documentStore.composerDraft?.text).toBe('');

    failSave?.(new Error('Disk full'));
    await vi.waitFor(() => expect(documentStore.composerDraft?.text).toBe('First comment.'));
    expect(documentStore.composerDraft?.noteSaveStatus).toBe('error');
    // Back on the passage it was written about, so Retry saves it there.
    expect(documentStore.selection?.startBlock).toBe(0);
    await vi.waitFor(() =>
      expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('First comment.'),
    );
    // Its backup would otherwise come back in the tests after this one.
    const open = documentStore.composerDraft;
    if (open) setDocumentComposerDraft({ ...open, text: '' });
  });

  it('keeps a failed comment for later when the next one already has text', async () => {
    let failSave: ((err: Error) => void) | undefined;
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) => {
      if (channel === IPC.ReadDocument)
        return { content: 'First paragraph.\n\nSecond paragraph.\n', missing: false, dirty: false };
      if (channel === IPC.SaveDocumentAnnotation)
        return new Promise((_, reject) => (failSave = reject));
      return [];
    });
    onTestFinished(() => failSave?.(new Error('done')));
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="1"]')).not.toBeNull());
    const press = (index: number) =>
      host
        .querySelector(`[data-block-index="${index}"] > div`)
        ?.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1 }),
        );
    const type = (text: string) => {
      const field = host.querySelector<HTMLTextAreaElement>('textarea');
      if (!field) throw new Error('No comment field');
      field.value = text;
      field.dispatchEvent(new InputEvent('input', { bubbles: true }));
    };

    press(0);
    await vi.waitFor(() => expect(documentStore.selection?.startBlock).toBe(0));
    type('First comment.');
    press(1);
    await vi.waitFor(() => expect(documentStore.selection?.startBlock).toBe(1));
    type('Second');
    failSave?.(new Error('Disk full'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The comment being written keeps its own text.
    expect(documentStore.composerDraft?.text).toBe('Second');

    // Given up, the second makes way; the next comment brings the failed one back.
    type('');
    setDocumentComposerDraft(null);
    press(1);
    await vi.waitFor(() => expect(documentStore.composerDraft?.text).toBe('First comment.'));
    expect(documentStore.composerDraft?.noteSaveStatus).toBe('error');
    expect(documentStore.selection?.startBlock).toBe(0);
    const open = documentStore.composerDraft;
    if (open) setDocumentComposerDraft({ ...open, text: '' });
  });

  it('edits a double-clicked block in place, leaving the clicked passage where it is', async () => {
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
      channel === IPC.ReadDocument
        ? { content: 'First paragraph.\n\nSecond paragraph.\n', missing: false, dirty: false }
        : [],
    );
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="1"]')).not.toBeNull());
    const el = host.querySelector('[data-block-index="1"] > div');
    const down = (detail: number) =>
      el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail }));

    down(1);
    await vi.waitFor(() => expect(documentStore.composerDraft?.mode).toBe('note'));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    // Scrolling under the pointer would land a double-click's second press elsewhere.
    expect(scrolled).not.toHaveBeenCalled();
    down(2);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    await vi.waitFor(() =>
      expect(host.querySelector('[data-block-index="1"] .cm-content')?.textContent).toBe(
        'Second paragraph.',
      ),
    );
    expect(documentStore.composerDraft).toBeNull();
  });

  it('keeps a block edit in progress through a re-render and a double-click elsewhere', async () => {
    let content = 'First paragraph.\n\nSecond paragraph.\n';
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel, args) =>
      channel === IPC.ReadDocument
        ? {
            content:
              (args as { documentPath?: string }).documentPath === 'other.md'
                ? 'Other paragraph.\n'
                : content,
            missing: false,
            dirty: false,
          }
        : [],
    );
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="1"]')).not.toBeNull());
    const doubleClick = async (index: number) => {
      const el = host.querySelector(`[data-block-index="${index}"] > div`);
      for (const detail of [1, 2]) {
        el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    };
    const live = () => {
      const el = host.querySelector<HTMLElement>('[data-block-index="1"] .cm-content');
      return el ? EditorView.findFromDOM(el) : null;
    };
    await doubleClick(1);
    await vi.waitFor(() => expect(live()).not.toBeNull());
    live()?.dispatch({ changes: { from: 0, insert: 'Edited. ' } });

    await doubleClick(0);
    expect(host.querySelector('[data-block-index="0"] .cm-content')).toBeNull();
    expect(live()?.state.doc.toString()).toBe('Edited. Second paragraph.');

    content += '\nThird paragraph.\n';
    await refreshDocumentSnapshot();
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="2"]')).not.toBeNull());
    await vi.waitFor(() => expect(live()?.state.doc.toString()).toBe('Edited. Second paragraph.'));

    // A paragraph added above moves the block; the editor goes with it.
    content = `Zeroth paragraph.\n\n${content}`;
    await refreshDocumentSnapshot();
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="3"]')).not.toBeNull());
    await vi.waitFor(() =>
      expect(
        host.querySelector<HTMLElement>('[data-block-index="2"] .cm-content')?.textContent,
      ).toBe('Edited. Second paragraph.'),
    );
    expect(host.querySelector('[data-block-index="1"]')?.textContent?.trim()).toBe(
      'First paragraph.',
    );

    // Rewritten, the block is gone; the edit moves to a dialog rather than
    // standing in for another block, still in reach to be cancelled.
    content = 'Only paragraph.\n';
    await refreshDocumentSnapshot();
    const inDialog = () =>
      document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.value;
    await vi.waitFor(() => expect(inDialog()).toBe('Edited. Second paragraph.'));
    expect(host.querySelector('[data-block-index="0"]')?.textContent?.trim()).toBe(
      'Only paragraph.',
    );

    // Another document has edits of its own; this one waits for its return.
    await openDocumentFile('other.md');
    await vi.waitFor(() =>
      expect(host.querySelector('[data-block-index="0"]')?.textContent?.trim()).toBe(
        'Other paragraph.',
      ),
    );
    await doubleClick(0);
    await vi.waitFor(() =>
      expect(host.querySelector('[data-block-index="0"] .cm-content')?.textContent).toBe(
        'Other paragraph.',
      ),
    );
    await openDocumentFile('notes.md');
    await vi.waitFor(() => expect(inDialog()).toBe('Edited. Second paragraph.'));
  });

  it('leaves the focus where the user is typing when the file changes under a block edit', async () => {
    let content = 'First paragraph.\n';
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
      channel === IPC.ReadDocument ? { content, missing: false, dirty: false } : [],
    );
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="0"]')).not.toBeNull());
    const el = host.querySelector('[data-block-index="0"] > div');
    for (const detail of [1, 2]) {
      el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.activeElement?.classList.contains('cm-content')).toBe(true),
    );
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    elsewhere.focus();

    // An agent writes the file; the blocks are rebuilt and the editor with them.
    content = 'First paragraph.\n\nSecond paragraph.\n';
    await refreshDocumentSnapshot();
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="1"]')).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('leaves the focus alone on a re-render after the opening press became a drag', async () => {
    let content = 'First paragraph.\n';
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
      channel === IPC.ReadDocument ? { content, missing: false, dirty: false } : [],
    );
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="0"]')).not.toBeNull());
    const el = host.querySelector('[data-block-index="0"] > div');
    for (const detail of [1, 2]) {
      el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // The press ends in a drop, without a release: the editor never takes the focus.
    document.dispatchEvent(new Event('dragend'));
    await vi.waitFor(() => expect(host.querySelector('.cm-content')).not.toBeNull());
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    elsewhere.focus();

    content = 'First paragraph.\n\nSecond paragraph.\n';
    await refreshDocumentSnapshot();
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="1"]')).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('puts an untouched block editor away when its block is rewritten', async () => {
    let content = 'First paragraph.\n';
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
      channel === IPC.ReadDocument ? { content, missing: false, dirty: false } : [],
    );
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="0"]')).not.toBeNull());
    const el = host.querySelector('[data-block-index="0"] > div');
    for (const detail of [1, 2]) {
      el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await vi.waitFor(() => expect(host.querySelector('.cm-content')).not.toBeNull());

    content = 'Rewritten paragraph.\n';
    await refreshDocumentSnapshot();
    await vi.waitFor(() =>
      expect(host.querySelector('[data-block-index="0"]')?.textContent?.trim()).toBe(
        'Rewritten paragraph.',
      ),
    );
    // Nothing typed, nothing to keep: no dialog takes over the screen.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('.cm-content')).toBeNull();
  });

  it('moves a block edit in progress to a dialog when its document is emptied', async () => {
    let content = 'First paragraph.\n';
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
      channel === IPC.ReadDocument ? { content, missing: false, dirty: false } : [],
    );
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="0"]')).not.toBeNull());
    const el = host.querySelector('[data-block-index="0"] > div');
    for (const detail of [1, 2]) {
      el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const live = await vi.waitFor(() => {
      const field = host.querySelector<HTMLElement>('.cm-content');
      const view = field && EditorView.findFromDOM(field);
      if (!view) throw new Error('No inline editor yet');
      return view;
    });
    live.dispatch({ changes: { from: 0, insert: 'Edited. ' } });

    // No block is left to edit in place; the draft must stay in reach, to be cancelled.
    content = '';
    await refreshDocumentSnapshot();
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.value).toBe(
        'Edited. First paragraph.',
      ),
    );
  });

  it('keeps a block edit in progress while History is looked at', async () => {
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
      channel === IPC.ReadDocument
        ? { content: 'First paragraph.\n', missing: false, dirty: false }
        : [],
    );
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="0"]')).not.toBeNull());
    const el = host.querySelector('[data-block-index="0"] > div');
    for (const detail of [1, 2]) {
      el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    const live = () => {
      const content = host.querySelector<HTMLElement>('.cm-content');
      return content ? EditorView.findFromDOM(content) : null;
    };
    await vi.waitFor(() => expect(live()).not.toBeNull());
    live()?.dispatch({ changes: { from: 0, insert: 'Edited. ' } });

    setDocumentView('history');
    await vi.waitFor(() => expect(live()).toBeNull());
    setDocumentView('document');

    await vi.waitFor(() => expect(live()?.state.doc.toString()).toBe('Edited. First paragraph.'));
  });

  it('hands the focus back to the workspace when a block edit closes', async () => {
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
      channel === IPC.ReadDocument
        ? { content: 'First paragraph.\n', missing: false, dirty: false }
        : [],
    );
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="0"]')).not.toBeNull());
    const el = host.querySelector('[data-block-index="0"] > div');
    for (const detail of [1, 2]) {
      el?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await vi.waitFor(() => expect(host.querySelector('.cm-content')).not.toBeNull());
    const content = host.querySelector<HTMLElement>('.cm-content');
    content?.focus();

    content?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(host.querySelector('.cm-content')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('.docws-workspace'));
  });

  it('leaves focus where a click put it when that click closes a comment', async () => {
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
      channel === IPC.ReadDocument
        ? { content: 'First paragraph.\n', missing: false, dirty: false }
        : [],
    );
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="0"]')).not.toBeNull());
    const field = document.createElement('input');
    document.body.append(field);
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

    // A click on something focusable keeps the focus it gives.
    selectText(host, 0);
    blockAction('note')?.click();
    await nextFrame();
    field.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    field.focus();
    await nextFrame();
    expect(documentStore.composerDraft).toBeNull();
    expect(document.activeElement).toBe(field);

    // A click on plain prose gives none, so focus lands on Rewrite.
    selectText(host, 0);
    blockAction('note')?.click();
    await nextFrame();
    (document.activeElement as HTMLElement | null)?.blur();
    host
      .querySelector('[data-block-index="0"]')
      ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await nextFrame();
    expect(document.activeElement).toBe(button(document.body, 'Rewrite'));
  });

  it('holds the resolved toggle in the toolbar before the first comment', async () => {
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
      channel === IPC.ReadDocument
        ? { content: 'First paragraph.\n', missing: false, dirty: false }
        : [],
    );
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="0"]')).not.toBeNull());

    const toggle = document.querySelector<HTMLElement>('.docws-toggle');
    expect(toggle?.style.visibility).toBe('hidden');
    expect(toggle?.querySelector('input')?.disabled).toBe(true);
  });

  it('switches a typed comment to Ask without first saving it as a comment', async () => {
    const saved: string[] = [];
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel, args) => {
      if (channel === IPC.ReadDocument)
        return { content: 'First paragraph.\n', missing: false, dirty: false };
      if (channel === IPC.SaveDocumentAnnotation) {
        const annotation = (args as { annotation: { kind: string } }).annotation;
        saved.push(annotation.kind);
        return annotation;
      }
      return [];
    });
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="0"]')).not.toBeNull());
    selectText(host, 0);
    blockAction('note')?.click();
    const box = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]');
    if (!box) throw new Error('No comment field');
    box.value = 'Is this still true?';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    // A real press moves focus on mousedown, which would autosave the comment;
    // over its passage the toolbar keeps focus in the field, so the text moves over instead.
    host
      .querySelector('[data-block-index="0"] > *')
      ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    for (const kind of ['question', 'note', 'proposals'] as const) {
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      blockAction(kind)?.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
    }
    // Comment over its own open comment is that comment, not a new one.
    const draft = documentStore.composerDraft;
    if (!draft) throw new Error('No comment open');
    setDocumentComposerDraft({ ...draft, noteSaveStatus: 'error' });
    blockAction('note')?.click();
    expect(documentStore.composerDraft).toMatchObject({ id: draft.id, noteSaveStatus: 'error' });
    blockAction('question')?.click();
    expect(documentStore.composerDraft).toMatchObject({
      mode: 'question',
      text: 'Is this still true?',
    });
    await Promise.resolve();
    expect(saved).toEqual([]);
    // Mid-save, switching would post the same text twice: as a comment and again.
    setDocumentComposerDraft({
      text: 'Is this still true?',
      mode: 'note',
      noteSaveStatus: 'saving',
    });
    blockAction('question')?.click();
    expect(documentStore.composerDraft?.mode).toBe('note');
    // Emptying the comment drops its backup, so later tests start clean.
    setDocumentComposerDraft({ text: '', mode: 'note' });
    setDocumentComposerDraft(null);
  });

  it('announces loading to screen readers without a chip in the header', async () => {
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    const opening = openDocumentWorkspace('docs');
    const status = host.querySelector('.docws-header [role="status"]');
    expect(status?.textContent).toBe('Loading document…');
    await opening;
    expect(status?.textContent).toBe('');
  });

  it('renders as a task workspace region, leaving app navigation available', () => {
    const host = openWorkspace();
    const workspace = host.querySelector('[aria-label="Document workspace"]');
    expect(workspace?.getAttribute('role')).toBe('region');
    expect(workspace?.hasAttribute('aria-modal')).toBe(false);
  });

  it('opens the project folder in the file manager from the title', () => {
    const host = openWorkspace();
    const open = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Open the folder /projects/release in the file manager"]',
    );
    open?.click();
    expect(revealItemInDir).toHaveBeenCalledWith('/projects/release');
  });

  it('keeps the composer away until there is something to compose', () => {
    const host = openWorkspace();
    expect(host.querySelector('.docws-composer')).toBeNull();

    button(host, 'Rewrite')?.click();

    expect(documentStore.composerDraft).toMatchObject({ text: '', mode: 'proposals' });
    expect(button(host, 'Rewrite')).not.toBeNull();
  });

  it('selects without opening a composer, then saves a comment on the same passage and lists it', async () => {
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel, args) => {
      if (channel === IPC.ReadDocument)
        return { content: 'First paragraph.\n\nSecond paragraph.\n', missing: false, dirty: false };
      if (channel === IPC.SaveDocumentAnnotation) return args?.annotation;
      return [];
    });
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    await vi.waitFor(() => expect(host.querySelector('[data-block-index="0"]')).not.toBeNull());
    // A plain click picks nothing; a text selection does.
    host
      .querySelector('[data-block-index="0"]')
      ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(documentStore.selection).toBeNull();
    selectText(host, 0);
    expect(documentStore.selection?.startBlock).toBe(0);
    expect(host.querySelector('.docws-composer')).toBeNull();
    blockAction('note')?.click();
    const box = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]');
    if (!box) throw new Error('No comment composer');
    box.value = 'Check this assumption.';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    host
      .querySelector('[data-block-index="1"]')
      ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    host
      .querySelector('.docws-scroll')
      ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(documentStore.selection?.startBlock).toBe(0);
    // A file update invalidates the old range, but must not strand this draft.
    setDocumentSelection(null);
    expect(box.value).toBe('Check this assumption.');
    expect(host.textContent).toContain('Select a passage in the document to attach this draft.');
    box.dispatchEvent(new FocusEvent('blur'));
    expect(documentStore.annotations).toHaveLength(0);
    selectText(host, 0);
    expect(documentStore.selection?.startBlock).toBe(0);
    box.dispatchEvent(new FocusEvent('blur'));
    await vi.waitFor(() => expect(documentStore.annotations).toHaveLength(1));
    expect(documentStore.annotations[0].anchor.quote).toContain('First paragraph.');
    expect(host.querySelector('.docws-composer')).toBeNull();
    // The comments live on a tab of the panel, which opens when asked for.
    host
      .querySelector<HTMLButtonElement>('[aria-label="Side panel"][aria-pressed="false"]')
      ?.click();
    button(host, 'Comments')?.click();
    expect(host.querySelector('[aria-label="Document comments"]')?.textContent).toContain(
      'Check this assumption.',
    );
    expect(store.projects[0].documentPanelCollapsed).toBe(false);
  });

  it('lets the document take the full width of the pane', () => {
    const host = openWorkspace();
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Full width"]');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('.docws-doc')?.classList.contains('is-full-width')).toBe(false);

    toggle?.click();

    expect(store.documentFullWidth).toBe(true);
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.docws-doc')?.classList.contains('is-full-width')).toBe(true);
  });

  it('places the agent, runs and comments panel to the right in a wide panel', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    setStore({
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
      activeDocumentProjectId: 'docs',
    });
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(render(() => <DocumentWorkspacePanel />, host));

    expect(host.querySelector('.docws-body .resize-handle-h')).not.toBeNull();
    expect(host.querySelector('.docws-body .resize-handle-v')).toBeNull();
    const rail = host.querySelector<HTMLElement>('.docws-rail');
    expect(rail?.parentElement?.style.width).toBe('360px');
    const tabs = Array.from(rail?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Agent', 'Runs', 'Comments']);
    expect(rail?.querySelector('[aria-label="Project files"]')).toBeNull();

    tabs[2]?.click();

    expect(rail?.querySelector('[aria-label="Document comments"]')).not.toBeNull();
  });

  it('remembers a collapsed rail without remounting the agent or losing its width', () => {
    const host = openWorkspace();
    const rail = host.querySelector('.docws-rail');
    expect(host.querySelector('.docws-split')?.classList.contains('is-rail-collapsed')).toBe(true);
    host
      .querySelector<HTMLButtonElement>('[aria-label="Side panel"][aria-pressed="false"]')
      ?.click();
    expect(store.projects[0].documentPanelCollapsed).toBe(false);
    expect(host.querySelector('.docws-split')?.classList.contains('is-rail-collapsed')).toBe(false);
    host
      .querySelector<HTMLButtonElement>('[aria-label="Side panel"][aria-pressed="true"]')
      ?.click();
    expect(store.projects[0].documentPanelCollapsed).toBe(true);
    expect(host.querySelector('.docws-rail')).toBe(rail);
    expect(host.querySelector('.docws-rail')).toBe(rail);
  });

  it('restores the agent column width without treating the former bottom-panel height as a width', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    setStore('panelUserSize', { 'docws-task:rail': 240 });
    const host = openWorkspace();
    const rail = host.querySelector<HTMLElement>('.docws-rail');
    expect(rail?.parentElement?.style.width).toBe('360px');
    setStore('panelUserSize', 'docws:rail', 500);
    expect(rail?.parentElement?.style.width).toBe('500px');
  });

  it('keeps Document and History as tabs and leaves comparing to a modal', () => {
    setStore({
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
      activeDocumentProjectId: 'docs',
    });
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(render(() => <DocumentWorkspacePanel />, host));

    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('.docws-header [role="tab"]'));
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Document', 'History']);
    expect(document.querySelector('.docws-compare-dialog')).toBeNull();
  });

  it('opens the document in the configured editor from the title', () => {
    setStore({
      projects: [
        {
          id: 'docs',
          name: 'Release notes',
          path: '/projects/release',
          color: '',
          kind: 'document',
          documentPath: 'docs/notes.md',
        },
      ],
      activeDocumentProjectId: 'docs',
      editorCommand: 'code',
    });
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(render(() => <DocumentWorkspacePanel />, host));

    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Open docs/notes.md in code"]',
    );
    expect(button).not.toBeNull();

    button?.click();

    expect(openInEditor).toHaveBeenCalledWith('code', '/projects/release/docs/notes.md');
  });

  it('keeps the editor button visible but disabled until an editor is configured', () => {
    setStore({
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
      activeDocumentProjectId: 'docs',
      editorCommand: '',
    });
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(render(() => <DocumentWorkspacePanel />, host));

    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Configure an editor command in Settings to open notes.md"]',
    );

    expect(button?.disabled).toBe(true);
  });

  it.each([
    ['Save version', 'commit_document_edits'],
    ['Restore last version', 'discard_document_edits'],
  ])('offers %s in History, separate from disk saving', async (action, channel) => {
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) => {
      if (channel === IPC.ReadDocument) {
        return {
          content: '# Notes\n\nEdited.\n',
          headSha: '1234567890abcdef',
          branch: 'main',
          dirty: true,
          missing: false,
        };
      }
      return [];
    });
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');

    expect(host.textContent).not.toContain('uncommitted edits');
    button(host, 'History')?.click();
    await vi.waitFor(() => expect(button(host, 'Save version')).not.toBeNull());
    expect(button(host, 'Restore last version…')).not.toBeNull();
    expect(ipc.invoke).not.toHaveBeenCalledWith(channel, expect.anything());
    if (action === 'Restore last version') {
      button(host, 'Restore last version…')?.click();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        'This cannot be undone.',
      );
    }
    button(document.body, action)?.click();

    await vi.waitFor(() =>
      expect(ipc.invoke).toHaveBeenCalledWith(channel, {
        projectRoot: '/projects/release',
      }),
    );
  });
});

it('hands the prose scroller to the renderer, which holds it steady on an edit', () => {
  const host = openWorkspace();
  const scroll = host.querySelector('.docws-scroll');

  expect(scroll).not.toBeNull();
  // The renderer anchors the reading position in whatever it is given; given
  // nothing, every document silently jumps on every edit again.
  expect(createRenderedBlocks).toHaveBeenCalled();
  const scroller = vi.mocked(createRenderedBlocks).mock.calls[0][1];
  expect(scroller?.()).toBe(scroll);
});
