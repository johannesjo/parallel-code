import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesPopover } from './FilesPopover';
import { setFilesOpen, workspaceUi } from './workspace-ui';

const { openDocumentFile } = vi.hoisted(() => ({ openDocumentFile: vi.fn() }));
vi.mock('./store', () => ({
  activeDocumentPath: () => 'notes.md',
  documentStore: { snapshot: null },
  openDocumentFile,
}));
vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(() => Promise.resolve(['notes.md', 'plan.md', 'docs/guide.md', 'docs/api.md'])),
}));

let dispose: (() => void) | undefined;

function mount(recentPaths: string[] = []) {
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => <FilesPopover projectRoot="/p" openPath="notes.md" recentPaths={recentPaths} />,
    host,
  );
  return host;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

function press(el: Element, key: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

beforeEach(() => openDocumentFile.mockClear());
afterEach(() => {
  dispose?.();
  dispose = undefined;
  setFilesOpen(false);
  document.body.replaceChildren();
});

describe('FilesPopover', () => {
  it('is a button that announces a popup', () => {
    const host = mount();
    const button = host.querySelector('.docws-file-path');
    expect(button?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
  });

  it('filters by substring and opens the match with Enter', async () => {
    const host = mount();
    setFilesOpen(true);
    await tick();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Filter files"]');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    type(input as HTMLInputElement, 'GUIDE');
    const options = host.querySelectorAll('[role="option"]');
    expect(Array.from(options).map((o) => o.textContent)).toEqual(['docs/guide.md']);
    press(input as HTMLInputElement, 'Enter');
    expect(openDocumentFile).toHaveBeenCalledWith('docs/guide.md');
    expect(workspaceUi.filesOpen).toBe(false);
  });

  it('moves the active match with the arrow keys', async () => {
    const host = mount();
    setFilesOpen(true);
    await tick();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Filter files"]');
    type(input as HTMLInputElement, 'docs/');
    press(input as HTMLInputElement, 'ArrowDown');
    press(input as HTMLInputElement, 'Enter');
    expect(openDocumentFile).toHaveBeenCalledWith('docs/api.md');
  });

  it('lists recent files above the tree without the open one', async () => {
    const host = mount(['notes.md', 'plan.md', 'docs/api.md']);
    setFilesOpen(true);
    await tick();
    const options = host.querySelectorAll('[role="option"]');
    expect(Array.from(options).map((o) => o.textContent)).toEqual(['plan.md', 'docs/api.md']);
    expect(host.textContent).toContain('Recent');
  });

  it('omits Recent when nothing else was opened', async () => {
    const host = mount(['notes.md']);
    setFilesOpen(true);
    await tick();
    expect(host.textContent).not.toContain('Recent');
  });

  it('closes on Escape without letting the key reach the workspace', async () => {
    const host = mount();
    const reached = vi.fn();
    window.addEventListener('keydown', reached);
    setFilesOpen(true);
    await tick();
    press(host.querySelector('input') as HTMLInputElement, 'Escape');
    window.removeEventListener('keydown', reached);
    expect(workspaceUi.filesOpen).toBe(false);
    expect(reached).not.toHaveBeenCalled();
  });

  it('opens when the shortcut sets the shared flag', async () => {
    const host = mount();
    setFilesOpen(true);
    await tick();
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
