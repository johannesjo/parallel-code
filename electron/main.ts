import { app, autoUpdater, BrowserWindow, Menu, ipcMain, session, shell } from 'electron';
import { buildMenuTemplate } from './menu-template.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { registerAllHandlers } from './ipc/register.js';
import { registerLogHandler } from './log.js';
import { installIpcTracing } from './ipc/trace.js';
import { startAgentHookRuntime, stopAgentHookRuntime } from './agent-hooks/runtime.js';
import { killAllAgents } from './ipc/pty.js';
import { stopAllPlanWatchers } from './ipc/plans.js';
import { stopAllStepsWatchers } from './ipc/steps.js';
import { verificationRunner } from './ipc/verify.js';
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

// Blink evicts the oldest WebGL context past 16 per renderer process, and every
// mounted terminal pane holds one — hidden task/tab terminals included. Past 16
// terminals the oldest panes silently lose their context and degrade to xterm's
// slower DOM renderer (janky scrolling). 64 covers heavy layouts (~20 tasks ×
// 3 panes — parallel tasks are the app's premise, so 32 was reachable) while
// staying bounded: Chromium keeps its cap low because past it GPU drivers tend
// to crash rather than report out-of-memory, so a huge value trades graceful
// eviction for GPU-process crashes on weak GPUs. The switch also raises the
// worker-context limit to the same value (unused — no WebGL in our workers).
app.commandLine.appendSwitch('max-active-webgl-contexts', '64');

// Verify that preload.cjs ALLOWED_CHANNELS stays in sync with the IPC enum.
// Logs a warning in dev if they drift — catches mismatches before they hit users.
//
// preload.cjs uses an inline ALLOWED_CHANNELS literal because sandboxed
// preloads cannot require arbitrary local JSON. Keep that literal in sync
// with the shared channel manifest that backs the IPC export.
function verifyPreloadAllowlist(): void {
  try {
    const preloadPath = path.join(__dirname, '..', 'electron', 'preload.cjs');
    const preloadSrc = fs.readFileSync(preloadPath, 'utf8');
    const allowlistMatch = /new Set\(\[([\s\S]*?)\]\)/.exec(preloadSrc);
    if (!allowlistMatch) {
      console.warn('[preload-sync] preload.cjs ALLOWED_CHANNELS literal not found');
      return;
    }
    const preloadValues = new Set(
      [...allowlistMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]),
    );
    const enumValues = new Set(Object.values(IPC));
    const missing = [...enumValues].filter((v) => !preloadValues.has(v));
    const extra = [...preloadValues].filter((v) => !enumValues.has(v));
    if (missing.length > 0 || extra.length > 0) {
      console.warn(
        `[preload-sync] preload.cjs ALLOWED_CHANNELS drift: missing=${missing.join(', ')} extra=${extra.join(', ')}`,
      );
    }
  } catch {
    // Preload file may not be readable in packaged app — skip check
  }
}

if (!app.isPackaged) verifyPreloadAllowlist();

let mainWindow: BrowserWindow | null = null;

// Set only while an update relaunch is genuinely in flight — see the listener
// in `whenReady` — so `before-quit` can let that one quit through unchallenged.
let quittingForUpdate = false;

function getIconPath(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon.png');
  }
  return path.join(__dirname, '..', 'build', 'icon.png');
}

function setupApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        platform: process.platform,
        appName: app.name,
        onQuit: () => app.quit(),
      }),
    ),
  );
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

  // Order matters: register the LogFromRenderer handler BEFORE installing
  // the IPC tracing wrapper so log forwards don't themselves emit ipc/git
  // debug traces (which would triple log volume in dev/verbose).
  registerLogHandler(ipcMain);
  installIpcTracing(ipcMain);
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

app.whenReady().then(async () => {
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

  // electron-updater stages the install, then quits through `app.quit()`.
  // Vetoing that quit below would leave the update staged with the app still
  // running, so let it through — the window's own close prompt still asks about
  // running terminals, and `autoInstallOnAppQuit` re-applies the update on the
  // next quit if the user backs out. Both platform paths announce the relaunch
  // on Electron's own updater immediately before quitting (the AppImage updater
  // emits it by hand, Squirrel natively), so this is set only while a quit is
  // genuinely in flight — unlike a flag set when the install is *requested*,
  // which sticks for the whole session on the many paths where
  // `quitAndInstall()` returns without quitting.
  autoUpdater.on('before-quit-for-update', () => {
    quittingForUpdate = true;
  });

  // Listening before the window exists: a renderer cannot spawn a Claude
  // agent that misses its hooks. Failure falls back to PTY heuristics.
  await startAgentHookRuntime(() => mainWindow);
  setupApplicationMenu();
  createWindow();
});

// A quit reaches `before-quit` *before* any window `close` event, so tearing
// down agents here destroyed the very terminals the close dialog was about to
// ask about — and destroyed them even when the user then cancelled the quit.
// Decide here, tear down in `will-quit`: route the quit through the window so
// the renderer's close handler owns the "kill / keep alive in background /
// cancel" decision, and nothing is destroyed until it answers.
//
// Consequence worth knowing: with terminals running this vetoes a macOS
// logout/restart too, the way any app with a confirm-on-quit prompt does.
app.on('before-quit', (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || quittingForUpdate) return;
  event.preventDefault();
  // The confirmation is a sheet on this window, and show() also focuses — a
  // quit from the menu while the app sits hidden must not prompt invisibly.
  mainWindow.show();
  mainWindow.close();
});

// Runs only on a quit that got through the check above, so it cannot destroy
// anything the user still had a chance to cancel.
app.on('will-quit', () => {
  killAllAgents();
  // Detached process groups would outlive Electron otherwise.
  verificationRunner.cancelAll();
  stopAgentHookRuntime();
  stopAllPlanWatchers();
  stopAllStepsWatchers();
});

// "Keep them alive in the background" hides the window; without this the dock
// icon is a dead end and the only way back is attempting to quit.
app.on('activate', () => {
  mainWindow?.show();
});

app.on('window-all-closed', () => {
  app.quit();
});
