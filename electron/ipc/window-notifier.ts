import type { BrowserWindow } from 'electron';
import type { Notify } from './notify.js';

/** A `Notify` that sends to the window and drops messages once it is destroyed. */
export function windowNotifier(win: BrowserWindow): Notify {
  return (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };
}
