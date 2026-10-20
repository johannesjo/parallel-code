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
  expect(document.activeElement).toBe(button('Copy'));
  menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
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
  expect(document.activeElement).toBe(button('Edit as document'));
  button('Edit as document').click();
  expect(onEditAsDocument).toHaveBeenCalledWith('/work/app/docs/spec.md');
  expect(onClose).toHaveBeenCalledWith(false);
});
