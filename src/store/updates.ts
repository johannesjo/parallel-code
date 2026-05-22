// Auto-update store slice — tracks the backend updater's status and exposes
// check / download / install actions to the Settings UI. Status is transient
// (not persisted): it is re-derived from the main process on every launch.

import { createSignal } from 'solid-js';
import { invoke, fireAndForget } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { error } from '../lib/log';
import type { UpdateStatus } from '../ipc/types';

const INITIAL: UpdateStatus = {
  phase: 'idle',
  currentVersion: '',
  latestVersion: null,
  downloadPercent: 0,
  error: null,
};

// Backend pushes can repeat (e.g. progress events that round to the same
// percent); a field-wise `equals` keeps the signal from notifying on no-ops.
function statusEquals(a: UpdateStatus, b: UpdateStatus): boolean {
  return (
    a.phase === b.phase &&
    a.currentVersion === b.currentVersion &&
    a.latestVersion === b.latestVersion &&
    a.downloadPercent === b.downloadPercent &&
    a.error === b.error
  );
}

const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>(INITIAL, {
  equals: statusEquals,
});

export { updateStatus };

function isUpdateStatus(value: unknown): value is UpdateStatus {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.phase === 'string' && typeof v.currentVersion === 'string';
}

/** Subscribe to backend update-status pushes and pull the current status.
 *  Returns a cleanup that detaches the listener. */
export function startUpdateSubscription(): () => void {
  const off = window.electron.ipcRenderer.on(IPC.UpdateStatusChanged, (data: unknown) => {
    if (isUpdateStatus(data)) setUpdateStatus(data);
  });
  // The main process runs a silent check after launch — pull whatever it has.
  invoke<UpdateStatus>(IPC.GetUpdateStatus)
    .then((s) => {
      if (isUpdateStatus(s)) setUpdateStatus(s);
    })
    .catch((err: unknown) => error('updates', 'failed to load update status', err));
  return off;
}

/** Ask the main process to check GitHub Releases for a newer version. */
export async function checkForUpdates(): Promise<void> {
  try {
    const s = await invoke<UpdateStatus>(IPC.CheckForUpdates);
    if (isUpdateStatus(s)) setUpdateStatus(s);
  } catch (err) {
    error('updates', 'check failed', err);
  }
}

/** Start downloading the available update. Progress arrives via the subscription. */
export function downloadUpdate(): void {
  fireAndForget(IPC.DownloadUpdate);
}

/** Relaunch the app onto a downloaded update. */
export function installUpdate(): void {
  fireAndForget(IPC.QuitAndInstallUpdate);
}
