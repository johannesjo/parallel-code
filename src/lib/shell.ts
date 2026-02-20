// Shell operations — wraps Electron shell IPC calls.

import { IPC } from "../../electron/ipc/channels";

export async function revealItemInDir(path: string): Promise<void> {
  await window.electron.ipcRenderer.invoke(IPC.ShellReveal, path);
}
