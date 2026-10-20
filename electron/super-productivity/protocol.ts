/**
 * `parallelcode://` links, sent by Super Productivity's "Start in Parallel
 * Code" task action. The only accepted link is
 * `parallelcode://new-task?spTaskId=<id>`; see parseParallelCodeUrl.
 *
 * A link can arrive before the renderer listens (cold start, or macOS
 * delivering `open-url` before the window exists), so the id is parked here
 * and the renderer pulls it: once when its listener starts, and again on
 * every OpenTaskRequested nudge.
 */
import { app, type BrowserWindow } from 'electron';
import { IPC } from '../ipc/channels.js';
import { warn } from '../log.js';
import { restoreWindow } from '../window-restore.js';
import { PARALLEL_CODE_PROTOCOL, parseParallelCodeUrl } from '../shared/super-productivity.js';

let pendingSpTaskId: string | null = null;

export function findProtocolUrl(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.toLowerCase().startsWith(`${PARALLEL_CODE_PROTOCOL}:`));
}

export function handleProtocolUrl(url: string, win: BrowserWindow | null): void {
  const usable = win && !win.isDestroyed() ? win : null;
  // Opening a link is asking for the app, valid or not.
  if (usable) restoreWindow(usable);
  const parsed = parseParallelCodeUrl(url);
  if (!parsed) {
    // Log the scheme only; the rest is untrusted and may be long.
    warn('super-productivity', 'Ignored unsupported parallelcode:// link');
    return;
  }
  pendingSpTaskId = parsed.spTaskId;
  usable?.webContents.send(IPC.SuperProductivityOpenTaskRequested);
}

export function consumePendingSpOpen(): string | null {
  const id = pendingSpTaskId;
  pendingSpTaskId = null;
  return id;
}

/**
 * Make this app the default handler for `parallelcode://` on macOS, where the
 * bundle declares the scheme (package.json build.protocols) but another app
 * may have claimed it. Packaged builds only: a dev run would point the OS at
 * the dev Electron binary and keep it there. Linux is left alone: the .deb
 * registers the scheme at install time, and on an AppImage that isn't
 * desktop-integrated the call can only fail, on every launch.
 */
export function registerParallelCodeProtocol(): void {
  if (!app.isPackaged || process.platform !== 'darwin') return;
  if (!app.setAsDefaultProtocolClient(PARALLEL_CODE_PROTOCOL))
    warn('super-productivity', 'Could not register the parallelcode:// handler');
}
