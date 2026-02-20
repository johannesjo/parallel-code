// Shim for @tauri-apps/plugin-dialog

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
  return window.electron.ipcRenderer.invoke("__dialog_confirm", {
    message,
    ...options,
  }) as Promise<boolean>;
}

interface OpenOptions {
  directory?: boolean;
  multiple?: boolean;
}

export async function open(
  options?: OpenOptions
): Promise<string | string[] | null> {
  return window.electron.ipcRenderer.invoke(
    "__dialog_open",
    options
  ) as Promise<string | string[] | null>;
}
