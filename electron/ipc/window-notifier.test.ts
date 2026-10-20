import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { windowNotifier } from './window-notifier.js';

function fakeWindow() {
  let destroyed = false;
  const send = vi.fn();
  const win = { isDestroyed: () => destroyed, webContents: { send } } as unknown as BrowserWindow;
  return { win, send, destroy: () => (destroyed = true) };
}

describe('windowNotifier', () => {
  it('sends to the window while it exists and drops messages afterwards', () => {
    const { win, send, destroy } = fakeWindow();
    const notify = windowNotifier(win);

    notify('channel:a', { n: 1 });
    destroy();
    notify('channel:a', { n: 2 });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('channel:a', { n: 1 });
  });
});
