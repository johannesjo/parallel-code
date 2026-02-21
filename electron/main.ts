import { app, BrowserWindow, shell } from "electron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { registerAllHandlers } from "./ipc/register.js";
import { killAllAgents } from "./ipc/pty.js";
import { IPC } from "./ipc/channels.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// When launched from a .desktop file, PATH is minimal (/usr/bin:/bin).
// Resolve the user's full login-interactive shell PATH so spawned PTYs
// can find CLI tools like claude, codex, gemini, etc.
//
// Uses -ilc (interactive + login) to source both .zprofile/.profile AND
// .zshrc/.bashrc, where version managers (nvm, volta, fnm) add to PATH.
// Sentinel markers isolate PATH from noisy shell init output.
//
// Trade-off: -i (interactive) triggers .zshrc side effects (compinit, conda,
// welcome messages). Login-only (-lc) would be quieter but would miss tools
// that are only added to PATH in .bashrc/.zshrc (e.g. nvm). We accept the
// side effects since the sentinel-based parsing discards all other output.
function fixPath(): void {
  if (process.platform === "win32") return;
  try {
    const loginShell = process.env.SHELL || "/bin/sh";
    const sentinel = "__PCODE_PATH__";
    const result = execFileSync(
      loginShell,
      ["-ilc", `printf "${sentinel}%s${sentinel}" "$PATH"`],
      { encoding: "utf8", timeout: 5000 }
    );
    const match = result.match(new RegExp(`${sentinel}(.+?)${sentinel}`));
    if (match?.[1]) {
      process.env.PATH = match[1];
    }
  } catch {
    // Keep existing PATH if shell invocation fails
  }
}

fixPath();

// Verify that preload.cjs ALLOWED_CHANNELS stays in sync with the IPC enum.
// Logs a warning in dev if they drift — catches mismatches before they hit users.
function verifyPreloadAllowlist(): void {
  try {
    const preloadPath = path.join(__dirname, "..", "electron", "preload.cjs");
    const preloadSrc = fs.readFileSync(preloadPath, "utf8");
    const enumValues = new Set(Object.values(IPC));
    const missing = [...enumValues].filter((v) => !preloadSrc.includes(`"${v}"`));
    if (missing.length > 0) {
      console.warn(`[preload-sync] IPC channels missing from preload.cjs ALLOWED_CHANNELS: ${missing.join(", ")}`);
    }
  } catch {
    // Preload file may not be readable in packaged app — skip check
  }
}

if (!app.isPackaged) verifyPreloadAllowlist();

let mainWindow: BrowserWindow | null = null;

function getIconPath(): string | undefined {
  if (process.platform !== "linux") return undefined;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "icon.png");
  }
  return path.join(__dirname, "..", "build", "icon.png");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: getIconPath(),
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  registerAllHandlers(mainWindow);

  // Open links in external browser instead of inside Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http:") || url.startsWith("https:")) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });

  const devOrigin = process.env.VITE_DEV_SERVER_URL;
  let allowedOrigin: string | undefined;
  try {
    if (devOrigin) allowedOrigin = new URL(devOrigin).origin;
  } catch {
    // Malformed dev URL — skip origin allowlist
  }

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (allowedOrigin && url.startsWith(allowedOrigin)) return;
    if (url.startsWith("file://")) return;
    event.preventDefault();
    if (url.startsWith("http:") || url.startsWith("https:")) {
      shell.openExternal(url).catch(() => {});
    }
  });

  // Inject CSS to make data-tauri-drag-region work in Electron
  mainWindow.webContents.on("did-finish-load", () => {
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
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on("before-quit", () => {
  killAllAgents();
});

app.on("window-all-closed", () => {
  app.quit();
});
