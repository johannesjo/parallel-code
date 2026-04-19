import { app, BrowserWindow, session, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { registerAllHandlers } from './ipc/register.js';
import { killAllAgents } from './ipc/pty.js';
import { stopAllPlanWatchers } from './ipc/plans.js';
import { stopAllStepsWatchers } from './ipc/steps.js';
import { IPC } from './ipc/channels.js';
import { resolveUserShell } from './user-shell.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// When launched from a .desktop file (e.g. AppImage), the environment is
// minimal — often just PATH=/usr/bin:/bin. Resolve the user's full
// login-interactive shell environment and merge it into process.env so
// spawned PTYs can find CLI tools (claude, codex, gemini, etc.) and
// inherit other expected variables (SSH_AGENT_LAUNCHER, KUBECONFIG, etc.).
//
// Uses -ilc (interactive + login) to source both .zprofile/.profile AND
// .zshrc/.bashrc, where version managers (nvm, volta, fnm) add to PATH.
// A perl one-liner dumps every env var as null-delimited key=value pairs,
// bounded by sentinel markers to isolate the data from noisy shell init.
//
// Trade-off: -i (interactive) triggers .zshrc side effects (compinit, conda,
// welcome messages). Login-only (-lc) would be quieter but would miss tools
// that are only added to PATH in .bashrc/.zshrc (e.g. nvm). We accept the
// side effects since the sentinel-based parsing discards all other output.
// Another trade-off: inheriting the *full* environment (rather than just PATH)
// can pull in large variables (certificates, tokens, kubeconfig). We set a
// generous maxBuffer and fall back to the original environment on failure.
//
// Skip vars that would alter Electron/Node runtime behavior if a user's shell
// rc sets them — those belong to our process, not the login shell.
const PROTECTED_ENV_KEYS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

function fixEnv(): void {
  if (process.platform === 'win32') return;
  try {
    const loginShell = resolveUserShell();
    const sentinel = '__PCODE_ENV__';
    const result = execFileSync(
      loginShell,
      [
        '-ilc',
        `printf '${sentinel}' && perl -e 'print "$_=$ENV{$_}\\0" for keys %ENV' && printf '${sentinel}'`,
      ],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
    );
    const startIdx = result.indexOf(sentinel);
    const endIdx = result.lastIndexOf(sentinel);
    if (startIdx === -1 || endIdx === -1 || startIdx === endIdx) return;

    const envBlock = result.slice(startIdx + sentinel.length, endIdx);
    for (const entry of envBlock.split('\0')) {
      if (!entry) continue;
      const eqIdx = entry.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = entry.slice(0, eqIdx);
      if (PROTECTED_ENV_KEYS.has(key)) continue;
      process.env[key] = entry.slice(eqIdx + 1);
    }
  } catch (err) {
    console.warn('[fixEnv] Failed to resolve login shell environment:', err);
  }
}

fixEnv();

// Verify that preload.cjs ALLOWED_CHANNELS stays in sync with the IPC enum.
// Logs a warning in dev if they drift — catches mismatches before they hit users.
function verifyPreloadAllowlist(): void {
  try {
    const preloadPath = path.join(__dirname, '..', 'electron', 'preload.cjs');
    const preloadSrc = fs.readFileSync(preloadPath, 'utf8');
    const enumValues = new Set(Object.values(IPC));
    const hasChannel = (channel: string) =>
      preloadSrc.includes(`'${channel}'`) || preloadSrc.includes(`"${channel}"`);
    const missing = [...enumValues].filter((v) => !hasChannel(v));
    if (missing.length > 0) {
      console.warn(
        `[preload-sync] IPC channels missing from preload.cjs ALLOWED_CHANNELS: ${missing.join(', ')}`,
      );
    }
  } catch {
    // Preload file may not be readable in packaged app — skip check
  }
}

if (!app.isPackaged) verifyPreloadAllowlist();

let mainWindow: BrowserWindow | null = null;

function getIconPath(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon.png');
  }
  return path.join(__dirname, '..', 'build', 'icon.png');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: getIconPath(),
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  registerAllHandlers(mainWindow);

  // Open links in external browser instead of inside Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell
        .openExternal(url)
        .catch((e: unknown) => console.warn('[main] Failed to open external URL:', e));
    }
    return { action: 'deny' };
  });

  const devOrigin = process.env.VITE_DEV_SERVER_URL;
  let allowedOrigin: string | undefined;
  try {
    if (devOrigin) allowedOrigin = new URL(devOrigin).origin;
  } catch {
    // Malformed dev URL — skip origin allowlist
  }

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (allowedOrigin && url.startsWith(allowedOrigin)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell
        .openExternal(url)
        .catch((e: unknown) => console.warn('[main] Failed to open external URL:', e));
    }
  });

  // Inject CSS to make data-tauri-drag-region work in Electron
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.insertCSS(`
      [data-tauri-drag-region] { -webkit-app-region: drag; }
      [data-tauri-drag-region] button,
      [data-tauri-drag-region] input,
      [data-tauri-drag-region] select,
      [data-tauri-drag-region] textarea { -webkit-app-region: no-drag; }
    `);
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Grant microphone and clipboard access (deny camera/video)
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
        return callback(true);
      }
      if (permission === 'media') {
        const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
        return callback(types.every((t) => t === 'audio'));
      }
      callback(false);
    },
  );

  createWindow();
});

app.on('before-quit', () => {
  killAllAgents();
  stopAllPlanWatchers();
  stopAllStepsWatchers();
});

app.on('window-all-closed', () => {
  app.quit();
});
