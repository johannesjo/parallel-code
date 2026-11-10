// Window management — wraps Electron window IPC calls.

import { IPC } from '../../electron/ipc/channels';

export type Position = { x: number; y: number };
export type Size = { width: number; height: number };

type UnlistenFn = () => void;

class AppWindow {
  async isFocused(): Promise<boolean> {
    return window.electron.ipcRenderer.invoke(IPC.WindowIsFocused) as Promise<boolean>;
  }

  async isMaximized(): Promise<boolean> {
    return window.electron.ipcRenderer.invoke(IPC.WindowIsMaximized) as Promise<boolean>;
  }

  async minimize(): Promise<void> {
    await window.electron.ipcRenderer.invoke(IPC.WindowMinimize);
  }

  async toggleMaximize(): Promise<void> {
    await window.electron.ipcRenderer.invoke(IPC.WindowToggleMaximize);
  }

  async close(): Promise<void> {
    await window.electron.ipcRenderer.invoke(IPC.WindowClose);
  }

  async hide(): Promise<void> {
    await window.electron.ipcRenderer.invoke(IPC.WindowHide);
  }

  async outerPosition(): Promise<Position> {
    return (await window.electron.ipcRenderer.invoke(IPC.WindowGetPosition)) as Position;
  }

  async outerSize(): Promise<Size> {
    return (await window.electron.ipcRenderer.invoke(IPC.WindowGetSize)) as Size;
  }

  async onFocusChanged(handler: (event: { payload: boolean }) => void): Promise<UnlistenFn> {
    const off1 = window.electron.ipcRenderer.on(IPC.WindowFocus, () => handler({ payload: true }));
    const off2 = window.electron.ipcRenderer.on(IPC.WindowBlur, () => handler({ payload: false }));
    return () => {
      off1();
      off2();
    };
  }

  async onResized(handler: () => void): Promise<UnlistenFn> {
    return window.electron.ipcRenderer.on(IPC.WindowResized, handler);
  }

  async onMoved(handler: () => void): Promise<UnlistenFn> {
    return window.electron.ipcRenderer.on(IPC.WindowMoved, handler);
  }

  async onCloseRequested(
    handler: (event: { preventDefault: () => void }) => Promise<void> | void,
  ): Promise<UnlistenFn> {
    return window.electron.ipcRenderer.on(IPC.WindowCloseRequested, () => {
      // The 5s backend watchdog stays armed while the handler does async
      // pre-work (captureWindowState, saveState, CountRunningAgents). It is
      // cleared only when preventDefault() is called below — so a hang in
      // that pre-work path still gets force-closed. A crash before this
      // point hits the backend fallback directly.
      let prevented = false;
      const result = handler({
        preventDefault: () => {
          prevented = true;
          // Disarm the 5s watchdog now that the renderer is showing an
          // interactive dialog and owns the close outcome. Sent only here,
          // after all async pre-work has completed. Best-effort: failure
          // must not abort the close flow.
          try {
            void window.electron.ipcRenderer.invoke(IPC.WindowCloseHandling).catch(() => {});
          } catch {
            /* ack is best-effort */
          }
        },
      });
      // Handle async handlers
      if (result instanceof Promise) {
        result
          .then(() => {
            if (!prevented) {
              window.electron.ipcRenderer.invoke(IPC.WindowForceClose);
            }
          })
          .catch((err) => {
            console.error('Close handler failed, force-closing:', err);
            window.electron.ipcRenderer.invoke(IPC.WindowForceClose);
          });
      } else if (!prevented) {
        window.electron.ipcRenderer.invoke(IPC.WindowForceClose);
      }
    });
  }
}

export const appWindow = new AppWindow();
