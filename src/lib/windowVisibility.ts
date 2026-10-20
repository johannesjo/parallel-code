import { createSignal } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';

// Hidden or minimized, as reported by the main process. Blur is deliberately
// not "hidden": an unfocused window on a second screen is still being watched.
const [windowVisible, setWindowVisible] = createSignal(true);

/** Whether the app window is on screen. UI-only polls pause while it is not. */
export const isWindowVisible = windowVisible;

/** Track main-process visibility changes; returns the unsubscribe function. */
export function startWindowVisibilityTracking(): () => void {
  return window.electron.ipcRenderer.on(IPC.WindowVisibilityChanged, (visible: unknown) => {
    setWindowVisible(visible !== false);
  });
}
