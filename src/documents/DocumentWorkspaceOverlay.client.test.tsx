import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { DocumentWorkspaceOverlay } from './DocumentWorkspaceOverlay';
import { documentStore, setDocumentComposerDraft, openDocumentWorkspace } from './store';
import { IPC } from '../../electron/ipc/channels';
import * as ipc from '../lib/ipc';
import { createRenderedBlocks } from './use-blocks';
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
  for (const id of Object.keys(store.agents)) clearAgentActivity(id);
  document.body.replaceChildren();
  setStore({
    projects: [],
    activeDocumentProjectId: null,
    editorCommand: '',
    documentFullWidth: false,
    documentWorkspacesEnabled: false,
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
  disposers.push(render(() => <DocumentWorkspaceOverlay />, host));
  return host;
}

function button(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) ?? null
  );
}

describe('DocumentWorkspaceOverlay', () => {
  it('bounds the composer to the document pane and remeasures on pane resize', async () => {
    let reflow: (() => void) | undefined;
    const observe = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          reflow = callback;
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
      button(host, 'Revise document')?.click();
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
    'returns to the task area when navigating via %s',
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
      expect(store.activeDocumentProjectId).toBeNull();
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
    disposers.push(render(() => <DocumentWorkspaceOverlay />, reopened));
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

  it('scales HTML page previews while preserving their sandbox', async () => {
    vi.spyOn(ipc, 'invoke').mockImplementation(async (channel) =>
      channel === IPC.ReadDocument
        ? { content: '<!doctype html><html><body><h1>Guide</h1></body></html>', missing: false }
        : [],
    );
    const host = openWorkspace();
    setStore('documentWorkspacesEnabled', true);
    await openDocumentWorkspace('docs');
    button(host, 'Page')?.click();
    host.querySelector<HTMLButtonElement>('[aria-label="Zoom in document"]')?.click();
    const preview = host.querySelector<HTMLIFrameElement>('iframe');
    expect(preview).not.toBeNull();
    expect(preview?.style.transform).toBe('scale(1.1)');
    expect(preview?.getAttribute('sandbox')).toBe('');
    expect(preview?.srcdoc).toContain('<h1>Guide</h1>');
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
    disposers.push(render(() => <DocumentWorkspaceOverlay />, host));

    const header = host.querySelector<HTMLElement>('.docws-header');

    expect(header?.hasAttribute('data-tauri-drag-region')).toBe(true);
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

    button(host, 'Revise document')?.click();

    expect(documentStore.composerDraft).toEqual({ text: '', mode: 'proposals' });
    expect(button(host, 'Revise document')).toBeNull();
  });

  it('lets the document take the full width of the pane', () => {
    const host = openWorkspace();
    const toggle = button(host, 'Full width');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('.docws-doc')?.classList.contains('is-full-width')).toBe(false);

    toggle?.click();

    expect(store.documentFullWidth).toBe(true);
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.docws-doc')?.classList.contains('is-full-width')).toBe(true);
  });

  it('places the agent, runs and files panel to the right of the document', () => {
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
    disposers.push(render(() => <DocumentWorkspaceOverlay />, host));

    expect(host.querySelector('.docws-body .resize-handle-h')).not.toBeNull();
    expect(host.querySelector('.docws-body .resize-handle-v')).toBeNull();
    const rail = host.querySelector<HTMLElement>('.docws-rail');
    expect(rail?.parentElement?.style.width).toBe('420px');
    const tabs = Array.from(rail?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Agent', 'Runs', 'Files']);
    expect(rail?.querySelector('[aria-label="Project files"]')).toBeNull();

    tabs[2]?.click();

    expect(rail?.querySelector('[aria-label="Project files"]')).not.toBeNull();
  });

  it('restores the agent column width without treating the former bottom-panel height as a width', () => {
    setStore('panelUserSize', { 'docws-task:rail': 240 });
    const host = openWorkspace();
    const rail = host.querySelector<HTMLElement>('.docws-rail');
    expect(rail?.parentElement?.style.width).toBe('420px');
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
    disposers.push(render(() => <DocumentWorkspaceOverlay />, host));

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
    disposers.push(render(() => <DocumentWorkspaceOverlay />, host));

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
    disposers.push(render(() => <DocumentWorkspaceOverlay />, host));

    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Configure an editor command in Settings to open notes.md"]',
    );

    expect(button?.disabled).toBe(true);
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
