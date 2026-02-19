import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { onMount, onCleanup, createEffect, Show, ErrorBoundary, createSignal } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { Sidebar } from "./components/Sidebar";
import { TilingLayout } from "./components/TilingLayout";
import { NewTaskDialog } from "./components/NewTaskDialog";
import { HelpDialog } from "./components/HelpDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { WindowTitleBar } from "./components/WindowTitleBar";
import { WindowResizeHandles } from "./components/WindowResizeHandles";
import { theme } from "./lib/theme";
import {
  store,
  loadAgents,
  loadState,
  saveState,
  toggleNewTaskDialog,
  toggleSidebar,
  moveActiveTask,
  resetFontScale,
  getGlobalScale,
  adjustGlobalScale,
  resetGlobalScale,
  startTaskStatusPolling,
  stopTaskStatusPolling,
  navigateRow,
  navigateColumn,
  setPendingAction,
  toggleHelpDialog,
  toggleSettingsDialog,
  sendActivePrompt,
  spawnShellForTask,
  closeShell,
  clearNotification,
  setTaskFocusedPanel,
  setWindowState,
} from "./store/store";
import type { PersistedWindowState } from "./store/types";
import { registerShortcut, initShortcuts } from "./lib/shortcuts";
import { setupAutosave } from "./store/autosave";
import { isMac, mod } from "./lib/platform";

const appWindow = getCurrentWindow();
const MIN_WINDOW_DIMENSION = 100;

function App() {
  let mainRef!: HTMLDivElement;
  const [windowFocused, setWindowFocused] = createSignal(true);
  const [windowMaximized, setWindowMaximized] = createSignal(false);

  let unlistenFocusChanged: (() => void) | null = null;
  let unlistenResized: (() => void) | null = null;
  let unlistenMoved: (() => void) | null = null;

  const syncWindowFocused = async () => {
    const focused = await appWindow.isFocused().catch(() => true);
    setWindowFocused(focused);
  };

  const syncWindowMaximized = async () => {
    const maximized = await appWindow.isMaximized().catch(() => false);
    setWindowMaximized(maximized);
  };

  const readWindowGeometry = async (): Promise<Omit<PersistedWindowState, "maximized"> | null> => {
    const [position, size] = await Promise.all([
      appWindow.outerPosition().catch(() => null),
      appWindow.outerSize().catch(() => null),
    ]);

    if (!position || !size) return null;
    if (size.width < MIN_WINDOW_DIMENSION || size.height < MIN_WINDOW_DIMENSION) return null;

    return {
      x: Math.round(position.x),
      y: Math.round(position.y),
      width: Math.round(size.width),
      height: Math.round(size.height),
    };
  };

  const captureWindowState = async (): Promise<void> => {
    const maximized = await appWindow.isMaximized().catch(() => false);
    const current = store.windowState;

    if (maximized && current) {
      if (!current.maximized) {
        setWindowState({ ...current, maximized: true });
      }
      return;
    }

    const geometry = await readWindowGeometry();
    if (!geometry) return;

    setWindowState({ ...geometry, maximized });
  };

  const restoreWindowState = async (): Promise<void> => {
    const saved = store.windowState;
    if (!saved) return;
    if (saved.width < MIN_WINDOW_DIMENSION || saved.height < MIN_WINDOW_DIMENSION) return;

    await appWindow.unmaximize().catch(() => {});
    await appWindow.setSize(new PhysicalSize(saved.width, saved.height)).catch(() => {});
    await appWindow.setPosition(new PhysicalPosition(saved.x, saved.y)).catch(() => {});

    if (saved.maximized) {
      await appWindow.maximize().catch(() => {});
    }

    void syncWindowMaximized();
  };

  // Sync theme preset to <html> so Portal content inherits CSS variables
  createEffect(() => {
    document.documentElement.dataset.look = store.themePreset;
  });

  onMount(async () => {
    if (isMac) {
      await appWindow.setTitleBarStyle("overlay").catch((error) => {
        console.warn("Failed to enable macOS overlay titlebar", error);
      });
    } else {
      // Keep native titlebar on macOS, use custom frameless chrome elsewhere.
      await appWindow.setDecorations(false).catch((error) => {
        console.warn("Failed to disable native decorations", error);
      });
    }

    void syncWindowFocused();
    void syncWindowMaximized();

    void (async () => {
      try {
        unlistenFocusChanged = await appWindow.onFocusChanged((event) => {
          setWindowFocused(Boolean(event.payload));
        });
      } catch {
        unlistenFocusChanged = null;
      }

      try {
        unlistenResized = await appWindow.onResized(() => {
          void syncWindowMaximized();
          void captureWindowState();
        });
      } catch {
        unlistenResized = null;
      }

      try {
        unlistenMoved = await appWindow.onMoved(() => {
          void captureWindowState();
        });
      } catch {
        unlistenMoved = null;
      }
    })();

    await loadAgents();
    await loadState();
    await restoreWindowState();
    await captureWindowState();
    setupAutosave();
    startTaskStatusPolling();

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      adjustGlobalScale(e.deltaY < 0 ? 1 : -1);
    };
    mainRef.addEventListener("wheel", handleWheel, { passive: false });

    const cleanupShortcuts = initShortcuts();
    let allowClose = false;
    let handlingClose = false;
    const unlistenCloseRequested = await appWindow.onCloseRequested(async (event) => {
      await captureWindowState();
      await saveState();

      if (allowClose) return;
      if (handlingClose) {
        event.preventDefault();
        return;
      }

      const runningCount = await invoke<number>("count_running_agents").catch(() => 0);
      if (runningCount <= 0) return;

      event.preventDefault();
      handlingClose = true;
      try {
        const countLabel = runningCount === 1 ? "1 running terminal session" : `${runningCount} running terminal sessions`;
        const shouldKill = await confirm(
          `You have ${countLabel}. They can be restored on app restart. Kill them and quit, or keep them alive in the background?`,
          {
            title: "Running Terminals",
            kind: "warning",
            okLabel: "Kill & Quit",
            cancelLabel: "Keep in Background",
          }
        ).catch(() => false);

        if (shouldKill) {
          await invoke("kill_all_agents").catch(console.error);
          allowClose = true;
          await appWindow.close().catch(console.error);
          return;
        }

        await appWindow.hide().catch(console.error);
      } finally {
        handlingClose = false;
      }
    });

    // Navigation shortcuts (all global — work even in terminals)
    registerShortcut({ key: "ArrowUp", alt: true, global: true, handler: () => navigateRow("up") });
    registerShortcut({ key: "ArrowDown", alt: true, global: true, handler: () => navigateRow("down") });
    registerShortcut({ key: "ArrowLeft", alt: true, global: true, handler: () => navigateColumn("left") });
    registerShortcut({ key: "ArrowRight", alt: true, global: true, handler: () => navigateColumn("right") });

    // Task reordering
    registerShortcut({ key: "ArrowLeft", cmdOrCtrl: true, alt: true, global: true, handler: () => moveActiveTask("left") });
    registerShortcut({ key: "ArrowRight", cmdOrCtrl: true, alt: true, global: true, handler: () => moveActiveTask("right") });

    // Task actions
    registerShortcut({ key: "w", cmdOrCtrl: true, global: true, handler: () => {
      const taskId = store.activeTaskId;
      if (!taskId) return;
      const panel = store.focusedPanel[taskId] ?? "";
      if (panel.startsWith("shell:")) {
        const idx = parseInt(panel.slice(6), 10);
        const shellId = store.tasks[taskId]?.shellAgentIds[idx];
        if (shellId) closeShell(taskId, shellId);
      }
    } });
    registerShortcut({ key: "W", cmdOrCtrl: true, shift: true, global: true, handler: async () => {
      const taskId = store.activeTaskId;
      if (!taskId) return;
      const panel = store.focusedPanel[taskId] ?? "";
      if (!panel.startsWith("shell:")) return;
      const idx = parseInt(panel.slice(6), 10);
      const shellIds = store.tasks[taskId]?.shellAgentIds;
      if (!shellIds) return;
      const shellId = shellIds[idx];
      if (!shellId) return;
      await closeShell(taskId, shellId);
      // Focus next shell, or previous, or fall back to shell-toolbar
      requestAnimationFrame(() => {
        const remaining = store.tasks[taskId]?.shellAgentIds.length ?? 0;
        if (remaining === 0) {
          setTaskFocusedPanel(taskId, "shell-toolbar");
        } else {
          setTaskFocusedPanel(taskId, `shell:${Math.min(idx, remaining - 1)}`);
        }
      });
    } });
    registerShortcut({ key: "M", cmdOrCtrl: true, shift: true, global: true, handler: () => {
      const id = store.activeTaskId;
      if (id) setPendingAction({ type: "merge", taskId: id });
    } });
    registerShortcut({ key: "P", cmdOrCtrl: true, shift: true, global: true, handler: () => {
      const id = store.activeTaskId;
      if (id) setPendingAction({ type: "push", taskId: id });
    } });
    registerShortcut({ key: "T", cmdOrCtrl: true, shift: true, global: true, handler: () => {
      const id = store.activeTaskId;
      if (id) spawnShellForTask(id);
    } });
    registerShortcut({ key: "Enter", cmdOrCtrl: true, global: true, handler: () => sendActivePrompt() });

    // App shortcuts
    registerShortcut({ key: "n", cmdOrCtrl: true, global: true, handler: () => toggleNewTaskDialog(true) });
    registerShortcut({ key: "a", cmdOrCtrl: true, shift: true, global: true, handler: () => toggleNewTaskDialog(true) });
    registerShortcut({ key: "b", cmdOrCtrl: true, handler: () => toggleSidebar() });
    registerShortcut({ key: "/", cmdOrCtrl: true, global: true, handler: () => toggleHelpDialog() });
    registerShortcut({ key: ",", cmdOrCtrl: true, global: true, handler: () => toggleSettingsDialog() });
    registerShortcut({ key: "F1", global: true, handler: () => toggleHelpDialog() });
    registerShortcut({ key: "Escape", handler: () => {
      if (store.showHelpDialog) { toggleHelpDialog(false); return; }
      if (store.showSettingsDialog) { toggleSettingsDialog(false); return; }
      if (store.showNewTaskDialog) { toggleNewTaskDialog(false); return; }
    } });
    registerShortcut({ key: "0", cmdOrCtrl: true, handler: () => {
      resetFontScale(store.activeTaskId ?? "sidebar");
      resetGlobalScale();
    } });

    onCleanup(() => {
      mainRef.removeEventListener("wheel", handleWheel);
      unlistenCloseRequested();
      cleanupShortcuts();
      stopTaskStatusPolling();
      unlistenFocusChanged?.();
      unlistenResized?.();
      unlistenMoved?.();
    });
  });

  return (
    <ErrorBoundary fallback={(err, reset) => (
      <div style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        "justify-content": "center",
        gap: "16px",
        background: theme.bg,
        color: theme.fg,
        "font-family": "var(--font-ui, 'Sora', sans-serif)",
      }}>
        <div style={{ "font-size": "18px", "font-weight": "600", color: theme.error }}>
          Something went wrong
        </div>
        <div style={{ "max-width": "500px", "text-align": "center", color: theme.fgMuted, "word-break": "break-word" }}>
          {String(err)}
        </div>
        <button
          onClick={reset}
          style={{
            background: theme.bgElevated,
            border: `1px solid ${theme.border}`,
            color: theme.fg,
            padding: "8px 24px",
            "border-radius": "8px",
            cursor: "pointer",
            "font-size": "14px",
          }}
        >
          Reload
        </button>
      </div>
    )}>
      <div
        ref={mainRef}
        class="app-shell"
        data-look={store.themePreset}
        data-window-border={!isMac ? "true" : "false"}
        data-window-focused={windowFocused() ? "true" : "false"}
        data-window-maximized={windowMaximized() ? "true" : "false"}
        style={{
          width: `${100 / getGlobalScale()}vw`,
          height: `${100 / getGlobalScale()}vh`,
          transform: `scale(${getGlobalScale()})`,
          "transform-origin": "0 0",
          display: "flex",
          "flex-direction": "column",
          position: "relative",
          background: theme.bg,
          color: theme.fg,
          "font-family": "var(--font-ui, 'Sora', sans-serif)",
          "font-size": "13px",
          overflow: "hidden",
        }}
      >
        <Show when={!isMac}>
          <WindowTitleBar />
        </Show>
        <Show when={isMac}>
          <div class="mac-titlebar-spacer" data-tauri-drag-region />
        </Show>
        <main style={{ flex: "1", display: "flex", overflow: "hidden" }}>
          <Show when={store.sidebarVisible}>
            <Sidebar />
          </Show>
          <Show when={!store.sidebarVisible}>
            <button
              class="icon-btn"
              onClick={() => toggleSidebar()}
              title={`Show sidebar (${mod}+B)`}
              style={{
                width: "24px",
                "min-width": "24px",
                height: "calc(100% - 12px)",
                margin: "6px 4px 6px 0",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                cursor: "pointer",
                color: theme.fgSubtle,
                background: "transparent",
                "border-top": `2px dashed ${theme.border}`,
                "border-right": `2px dashed ${theme.border}`,
                "border-bottom": `2px dashed ${theme.border}`,
                "border-left": "none",
                "border-radius": "0 12px 12px 0",
                "user-select": "none",
                "flex-shrink": "0",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          </Show>
          <TilingLayout />
          <Show when={store.showNewTaskDialog}>
            <NewTaskDialog />
          </Show>
        </main>
        <Show when={!isMac}>
          <WindowResizeHandles />
        </Show>
        <HelpDialog open={store.showHelpDialog} onClose={() => toggleHelpDialog(false)} />
        <SettingsDialog open={store.showSettingsDialog} onClose={() => toggleSettingsDialog(false)} />
        <Show when={store.notification}>
          <div
            onClick={() => clearNotification()}
            style={{
              position: "fixed",
              bottom: "24px",
              left: "50%",
              transform: "translateX(-50%)",
              background: theme.islandBg,
              border: `1px solid ${theme.border}`,
              "border-radius": "8px",
              padding: "10px 20px",
              color: theme.fg,
              "font-size": "13px",
              "z-index": "2000",
              "box-shadow": "0 4px 24px rgba(0,0,0,0.4)",
              cursor: "pointer",
            }}
          >
            {store.notification}
          </div>
        </Show>
      </div>
    </ErrorBoundary>
  );
}

export default App;
