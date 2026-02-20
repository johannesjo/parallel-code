# Electron Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a parallel Electron build alongside the existing Tauri app so we can compare Linux rendering performance (Chromium vs WebKitGTK).

**Architecture:** Vite alias shims replace all `@tauri-apps/*` imports at build time, so zero existing frontend files are modified. An `electron/` directory contains the main process (BrowserWindow, IPC handlers, node-pty PTY management, git operations via child_process). The SolidJS frontend is shared between both builds.

**Tech Stack:** Electron, node-pty, electron-builder, Vite (shared), SolidJS (shared)

---

### Task 1: Electron Scaffolding — main.ts, preload.ts, package.json

**Files:**
- Create: `electron/main.ts`
- Create: `electron/preload.ts`
- Create: `electron/tsconfig.json`
- Modify: `package.json` (add electron deps + scripts)

**Step 1: Install Electron dependencies**

Run:
```bash
npm install --save-dev electron electron-builder
npm install node-pty
```

**Step 2: Create `electron/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "../dist-electron",
    "rootDir": ".",
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["./**/*.ts"]
}
```

**Step 3: Create `electron/preload.ts`**

```typescript
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electron", {
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),
  },
});
```

**Step 4: Create `electron/main.ts`**

```typescript
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "path";
import { registerAllHandlers } from "./ipc/register";

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  registerAllHandlers(mainWindow);

  // In dev, load the Vite dev server; in prod, load built files
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
```

**Step 5: Add npm scripts to `package.json`**

Add these scripts:
```json
{
  "electron:compile": "tsc -p electron/tsconfig.json",
  "electron:dev": "npm run electron:compile && concurrently -k \"vite --config electron/vite.config.electron.ts\" \"wait-on http://localhost:1421 && VITE_DEV_SERVER_URL=http://localhost:1421 electron dist-electron/main.js\"",
  "electron:build": "npm run build:electron && npm run electron:compile && electron-builder"
}
```

Also add `"main": "dist-electron/main.js"` to package.json top level.

Install utility deps:
```bash
npm install --save-dev concurrently wait-on
```

**Step 6: Commit**

```bash
git add electron/ package.json package-lock.json
git commit -m "feat(electron): scaffold main process, preload, and build scripts"
```

---

### Task 2: Vite Config with Tauri API Aliases

**Files:**
- Create: `electron/vite.config.electron.ts`

**Step 1: Create the Electron-specific Vite config**

```typescript
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import path from "path";

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@tauri-apps/api/core": path.resolve(__dirname, "shims/tauri-api-core.ts"),
      "@tauri-apps/api/window": path.resolve(__dirname, "shims/tauri-api-window.ts"),
      "@tauri-apps/api/dpi": path.resolve(__dirname, "shims/tauri-api-dpi.ts"),
      "@tauri-apps/plugin-dialog": path.resolve(__dirname, "shims/tauri-plugin-dialog.ts"),
      "@tauri-apps/plugin-opener": path.resolve(__dirname, "shims/tauri-plugin-opener.ts"),
    },
  },
});
```

**Step 2: Commit**

```bash
git add electron/vite.config.electron.ts
git commit -m "feat(electron): add Vite config with Tauri API alias shims"
```

---

### Task 3: Core Shims — invoke() and Channel

**Files:**
- Create: `electron/shims/tauri-api-core.ts`

This is the most critical shim. It must replicate Tauri's `invoke()` and `Channel<T>` class behavior.

**Step 1: Create the core shim**

```typescript
// Shim for @tauri-apps/api/core
// Replaces Tauri invoke() and Channel with Electron IPC equivalents.

declare global {
  interface Window {
    electron: {
      ipcRenderer: {
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
        on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
        removeAllListeners: (channel: string) => void;
      };
    };
  }
}

export class Channel<T> {
  private _id = crypto.randomUUID();
  private _cleanup: (() => void) | null = null;
  onmessage: ((msg: T) => void) | null = null;

  constructor() {
    this._cleanup = window.electron.ipcRenderer.on(
      `channel:${this._id}`,
      (_event: unknown, msg: T) => {
        this.onmessage?.(msg);
      }
    );
  }

  // Tauri serializes Channel by including a marker.
  // When invoke() processes args, it detects this and extracts the ID.
  toJSON() {
    return { __CHANNEL_ID__: this._id };
  }

  get id() {
    return this._id;
  }
}

// Walk args object and extract channel IDs before sending over IPC
function processArgs(args?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!args) return args;
  const processed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value && typeof value === "object" && "__CHANNEL_ID__" in (value as Record<string, unknown>)) {
      processed[key] = { __CHANNEL_ID__: (value as Record<string, unknown>).__CHANNEL_ID__ };
    } else {
      processed[key] = value;
    }
  }
  return processed;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return window.electron.ipcRenderer.invoke(cmd, processArgs(args)) as Promise<T>;
}
```

**Step 2: Commit**

```bash
git add electron/shims/tauri-api-core.ts
git commit -m "feat(electron): add core IPC shim (invoke + Channel)"
```

---

### Task 4: Window Management Shim

**Files:**
- Create: `electron/shims/tauri-api-window.ts`
- Create: `electron/shims/tauri-api-dpi.ts`

**Step 1: Create the DPI shim**

```typescript
// Shim for @tauri-apps/api/dpi
export class PhysicalPosition {
  constructor(public x: number, public y: number) {}
}

export class PhysicalSize {
  constructor(public width: number, public height: number) {}
}
```

**Step 2: Create the window shim**

This shim must implement all the window methods used in App.tsx, WindowTitleBar.tsx, and WindowResizeHandles.tsx. All calls go through ipcRenderer to the main process.

```typescript
// Shim for @tauri-apps/api/window
import { PhysicalPosition, PhysicalSize } from "./tauri-api-dpi";

type UnlistenFn = () => void;

class ElectronWindow {
  async isFocused(): Promise<boolean> {
    return window.electron.ipcRenderer.invoke("__window_is_focused") as Promise<boolean>;
  }

  async isMaximized(): Promise<boolean> {
    return window.electron.ipcRenderer.invoke("__window_is_maximized") as Promise<boolean>;
  }

  async setDecorations(_decorated: boolean): Promise<void> {
    // Decorations are set at window creation in Electron, this is a no-op
  }

  async setTitleBarStyle(_style: string): Promise<void> {
    // Title bar style is set at window creation in Electron, this is a no-op
  }

  async minimize(): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_minimize");
  }

  async toggleMaximize(): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_toggle_maximize");
  }

  async close(): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_close");
  }

  async hide(): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_hide");
  }

  async maximize(): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_maximize");
  }

  async unmaximize(): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_unmaximize");
  }

  async setSize(size: PhysicalSize): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_set_size", { width: size.width, height: size.height });
  }

  async setPosition(pos: PhysicalPosition): Promise<void> {
    await window.electron.ipcRenderer.invoke("__window_set_position", { x: pos.x, y: pos.y });
  }

  async outerPosition(): Promise<PhysicalPosition> {
    const pos = await window.electron.ipcRenderer.invoke("__window_get_position") as { x: number; y: number };
    return new PhysicalPosition(pos.x, pos.y);
  }

  async outerSize(): Promise<PhysicalSize> {
    const size = await window.electron.ipcRenderer.invoke("__window_get_size") as { width: number; height: number };
    return new PhysicalSize(size.width, size.height);
  }

  async startDragging(): Promise<void> {
    // Electron doesn't have a direct API for this from renderer.
    // We use CSS -webkit-app-region: drag instead.
    // This is a no-op — the shim exists so calls don't throw.
  }

  async startResizeDragging(_direction: string): Promise<void> {
    // Electron handles resize natively when frame: false + resizable: true.
    // Custom resize handles aren't needed — this is a no-op.
  }

  async onFocusChanged(handler: (event: { payload: boolean }) => void): Promise<UnlistenFn> {
    const off1 = window.electron.ipcRenderer.on("__window_focus", () => handler({ payload: true }));
    const off2 = window.electron.ipcRenderer.on("__window_blur", () => handler({ payload: false }));
    return () => { off1(); off2(); };
  }

  async onResized(handler: () => void): Promise<UnlistenFn> {
    return window.electron.ipcRenderer.on("__window_resized", handler);
  }

  async onMoved(handler: () => void): Promise<UnlistenFn> {
    return window.electron.ipcRenderer.on("__window_moved", handler);
  }

  async onCloseRequested(handler: (event: { preventDefault: () => void }) => void): Promise<UnlistenFn> {
    return window.electron.ipcRenderer.on("__window_close_requested", () => {
      let prevented = false;
      handler({ preventDefault: () => { prevented = true; } });
      // If not prevented, the main process will close the window
      if (!prevented) {
        window.electron.ipcRenderer.invoke("__window_close");
      }
    });
  }
}

const electronWindow = new ElectronWindow();

export function getCurrentWindow(): ElectronWindow {
  return electronWindow;
}
```

**Step 3: Commit**

```bash
git add electron/shims/tauri-api-window.ts electron/shims/tauri-api-dpi.ts
git commit -m "feat(electron): add window management and DPI shims"
```

---

### Task 5: Plugin Shims — Dialog and Opener

**Files:**
- Create: `electron/shims/tauri-plugin-dialog.ts`
- Create: `electron/shims/tauri-plugin-opener.ts`

**Step 1: Create the dialog shim**

```typescript
// Shim for @tauri-apps/plugin-dialog

interface ConfirmOptions {
  title?: string;
  kind?: string;
  okLabel?: string;
  cancelLabel?: string;
}

export async function confirm(message: string, options?: ConfirmOptions): Promise<boolean> {
  return window.electron.ipcRenderer.invoke("__dialog_confirm", { message, ...options }) as Promise<boolean>;
}

interface OpenOptions {
  directory?: boolean;
  multiple?: boolean;
}

export async function open(options?: OpenOptions): Promise<string | string[] | null> {
  return window.electron.ipcRenderer.invoke("__dialog_open", options) as Promise<string | string[] | null>;
}
```

**Step 2: Create the opener shim**

```typescript
// Shim for @tauri-apps/plugin-opener

export async function revealItemInDir(path: string): Promise<void> {
  await window.electron.ipcRenderer.invoke("__shell_reveal", path);
}
```

**Step 3: Commit**

```bash
git add electron/shims/tauri-plugin-dialog.ts electron/shims/tauri-plugin-opener.ts
git commit -m "feat(electron): add dialog and opener plugin shims"
```

---

### Task 6: PTY IPC Handler (node-pty)

**Files:**
- Create: `electron/ipc/pty.ts`

This is the most performance-critical handler. It must match the Rust side's batching strategy and base64 output format exactly.

**Step 1: Create the PTY handler**

```typescript
import * as pty from "node-pty";
import type { BrowserWindow } from "electron";

interface PtySession {
  proc: pty.IPty;
  channelId: string;
  taskId: string;
  agentId: string;
}

const sessions = new Map<string, PtySession>();

export function spawnAgent(
  win: BrowserWindow,
  args: {
    taskId: string;
    agentId: string;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
    onOutput: { __CHANNEL_ID__: string };
  }
): void {
  const channelId = args.onOutput.__CHANNEL_ID__;

  const command = args.command || process.env.SHELL || "/bin/sh";
  const spawnEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    ...args.env,
  };

  // Clear env vars that prevent nested agent sessions
  delete spawnEnv.CLAUDECODE;
  delete spawnEnv.CLAUDE_CODE_SESSION;
  delete spawnEnv.CLAUDE_CODE_ENTRYPOINT;

  const proc = pty.spawn(command, args.args, {
    name: "xterm-256color",
    cols: args.cols,
    rows: args.rows,
    cwd: args.cwd,
    env: spawnEnv,
  });

  sessions.set(args.agentId, { proc, channelId, taskId: args.taskId, agentId: args.agentId });

  // Batching strategy matching the Rust implementation:
  // - 8ms timer interval
  // - 64KB max batch size
  // - Small reads (<1024 bytes) flush immediately (interactive prompts)
  let batch = Buffer.alloc(0);
  let flushTimer: NodeJS.Timeout | null = null;
  const BATCH_MAX = 64 * 1024;
  const BATCH_INTERVAL = 8;

  // Raw byte tail buffer for exit diagnostics
  const TAIL_CAP = 8 * 1024;
  let tailBuf = Buffer.alloc(0);
  const MAX_LINES = 50;

  const flush = () => {
    if (batch.length === 0) return;
    const encoded = batch.toString("base64");
    if (!win.isDestroyed()) {
      win.webContents.send(`channel:${channelId}`, { type: "Data", data: encoded });
    }
    batch = Buffer.alloc(0);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  proc.onData((data) => {
    const chunk = Buffer.from(data);

    // Maintain tail buffer for exit diagnostics
    tailBuf = Buffer.concat([tailBuf, chunk]);
    if (tailBuf.length > TAIL_CAP) {
      tailBuf = tailBuf.subarray(tailBuf.length - TAIL_CAP);
    }

    batch = Buffer.concat([batch, chunk]);

    if (batch.length >= BATCH_MAX) {
      flush();
      return;
    }

    // Small read = interactive prompt, flush immediately
    if (chunk.length < 1024) {
      flush();
      return;
    }

    if (!flushTimer) {
      flushTimer = setTimeout(flush, BATCH_INTERVAL);
    }
  });

  proc.onExit(({ exitCode, signal }) => {
    // Flush remaining data
    flush();

    // Parse tail buffer into last N lines
    const tailStr = tailBuf.toString("utf8");
    const lines = tailStr
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => l.length > 0)
      .slice(-MAX_LINES);

    if (!win.isDestroyed()) {
      win.webContents.send(`channel:${channelId}`, {
        type: "Exit",
        data: {
          exit_code: exitCode,
          signal: signal !== undefined ? String(signal) : null,
          last_output: lines,
        },
      });
    }

    sessions.delete(args.agentId);
  });
}

export function writeToAgent(agentId: string, data: string): void {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  session.proc.write(data);
}

export function resizeAgent(agentId: string, cols: number, rows: number): void {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  session.proc.resize(cols, rows);
}

export function killAgent(agentId: string): void {
  const session = sessions.get(agentId);
  if (session) {
    session.proc.kill();
    sessions.delete(agentId);
  }
}

export function countRunningAgents(): number {
  return sessions.size;
}

export function killAllAgents(): void {
  for (const [id, session] of sessions) {
    session.proc.kill();
    sessions.delete(id);
  }
}
```

**Step 2: Commit**

```bash
git add electron/ipc/pty.ts
git commit -m "feat(electron): add node-pty PTY management handler"
```

---

### Task 7: Git IPC Handlers

**Files:**
- Create: `electron/ipc/git.ts`

Port all git commands from Rust `src-tauri/src/git/mod.rs`. They're all `child_process.execFile` calls.

**Step 1: Create the git handler**

Implement all git commands:
- `get_gitignored_dirs(projectRoot)` — check `git check-ignore` for symlink candidates
- `get_main_branch(projectRoot)` — detect main/master with TTL cache
- `get_current_branch(projectRoot)` — `git symbolic-ref --short HEAD`
- `get_changed_files(worktreePath)` — `git diff --raw --numstat` + `git status --porcelain`
- `get_file_diff(worktreePath, filePath)` — `git diff <merge-base> -- <file>`
- `get_worktree_status(worktreePath)` — committed + uncommitted change detection
- `check_merge_status(worktreePath)` — `git rev-list --count` + `git merge-tree --write-tree`
- `merge_task(projectRoot, branchName, squash, message, cleanup)` — full merge workflow
- `get_branch_log(worktreePath)` — `git log <main>..HEAD --pretty=format:- %s`
- `push_task(projectRoot, branchName)` — `git push -u origin`
- `rebase_task(worktreePath)` — `git rebase <main>`

Also internal helpers:
- `create_worktree(repoRoot, branchName, symlinkDirs)` — used by `create_task`
- `remove_worktree(repoRoot, branchName, deleteBranch)` — used by `delete_task`

Reference the Rust `src-tauri/src/git/mod.rs` for exact git argument lists and error handling. Use `child_process.execFileSync` wrapped in promises for simplicity (these are fast operations).

Key implementation notes:
- TTL caches: Use `Map<string, { value: string; expiresAt: number }>` matching Rust's 60s main branch / 30s merge base TTLs
- Worktree lock: Use a simple `Map<string, Promise<void>>` chain for serialization (replaces Rust's `tokio::sync::Mutex`)
- Symlink candidates: Same list as Rust `SYMLINK_CANDIDATES`
- `normalize_status_path`: Handle rename `old -> new` format, strip quotes
- `parse_conflict_path`: Same regex-free parsing as Rust

**Step 2: Commit**

```bash
git add electron/ipc/git.ts
git commit -m "feat(electron): add git operations IPC handler"
```

---

### Task 8: Task, Agent, and Persistence IPC Handlers

**Files:**
- Create: `electron/ipc/tasks.ts`
- Create: `electron/ipc/agents.ts`
- Create: `electron/ipc/persistence.ts`

**Step 1: Create the tasks handler**

Port `src-tauri/src/tasks/mod.rs`:
- `create_task(name, projectRoot, symlinkDirs, branchPrefix)` → calls git `create_worktree`, returns `{ id: uuid, branch_name, worktree_path }`
- `delete_task(agentIds, branchName, deleteBranch, projectRoot)` → kills agents, calls git `remove_worktree`
- `slug(name)` and `sanitize_branch_prefix(prefix)` helper functions

**Step 2: Create the agents handler**

Port `src-tauri/src/agents/mod.rs` + `types.rs`:
- `list_agents()` → returns hardcoded array of `{ id, name, command, args, resume_args, description }`
- Same three agents: Claude Code, Codex CLI, Gemini CLI

**Step 3: Create the persistence handler**

Port `src-tauri/src/persistence.rs`:
- `save_app_state(json)` → atomic write to `app.getPath('userData')/state.json`
- `load_app_state()` → read from state.json with .bak fallback
- Use `-dev` suffix for userData dir in development mode

**Step 4: Commit**

```bash
git add electron/ipc/tasks.ts electron/ipc/agents.ts electron/ipc/persistence.ts
git commit -m "feat(electron): add task, agent, and persistence IPC handlers"
```

---

### Task 9: IPC Registration + Window Event Forwarding

**Files:**
- Create: `electron/ipc/register.ts`

This file wires all IPC handlers and forwards window events to the renderer.

**Step 1: Create the registration module**

```typescript
import { ipcMain, dialog, shell, BrowserWindow } from "electron";
import { spawnAgent, writeToAgent, resizeAgent, killAgent, countRunningAgents, killAllAgents } from "./pty";
import { /* all git functions */ } from "./git";
import { createTask, deleteTask } from "./tasks";
import { listAgents } from "./agents";
import { saveAppState, loadAppState } from "./persistence";

export function registerAllHandlers(win: BrowserWindow): void {
  // PTY commands
  ipcMain.handle("spawn_agent", (_e, args) => spawnAgent(win, args));
  ipcMain.handle("write_to_agent", (_e, args) => writeToAgent(args.agentId, args.data));
  ipcMain.handle("resize_agent", (_e, args) => resizeAgent(args.agentId, args.cols, args.rows));
  ipcMain.handle("kill_agent", (_e, args) => killAgent(args.agentId));
  ipcMain.handle("count_running_agents", () => countRunningAgents());
  ipcMain.handle("kill_all_agents", () => killAllAgents());

  // Agent commands
  ipcMain.handle("list_agents", () => listAgents());

  // Task commands
  ipcMain.handle("create_task", (_e, args) => createTask(args.name, args.projectRoot, args.symlinkDirs, args.branchPrefix));
  ipcMain.handle("delete_task", (_e, args) => deleteTask(args.agentIds, args.branchName, args.deleteBranch, args.projectRoot));

  // Git commands
  ipcMain.handle("get_changed_files", (_e, args) => getChangedFiles(args.worktreePath));
  ipcMain.handle("get_file_diff", (_e, args) => getFileDiff(args.worktreePath, args.filePath));
  ipcMain.handle("get_gitignored_dirs", (_e, args) => getGitIgnoredDirs(args.projectRoot));
  ipcMain.handle("get_worktree_status", (_e, args) => getWorktreeStatus(args.worktreePath));
  ipcMain.handle("check_merge_status", (_e, args) => checkMergeStatus(args.worktreePath));
  ipcMain.handle("merge_task", (_e, args) => mergeTask(args.projectRoot, args.branchName, args.squash, args.message, args.cleanup));
  ipcMain.handle("get_branch_log", (_e, args) => getBranchLog(args.worktreePath));
  ipcMain.handle("push_task", (_e, args) => pushTask(args.projectRoot, args.branchName));
  ipcMain.handle("rebase_task", (_e, args) => rebaseTask(args.worktreePath));
  ipcMain.handle("get_main_branch", (_e, args) => getMainBranch(args.projectRoot));
  ipcMain.handle("get_current_branch", (_e, args) => getCurrentBranch(args.projectRoot));

  // Persistence
  ipcMain.handle("save_app_state", (_e, args) => saveAppState(args.json));
  ipcMain.handle("load_app_state", () => loadAppState());

  // Window management
  ipcMain.handle("__window_is_focused", () => win.isFocused());
  ipcMain.handle("__window_is_maximized", () => win.isMaximized());
  ipcMain.handle("__window_minimize", () => win.minimize());
  ipcMain.handle("__window_toggle_maximize", () => {
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  ipcMain.handle("__window_close", () => win.close());
  ipcMain.handle("__window_hide", () => win.hide());
  ipcMain.handle("__window_maximize", () => win.maximize());
  ipcMain.handle("__window_unmaximize", () => win.unmaximize());
  ipcMain.handle("__window_set_size", (_e, args) => win.setSize(args.width, args.height));
  ipcMain.handle("__window_set_position", (_e, args) => win.setPosition(args.x, args.y));
  ipcMain.handle("__window_get_position", () => {
    const [x, y] = win.getPosition();
    return { x, y };
  });
  ipcMain.handle("__window_get_size", () => {
    const [width, height] = win.getSize();
    return { width, height };
  });

  // Dialog
  ipcMain.handle("__dialog_confirm", async (_e, args) => {
    const result = await dialog.showMessageBox(win, {
      type: args.kind === "warning" ? "warning" : "question",
      title: args.title || "Confirm",
      message: args.message,
      buttons: [args.okLabel || "OK", args.cancelLabel || "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    return result.response === 0;
  });

  ipcMain.handle("__dialog_open", async (_e, args) => {
    const properties: ("openDirectory" | "openFile" | "multiSelections")[] = [];
    if (args?.directory) properties.push("openDirectory");
    else properties.push("openFile");
    if (args?.multiple) properties.push("multiSelections");
    const result = await dialog.showOpenDialog(win, { properties });
    if (result.canceled) return null;
    return args?.multiple ? result.filePaths : result.filePaths[0] ?? null;
  });

  // Shell/Opener
  ipcMain.handle("__shell_reveal", (_e, filePath) => {
    shell.showItemInFolder(filePath as string);
  });

  // Forward window events to renderer
  win.on("focus", () => win.webContents.send("__window_focus"));
  win.on("blur", () => win.webContents.send("__window_blur"));
  win.on("resize", () => win.webContents.send("__window_resized"));
  win.on("move", () => win.webContents.send("__window_moved"));

  win.on("close", (e) => {
    e.preventDefault();
    win.webContents.send("__window_close_requested");
  });
}
```

**Step 2: Commit**

```bash
git add electron/ipc/register.ts
git commit -m "feat(electron): add IPC registration and window event forwarding"
```

---

### Task 10: Handle CSS Differences (data-tauri-drag-region)

**Files:**
- Modify: `electron/shims/tauri-api-window.ts` (already done — startDragging is a no-op)
- Note: Need to add CSS for `-webkit-app-region: drag` in the Electron build

The `data-tauri-drag-region` attribute is used on the macOS titlebar spacer and the Windows/Linux titlebar. In Electron, we need CSS to handle dragging.

**Step 1: Create a small CSS override**

Add to `electron/main.ts` — inject CSS at window load:

```typescript
mainWindow.webContents.on("did-finish-load", () => {
  mainWindow?.webContents.insertCSS(`
    [data-tauri-drag-region] { -webkit-app-region: drag; }
    [data-tauri-drag-region] button, [data-tauri-drag-region] input { -webkit-app-region: no-drag; }
  `);
});
```

**Step 2: Commit**

```bash
git add electron/main.ts
git commit -m "feat(electron): inject CSS for drag region compatibility"
```

---

### Task 11: Handle Argument Passing Differences

**Files:**
- Modify: `electron/ipc/register.ts` (if needed)

The Tauri `invoke()` passes named arguments as a single object. The frontend calls like:
```typescript
invoke("write_to_agent", { agentId, data })
```

In our shim, `invoke()` calls `ipcRenderer.invoke(cmd, processedArgs)` which passes the args object as a single argument. The `ipcMain.handle` callbacks receive `(event, args)` where `args` is that single object. This matches — **but we need to verify** that all handler registrations destructure args correctly.

Specifically check:
- Tauri commands use snake_case for argument names (`agent_id`, `task_id`, etc.)
- Frontend `invoke()` calls use camelCase (`agentId`, `taskId`)
- Tauri auto-converts between them — **Electron does not**

**Step 1: Audit all invoke calls in the frontend**

Check every `invoke()` call in `src/` to see what argument names the frontend actually sends. Then verify the Electron IPC handlers use the same names. The frontend sends camelCase (e.g., `agentId`), so the handlers must use camelCase too.

Important: Tauri's `#[tauri::command]` macro automatically converts camelCase from JS to snake_case in Rust. Our Electron handlers receive the raw camelCase names from the frontend.

For example:
- Frontend: `invoke("spawn_agent", { taskId, agentId, command, ... })`
- Electron handler must use: `args.taskId`, `args.agentId`, `args.command`
- But git commands like `get_changed_files` receive: `invoke("get_changed_files", { worktreePath })`
- Handler uses: `args.worktreePath`

**Step 2: Verify and fix any mismatches, then commit**

```bash
git add electron/
git commit -m "fix(electron): align IPC argument naming with frontend camelCase"
```

---

### Task 12: Smoke Test — Run the Electron Build

**Step 1: Compile and run**

```bash
cd /home/johannes/www/parallel-code/.worktrees/feat/performance-on-linux-not-very-good
npm run electron:dev
```

**Step 2: Verify these work:**
- App window opens
- Custom titlebar shows (on Linux)
- Can create a new task (worktree + terminal spawning)
- Terminal renders output (xterm.js + WebGL)
- Can type in terminal
- Can close task
- Window resize works
- State persists across restart

**Step 3: Fix any runtime issues found during testing**

**Step 4: Commit any fixes**

```bash
git add .
git commit -m "fix(electron): runtime fixes from smoke testing"
```

---

### Task 13: Final Cleanup and Documentation

**Step 1: Add `.gitignore` entries**

Add to `.gitignore`:
```
dist-electron/
```

**Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore(electron): add dist-electron to gitignore"
```

---

## File Inventory

### New files (all in `electron/`):
| File | Purpose |
|------|---------|
| `electron/main.ts` | Electron main process entry |
| `electron/preload.ts` | Context bridge for secure IPC |
| `electron/tsconfig.json` | TypeScript config for main process |
| `electron/vite.config.electron.ts` | Vite config with Tauri API aliases |
| `electron/shims/tauri-api-core.ts` | invoke() + Channel shim |
| `electron/shims/tauri-api-window.ts` | Window management shim |
| `electron/shims/tauri-api-dpi.ts` | PhysicalPosition/PhysicalSize shim |
| `electron/shims/tauri-plugin-dialog.ts` | Dialog shim |
| `electron/shims/tauri-plugin-opener.ts` | Opener shim |
| `electron/ipc/register.ts` | IPC handler registration |
| `electron/ipc/pty.ts` | node-pty PTY management |
| `electron/ipc/git.ts` | Git operations |
| `electron/ipc/tasks.ts` | Task/worktree lifecycle |
| `electron/ipc/agents.ts` | Agent definitions |
| `electron/ipc/persistence.ts` | State save/load |

### Modified files:
| File | Change |
|------|--------|
| `package.json` | Add electron/node-pty deps + scripts |
| `.gitignore` | Add dist-electron/ |

### Unchanged files:
All `src/` files — zero frontend modifications.
