// Dialog — wraps Electron dialog IPC calls.

import { IPC } from "../../electron/ipc/channels";

interface ConfirmOptions {
  title?: string;
  kind?: string;
  okLabel?: string;
  cancelLabel?: string;
}

export async function confirm(
  message: string,
  options?: ConfirmOptions
): Promise<boolean> {
  return window.electron.ipcRenderer.invoke(IPC.DialogConfirm, {
    message,
    ...options,
  }) as Promise<boolean>;
}

interface OpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
}

export async function openDialog(
  options?: OpenDialogOptions
): Promise<string | string[] | null> {
  return window.electron.ipcRenderer.invoke(
    IPC.DialogOpen,
    options
  ) as Promise<string | string[] | null>;
}
