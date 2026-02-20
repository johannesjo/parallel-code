import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electron", {
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      ipcRenderer.on(channel, (_event, ...eventArgs) => listener(...eventArgs));
      return () => { ipcRenderer.removeListener(channel, listener); };
    },
    removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),
  },
});
