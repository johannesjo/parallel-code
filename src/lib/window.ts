// Window management — wraps Electron window IPC calls.

import { IPC } from "../../electron/ipc/channels";

export type Position = { x: number; y: number };
export type Size = { width: number; height: number };

type UnlistenFn = () => void;

class AppWindow {
  async isFocused(): Promise<boolean> {
    return window.electron.ipcRenderer.invoke(
      IPC.WindowIsFocused
    ) as Promise<boolean>;
  }

  async isMaximized(): Promise<boolean> {
    return window.electron.ipcRenderer.invoke(
      IPC.WindowIsMaximized
    ) as Promise<boolean>;
  }

  async setDecorations(_decorated: boolean): Promise<void> {
    // Set at BrowserWindow creation time in Electron — no-op
  }

  async setTitleBarStyle(_style: string): Promise<void> {
    // Set at BrowserWindow creation time in Electron — no-op
  }

  async minimize(): Promise<void> {
    await window.electron.ipcRenderer.invoke(IPC.WindowMinimize);
  }

  async toggleMaximize(): Promise<void> {
    await window.electron.ipcRenderer.invoke(IPC.WindowToggleMaximize);
  }

  async maximize(): Promise<void> {
    await window.electron.ipcRenderer.invoke(IPC.WindowMaximize);
  }

  async unmaximize(): Promise<void> {
    await window.electron.ipcRenderer.invoke(IPC.WindowUnmaximize);
  }

  async close(): Promise<void> {
    await window.electron.ipcRenderer.invoke(IPC.WindowClose);
  }

  async hide(): Promise<void> {
    await window.electron.ipcRenderer.invoke(IPC.WindowHide);
  }

  async setSize(size: Size): Promise<void> {
    await window.electron.ipcRenderer.invoke(IPC.WindowSetSize, {
      width: size.width,
      height: size.height,
    });
  }

  async setPosition(pos: Position): Promise<void> {
    await window.electron.ipcRenderer.invoke(IPC.WindowSetPosition, {
      x: pos.x,
      y: pos.y,
    });
  }

  async outerPosition(): Promise<Position> {
    return (await window.electron.ipcRenderer.invoke(
      IPC.WindowGetPosition
    )) as Position;
  }

  async outerSize(): Promise<Size> {
    return (await window.electron.ipcRenderer.invoke(
      IPC.WindowGetSize
    )) as Size;
  }

  async startDragging(): Promise<void> {
    // Electron uses CSS -webkit-app-region: drag instead
  }

  async startResizeDragging(_direction: string): Promise<void> {
    // Electron handles resize natively with resizable: true
  }

  async onFocusChanged(
    handler: (event: { payload: boolean }) => void
  ): Promise<UnlistenFn> {
    const off1 = window.electron.ipcRenderer.on(IPC.WindowFocus, () =>
      handler({ payload: true })
    );
    const off2 = window.electron.ipcRenderer.on(IPC.WindowBlur, () =>
      handler({ payload: false })
    );
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
    handler: (event: { preventDefault: () => void }) => Promise<void> | void
  ): Promise<UnlistenFn> {
    return window.electron.ipcRenderer.on(IPC.WindowCloseRequested, () => {
      let prevented = false;
      const result = handler({
        preventDefault: () => {
          prevented = true;
        },
      });
      // Handle async handlers
      if (result instanceof Promise) {
        result.then(() => {
          if (!prevented) {
            window.electron.ipcRenderer.invoke(IPC.WindowForceClose);
          }
        }).catch((err) => {
          console.error("Close handler failed, force-closing:", err);
          window.electron.ipcRenderer.invoke(IPC.WindowForceClose);
        });
      } else if (!prevented) {
        window.electron.ipcRenderer.invoke(IPC.WindowForceClose);
      }
    });
  }
}

export const appWindow = new AppWindow();
