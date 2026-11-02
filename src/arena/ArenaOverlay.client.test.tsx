import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { ArenaOverlay } from './ArenaOverlay';
import { Dialog } from '../components/Dialog';

vi.mock('./persistence', () => ({
  loadArenaPresets: vi.fn(() => Promise.resolve()),
  loadArenaHistory: vi.fn(() => Promise.resolve()),
  saveArenaPresets: vi.fn(() => Promise.resolve()),
}));
vi.mock('../lib/ipc', () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

const tab = () =>
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
  );

it('leaves Tab to a dialog opened over the arena', () => {
  dispose = render(
    () => (
      <>
        <ArenaOverlay onClose={vi.fn()} />
        <Dialog open onClose={vi.fn()} ariaLabel="Commit">
          <button type="button">First</button>
          <button type="button">Second</button>
        </Dialog>
      </>
    ),
    document.body,
  );
  const [first, second] = [...document.querySelectorAll<HTMLButtonElement>('.dialog-panel button')];
  first.focus();
  tab();
  expect(document.activeElement).toBe(second);
});
