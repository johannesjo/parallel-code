import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setStore } from '../store/core';
import { DocumentWorkspaceOverlay } from './DocumentWorkspaceOverlay';

const { openInEditor } = vi.hoisted(() => ({
  openInEditor: vi.fn(() => Promise.resolve()),
}));

vi.mock('../lib/shell', () => ({ openInEditor }));

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  setStore({ projects: [], activeDocumentProjectId: null, editorCommand: '' });
  vi.clearAllMocks();
});

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
