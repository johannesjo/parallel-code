// Shim for @tauri-apps/plugin-opener

export async function revealItemInDir(path: string): Promise<void> {
  await window.electron.ipcRenderer.invoke("__shell_reveal", path);
}
