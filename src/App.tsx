import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { onMount, onCleanup, Show, ErrorBoundary } from "solid-js";
import { Sidebar } from "./components/Sidebar";
import { TilingLayout } from "./components/TilingLayout";
import { NewTaskDialog } from "./components/NewTaskDialog";
import { HelpDialog } from "./components/HelpDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { theme } from "./lib/theme";
import {
  store,
  loadAgents,
  loadState,
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
} from "./store/store";
import { registerShortcut, initShortcuts } from "./lib/shortcuts";
import { setupAutosave } from "./store/autosave";
import { mod } from "./lib/platform";

function App() {
  let mainRef!: HTMLElement;

  onMount(async () => {
    await loadAgents();
    await loadState();
    setupAutosave();
    startTaskStatusPolling();

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      adjustGlobalScale(e.deltaY < 0 ? 1 : -1);
    };
    mainRef.addEventListener("wheel", handleWheel, { passive: false });

    const cleanupShortcuts = initShortcuts();

    // Navigation shortcuts (all global — work even in terminals)
    registerShortcut({ key: "ArrowUp", alt: true, global: true, handler: () => navigateRow("up") });
    registerShortcut({ key: "ArrowDown", alt: true, global: true, handler: () => navigateRow("down") });
    registerShortcut({ key: "ArrowLeft", alt: true, global: true, handler: () => navigateColumn("left") });
    registerShortcut({ key: "ArrowRight", alt: true, global: true, handler: () => navigateColumn("right") });

    // Task reordering
    registerShortcut({ key: "ArrowLeft", ctrl: true, alt: true, global: true, handler: () => moveActiveTask("left") });
    registerShortcut({ key: "ArrowRight", ctrl: true, alt: true, global: true, handler: () => moveActiveTask("right") });

    // Task actions
    registerShortcut({ key: "w", ctrl: true, global: true, handler: () => {
      const taskId = store.activeTaskId;
      if (!taskId) return;
      const panel = store.focusedPanel[taskId] ?? "";
      if (panel.startsWith("shell:")) {
        const idx = parseInt(panel.slice(6), 10);
        const shellId = store.tasks[taskId]?.shellAgentIds[idx];
        if (shellId) closeShell(taskId, shellId);
      }
    } });
    registerShortcut({ key: "W", ctrl: true, shift: true, global: true, handler: async () => {
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
    registerShortcut({ key: "M", ctrl: true, shift: true, global: true, handler: () => {
      const id = store.activeTaskId;
      if (id) setPendingAction({ type: "merge", taskId: id });
    } });
    registerShortcut({ key: "P", ctrl: true, shift: true, global: true, handler: () => {
      const id = store.activeTaskId;
      if (id) setPendingAction({ type: "push", taskId: id });
    } });
    registerShortcut({ key: "T", ctrl: true, shift: true, global: true, handler: () => {
      const id = store.activeTaskId;
      if (id) spawnShellForTask(id);
    } });
    registerShortcut({ key: "Enter", ctrl: true, global: true, handler: () => sendActivePrompt() });

    // App shortcuts
    registerShortcut({ key: "n", ctrl: true, global: true, handler: () => toggleNewTaskDialog(true) });
    registerShortcut({ key: "a", cmdOrCtrl: true, shift: true, global: true, handler: () => toggleNewTaskDialog(true) });
    registerShortcut({ key: "b", ctrl: true, handler: () => toggleSidebar() });
    registerShortcut({ key: "/", ctrl: true, global: true, handler: () => toggleHelpDialog() });
    registerShortcut({ key: ",", cmdOrCtrl: true, global: true, handler: () => toggleSettingsDialog() });
    registerShortcut({ key: "F1", global: true, handler: () => toggleHelpDialog() });
    registerShortcut({ key: "Escape", handler: () => {
      if (store.showHelpDialog) { toggleHelpDialog(false); return; }
      if (store.showSettingsDialog) { toggleSettingsDialog(false); return; }
      if (store.showNewTaskDialog) { toggleNewTaskDialog(false); return; }
    } });
    registerShortcut({ key: "0", ctrl: true, handler: () => {
      resetFontScale(store.activeTaskId ?? "sidebar");
      resetGlobalScale();
    } });

    onCleanup(() => {
      mainRef.removeEventListener("wheel", handleWheel);
      cleanupShortcuts();
      stopTaskStatusPolling();
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
      <main
        ref={mainRef}
        class="app-shell"
        data-look={store.themePreset}
        style={{
          width: `${100 / getGlobalScale()}vw`,
          height: `${100 / getGlobalScale()}vh`,
          transform: `scale(${getGlobalScale()})`,
          "transform-origin": "0 0",
          display: "flex",
          background: theme.bg,
          color: theme.fg,
          "font-family": "var(--font-ui, 'Sora', sans-serif)",
          "font-size": "13px",
          overflow: "hidden",
        }}
      >
        <Show when={store.sidebarVisible}>
          <Sidebar />
        </Show>
        <Show when={!store.sidebarVisible}>
          <div
            onClick={() => toggleSidebar()}
            title={`Show sidebar (${mod}+B)`}
            style={{
              width: "24px",
              "min-width": "24px",
              height: "100%",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              cursor: "pointer",
              color: theme.fgSubtle,
              background: theme.islandBg,
              "border-right": `1px solid ${theme.border}`,
              "margin-right": "4px",
              transition: "color 0.15s",
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = theme.fgMuted}
            onMouseLeave={(e) => e.currentTarget.style.color = theme.fgSubtle}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
            </svg>
          </div>
        </Show>
        <TilingLayout />
        <Show when={store.showNewTaskDialog}>
          <NewTaskDialog />
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
      </main>
    </ErrorBoundary>
  );
}

export default App;
