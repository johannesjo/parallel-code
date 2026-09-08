import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStore, store } from '../store/core';
import { DocumentWorkspaceOverlay } from './DocumentWorkspaceOverlay';
import { documentStore, setDocumentComposerDraft } from './store';

const { openInEditor, revealItemInDir, platform } = vi.hoisted(() => ({
  openInEditor: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
  platform: { isMac: false },
}));

vi.mock('../lib/shell', () => ({ openInEditor, revealItemInDir }));
vi.mock('../lib/platform', () => ({
  get isMac() {
    return platform.isMac;
  },
  windowChromeTopInset: 34,
  mod: 'Ctrl',
  alt: 'Alt',
}));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  setStore({
    projects: [],
    activeDocumentProjectId: null,
    editorCommand: '',
    documentFullWidth: false,
  });
  setDocumentComposerDraft(null);
  vi.clearAllMocks();
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

  it('moves the title clear of the mac window controls', () => {
    platform.isMac = true;
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

    expect(host.querySelector('.docws-overlay')?.classList.contains('is-mac')).toBe(true);
    platform.isMac = false;
  });

  it('starts below the custom title bar so its window controls stay clickable', () => {
    const host = openWorkspace();
    expect(host.querySelector<HTMLElement>('.docws-overlay')?.style.top).toBe('34px');
  });

  it('lays the overlay over the whole window on mac, where the title bar is the content', () => {
    platform.isMac = true;
    const host = openWorkspace();
    expect(host.querySelector<HTMLElement>('.docws-overlay')?.style.top).toBe('');
    platform.isMac = false;
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

  it('keeps the project files on a tab of the resizable right panel', () => {
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
    const rail = host.querySelector<HTMLElement>('.docws-rail');
    const tabs = Array.from(rail?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Agent', 'Runs', 'Files']);
    expect(rail?.querySelector('[aria-label="Project files"]')).toBeNull();

    tabs[2]?.click();

    expect(rail?.querySelector('[aria-label="Project files"]')).not.toBeNull();
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
