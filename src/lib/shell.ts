// Shell operations — wraps Electron shell IPC calls.

import { IPC } from '../../electron/ipc/channels';

export async function revealItemInDir(filePath: string): Promise<void> {
  await window.electron.ipcRenderer.invoke(IPC.ShellReveal, { filePath });
}

/**
 * Opens a worktree file. With `line` and a known `editorCommand` (VS Code
 * family, Zed, Sublime) the editor jumps to that line; otherwise the OS
 * default app opens the file.
 */
export async function openFileInEditor(
  worktreePath: string,
  filePath: string,
  at?: { line?: number; editorCommand?: string },
): Promise<void> {
  const errorMessage = (await window.electron.ipcRenderer.invoke(IPC.ShellOpenFile, {
    worktreePath,
    filePath,
    line: at?.line,
    editorCommand: at?.editorCommand || undefined,
  })) as string;
  if (errorMessage) throw new Error(errorMessage);
}

export async function openInEditor(editorCommand: string, worktreePath: string): Promise<void> {
  await window.electron.ipcRenderer.invoke(IPC.ShellOpenInEditor, {
    editorCommand,
    worktreePath,
  });
}
