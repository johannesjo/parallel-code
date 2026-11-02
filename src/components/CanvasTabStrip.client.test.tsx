import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { CanvasTabStrip } from './CanvasTabStrip';
import { canvasTabKey } from '../lib/canvas-tabs';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

function renderWith(path: string, onEditAsDocument = vi.fn()) {
  const tab = { kind: 'markdown' as const, path };
  dispose = render(
    () => (
      <CanvasTabStrip
        tabs={[tab]}
        active={canvasTabKey(tab)}
        dirty={{}}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onAdd={vi.fn()}
        onCloseAll={vi.fn()}
        fullscreen={false}
        onEnterFullscreen={vi.fn()}
        onExitFullscreen={vi.fn()}
        onOpenInDefaultEditor={vi.fn()}
        onEditAsDocument={onEditAsDocument}
      />
    ),
    document.body,
  );
  return onEditAsDocument;
}

const editButton = () =>
  document.querySelector<HTMLButtonElement>('[title^="Edit"][title$="(no commits in this task)"]');

it('offers to edit a Markdown file as a document', () => {
  const onEdit = renderWith('docs/spec.md');
  editButton()?.click();
  expect(onEdit).toHaveBeenCalledWith('docs/spec.md');
});

it('offers no document editing for a tour or a file that is not a document', () => {
  renderWith('docs/intro.tour.md');
  expect(editButton()).toBeNull();
  dispose?.();
  document.body.replaceChildren();
  renderWith('notes.txt');
  expect(editButton()).toBeNull();
});

it('returns focus to the + button when the canvas menu closes from the keyboard', () => {
  renderWith('notes.txt');
  const plus = document.querySelector<HTMLButtonElement>('[title="Open another canvas"]');
  plus?.click();
  const item = document.querySelector<HTMLButtonElement>('[role="menuitem"]');
  item?.focus();
  item?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(plus);
});
