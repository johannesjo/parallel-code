// Shell operations — wraps Electron shell IPC calls.

import { IPC } from "../../electron/ipc/channels";

export async function revealItemInDir(filePath: string): Promise<void> {
  await window.electron.ipcRenderer.invoke(IPC.ShellReveal, { filePath });
}
