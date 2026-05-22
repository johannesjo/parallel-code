// Auto-update — wraps electron-updater's `autoUpdater` so the renderer can
// check GitHub Releases for a newer version, download it, and relaunch onto
// it without a manual reinstall.
//
// Auto-update only works for packaged builds that have an in-place update
// channel: macOS (signed) and the Linux AppImage. A dev run or the Linux
// `deb` target has no channel, so we report `unsupported` rather than letting
// electron-updater throw.

import { app, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateInfo, ProgressInfo, AppUpdater } from 'electron-updater';
import { IPC } from './channels.js';
import { debug, info, warn, error as logError, errMessage } from '../log.js';

// `electronUpdater.autoUpdater` is a lazy getter that instantiates a
// platform updater (and touches `app`) on first access. Resolve it lazily so
// importing this module never triggers that — important for unit tests where
// `electron.app` is not a real instance.
function getAutoUpdater(): AppUpdater {
  return electronUpdater.autoUpdater;
}

const LOG = 'updater';

export type UpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  /** Version this app is currently running. */
  currentVersion: string;
  /** Version offered by the latest check, when newer than `currentVersion`. */
  latestVersion: string | null;
  /** 0–100 while `phase` is `downloading`. */
  downloadPercent: number;
  /** Human-readable message when `phase` is `error`. */
  error: string | null;
}

// The Linux AppImage runtime sets APPIMAGE to the mounted image path. Its
// absence on Linux means a non-updatable target (e.g. an installed `.deb`).
// `app` is undefined when this module is loaded outside an Electron runtime
// (e.g. a unit test), so guard every access.
function isAutoUpdateSupported(): boolean {
  if (!app?.isPackaged) return false;
  if (process.platform === 'darwin') return true;
  if (process.platform === 'linux') return !!process.env.APPIMAGE;
  return false;
}

const status: UpdateStatus = {
  phase: 'idle',
  currentVersion: '',
  latestVersion: null,
  downloadPercent: 0,
  error: null,
};

let mainWindow: BrowserWindow | null = null;
let wired = false;
let startupCheckTimer: ReturnType<typeof setTimeout> | null = null;

function broadcast(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.UpdateStatusChanged, { ...status });
  }
}

function setPhase(phase: UpdatePhase, patch: Partial<UpdateStatus> = {}): void {
  status.phase = phase;
  Object.assign(status, patch);
  broadcast();
}

function wireUpdaterEvents(): void {
  if (wired) return;
  wired = true;

  const autoUpdater = getAutoUpdater();

  // Downloads are user-initiated; a finished download installs on next quit.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    setPhase('checking', { error: null });
  });

  autoUpdater.on('update-available', (infoEvt: UpdateInfo) => {
    info(LOG, 'update available', { version: infoEvt.version });
    setPhase('available', { latestVersion: infoEvt.version, error: null });
  });

  autoUpdater.on('update-not-available', () => {
    debug(LOG, 'no update available');
    setPhase('up-to-date', { latestVersion: null, error: null });
  });

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    // Fires many times per second; only broadcast when the rounded percent
    // (the only value the UI shows) actually moves.
    const percent = Math.round(progress.percent);
    if (status.phase === 'downloading' && status.downloadPercent === percent) return;
    setPhase('downloading', { downloadPercent: percent });
  });

  autoUpdater.on('update-downloaded', (infoEvt: UpdateInfo) => {
    info(LOG, 'update downloaded', { version: infoEvt.version });
    setPhase('downloaded', { latestVersion: infoEvt.version, downloadPercent: 100 });
  });

  autoUpdater.on('error', (err: Error) => {
    const message = errMessage(err);
    warn(LOG, 'updater error', { error: message });
    setPhase('error', { error: message });
  });
}

/**
 * Wire the updater to a window and run one silent check shortly after launch.
 * Safe to call when auto-update is unsupported — it becomes a no-op.
 */
export function initAutoUpdater(win: BrowserWindow): void {
  mainWindow = win;
  status.currentVersion = app?.getVersion?.() ?? '';
  if (!isAutoUpdateSupported()) {
    setPhase('unsupported');
    debug(LOG, 'auto-update unsupported in this build');
    return;
  }
  wireUpdaterEvents();
  // Delay the first check so it does not compete with app startup work.
  startupCheckTimer = setTimeout(() => {
    startupCheckTimer = null;
    void checkForUpdates();
  }, 10_000);
  win.once('closed', () => {
    if (startupCheckTimer) {
      clearTimeout(startupCheckTimer);
      startupCheckTimer = null;
    }
    // Detach event handlers so a re-created window re-wires from a clean
    // slate. `removeAllListeners` is safe because this module is the sole
    // consumer of the `autoUpdater` singleton.
    getAutoUpdater().removeAllListeners();
    wired = false;
    mainWindow = null;
  });
}

/** Check GitHub Releases for a newer version. Resolves with the latest status. */
export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!isAutoUpdateSupported()) return { ...status };
  // A check while downloading/downloaded would clobber that progress.
  if (status.phase === 'downloading' || status.phase === 'downloaded') return { ...status };
  try {
    setPhase('checking', { error: null });
    await getAutoUpdater().checkForUpdates();
  } catch (err) {
    setPhase('error', { error: errMessage(err) });
  }
  return { ...status };
}

/** Download the available update; progress is reported via the status event. */
export async function downloadUpdate(): Promise<UpdateStatus> {
  if (status.phase !== 'available') return { ...status };
  try {
    setPhase('downloading', { downloadPercent: 0, error: null });
    await getAutoUpdater().downloadUpdate();
  } catch (err) {
    setPhase('error', { error: errMessage(err) });
  }
  return { ...status };
}

/** Relaunch onto a downloaded update. No-op unless an update is downloaded. */
export function quitAndInstallUpdate(): void {
  if (status.phase !== 'downloaded') return;
  try {
    getAutoUpdater().quitAndInstall();
  } catch (err) {
    logError(LOG, 'quitAndInstall failed', err);
    setPhase('error', { error: errMessage(err) });
  }
}

export function getUpdateStatus(): UpdateStatus {
  return { ...status };
}
