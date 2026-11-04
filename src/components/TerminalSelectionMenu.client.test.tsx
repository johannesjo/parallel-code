import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { TerminalSelectionMenu } from './TerminalSelectionMenu';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function mount(text = 'Selected finding', recipients = [{ id: 'codex', label: 'Codex' }]) {
  const host = document.createElement('div');
  document.body.append(host);
  const onSend = vi.fn(),
    onClose = vi.fn(),
    onOpinion = vi.fn();
  dispose = render(
    () => (
      <TerminalSelectionMenu
        x={20}
        y={30}
        text={text}
        recipients={recipients}
        onSend={onSend}
        onClose={onClose}
        onOpinion={onOpinion}
      />
    ),
    host,
  );
  return { onSend, onClose, onOpinion };
}
function button(text: string) {
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing ${text}`);
  return found;
}
it('copies the captured selection without sending it', async () => {
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const { onSend, onClose } = mount();
  button('Copy').click();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(write).toHaveBeenCalledWith('Selected finding');
  expect(onSend).not.toHaveBeenCalled();
});
it('forwards the captured text to the named recipient without reclaiming focus', () => {
  const { onSend, onClose } = mount();
  button('Send to Codex…').click();
  expect(onSend).toHaveBeenCalledWith('Selected finding', 'codex');
  expect(onClose).toHaveBeenCalledWith(false);
});
it('offers another agent when none exists and a second opinion when no text is selected', () => {
  const { onSend } = mount('Proposal', []);
  button('Ask another agent…').click();
  expect(onSend).toHaveBeenCalledWith('Proposal', undefined);
});
it('keeps second opinion accessible through the menu without a selection', () => {
  const { onOpinion } = mount('', []);
  expect(document.body.textContent).not.toContain('Copy');
  button('Second opinion…').click();
  expect(onOpinion).toHaveBeenCalledOnce();
});
it('supports arrow navigation and Escape dismissal', () => {
  const { onClose } = mount();
  const menu = document.querySelector('[role="menu"]');
  // Opened by the mouse, so no item starts out looking chosen; keys still reach it.
  expect(document.activeElement).toBe(menu);
  const press = (key: string) =>
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  press('ArrowUp');
  expect(document.activeElement).toBe(button('Second opinion…'));
  press('Home');
  press('ArrowDown');
  expect(document.activeElement).toBe(button('Send to Codex…'));
  menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(onClose).toHaveBeenCalledOnce();
});

it('keeps second opinion accessible even when right-click selected a word', () => {
  const { onOpinion } = mount('word');
  button('Second opinion…').click();
  expect(onOpinion).toHaveBeenCalledOnce();
});

it('edits a right-clicked document path as a document', () => {
  const onEditAsDocument = vi.fn();
  const onClose = vi.fn();
  dispose = render(
    () => (
      <TerminalSelectionMenu
        x={20}
        y={30}
        text=""
        recipients={[]}
        onSend={vi.fn()}
        onClose={onClose}
        documentPath="/work/app/docs/spec.md"
        onEditAsDocument={onEditAsDocument}
      />
    ),
    document.body,
  );
  button('Edit as document').click();
  expect(onEditAsDocument).toHaveBeenCalledWith('/work/app/docs/spec.md');
  expect(onClose).toHaveBeenCalledWith(false);
});
it('runs a clicked link action and closes without restoring terminal focus', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const run = vi.fn(),
    onClose = vi.fn();
  dispose = render(
    () => (
      <TerminalSelectionMenu
        x={20}
        y={30}
        text=""
        recipients={[]}
        onSend={vi.fn()}
        onClose={onClose}
        actions={[{ label: 'Open in dialog', run }]}
      />
    ),
    host,
  );
  expect([...document.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([
    'Open in dialog',
  ]);
  button('Open in dialog').click();
  expect(run).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledWith(false);
});

it('reports a quick second press as a double-click, and a later one as a dismissal', () => {
  vi.useFakeTimers();
  const host = document.createElement('div');
  document.body.append(host);
  const onDoubleClick = vi.fn(),
    onClose = vi.fn();
  const menu = () => (
    <TerminalSelectionMenu
      x={20}
      y={30}
      text=""
      recipients={[]}
      onSend={vi.fn()}
      onClose={onClose}
      onDoubleClick={onDoubleClick}
      actions={[{ label: 'Copy path', run: vi.fn() }]}
    />
  );
  const press = () =>
    document
      .querySelector('.terminal-selection-backdrop')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  dispose = render(menu, host);
  press();
  expect(onDoubleClick).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
  dispose();

  dispose = render(menu, host);
  document
    .querySelector('.terminal-selection-backdrop')
    ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
  expect(onDoubleClick).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
  onClose.mockClear();
  dispose();

  dispose = render(menu, host);
  vi.advanceTimersByTime(600);
  press();
  expect(onDoubleClick).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
  vi.useRealTimers();
});
it('offers actions on the terminal process even without a selection', () => {
  const run = vi.fn();
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => (
      <TerminalSelectionMenu
        x={20}
        y={30}
        text=""
        recipients={[]}
        onSend={vi.fn()}
        onClose={onClose}
        paneActions={[{ label: 'Resume with flags…', run }]}
      />
    ),
    host,
  );
  button('Resume with flags…').click();
  expect(run).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledWith(false);
});
