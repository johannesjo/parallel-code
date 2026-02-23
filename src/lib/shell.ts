// Shell operations — wraps Electron shell IPC calls.

import { IPC } from '../../electron/ipc/channels';

export async function revealItemInDir(filePath: string): Promise<void> {
  await window.electron.ipcRenderer.invoke(IPC.ShellReveal, { filePath });
}

export async function openFileInEditor(worktreePath: string, filePath: string): Promise<void> {
  const errorMessage = (await window.electron.ipcRenderer.invoke(IPC.ShellOpenFile, {
    worktreePath,
    filePath,
  })) as string;
  if (errorMessage) throw new Error(errorMessage);
}
