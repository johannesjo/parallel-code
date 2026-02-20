import { app, BrowserWindow, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { registerAllHandlers } from "./ipc/register.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// When launched from a .desktop file, PATH is minimal (/usr/bin:/bin).
// Resolve the user's full login shell PATH so spawned PTYs can find
// CLI tools like claude, codex, gemini, etc.
function fixPath(): void {
  if (process.platform === "win32") return;
  try {
    const shell = process.env.SHELL || "/bin/sh";
    const result = execFileSync(shell, ["-ilc", "echo -n $PATH"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.trim()) {
      process.env.PATH = result.trim();
    }
  } catch {
    // Keep existing PATH if shell invocation fails
  }
}

fixPath();

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
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

app.on("window-all-closed", () => {
  app.quit();
});
