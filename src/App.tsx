import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { onMount, onCleanup, Show } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { TilingLayout } from "./components/TilingLayout";
import { NewTaskDialog } from "./components/NewTaskDialog";
import { theme } from "./lib/theme";
import {
  store,
  loadAgents,
  loadState,
  toggleNewTaskDialog,
  toggleSidebar,
  navigateTask,
  navigateAgent,
  moveActiveTask,
  setPendingPlan,
  isPlanDismissed,
  startGlobalPlanWatcher,
  resetFontScale,
} from "./store/store";
import { registerShortcut, initShortcuts } from "./lib/shortcuts";
import { setupAutosave } from "./store/autosave";
import type { PlanEvent } from "./ipc/types";

function App() {
  onMount(async () => {
    await loadAgents();
    await loadState();
    setupAutosave();

    const cleanupShortcuts = initShortcuts();

    registerShortcut({ key: "n", ctrl: true, handler: () => toggleNewTaskDialog(true) });
    registerShortcut({ key: "b", ctrl: true, handler: () => toggleSidebar() });
    registerShortcut({ key: "ArrowLeft", alt: true, handler: () => navigateTask("left") });
    registerShortcut({ key: "ArrowRight", alt: true, handler: () => navigateTask("right") });
    registerShortcut({ key: "ArrowUp", alt: true, handler: () => navigateAgent("up") });
    registerShortcut({ key: "ArrowDown", alt: true, handler: () => navigateAgent("down") });
    registerShortcut({ key: "ArrowUp", ctrl: true, alt: true, handler: () => moveActiveTask("up") });
    registerShortcut({ key: "ArrowDown", ctrl: true, alt: true, handler: () => moveActiveTask("down") });
    registerShortcut({ key: "Escape", handler: () => { if (store.showNewTaskDialog) toggleNewTaskDialog(false); } });
    registerShortcut({ key: "0", ctrl: true, handler: () => {
      resetFontScale(store.activeTaskId ?? "sidebar");
    } });

    // Watch ~/.claude/plans/ for new plan files and route to active task
    console.log("[plan-watcher] Starting global plan watcher...");
    await startGlobalPlanWatcher();
    console.log("[plan-watcher] Watcher started, listening for events...");
    const unlistenPlan = await listen<PlanEvent>("plan-detected", async (event) => {
      console.log("[plan-watcher] Event received:", event.payload);
      const { file_path, file_name } = event.payload;
      const taskId = store.activeTaskId;
      if (!taskId || !store.tasks[taskId]) {
        console.log("[plan-watcher] No active task, ignoring");
        return;
      }
      if (store.tasks[taskId].pendingPlan) {
        console.log("[plan-watcher] Task already has pending plan, ignoring");
        return;
      }
      if (isPlanDismissed(file_path)) {
        console.log("[plan-watcher] Plan was dismissed, ignoring");
        return;
      }
      try {
        const content = await invoke<string>("read_plan_file", { path: file_path });
        console.log("[plan-watcher] Setting pending plan for task", taskId);
        setPendingPlan(taskId, file_path, file_name, content);
      } catch (e) {
        console.warn("Failed to read plan file:", e);
      }
    });

    onCleanup(() => {
      cleanupShortcuts();
      unlistenPlan();
    });
  });

  return (
    <main
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        background: theme.bg,
        color: theme.fg,
        "font-family": "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        "font-size": "13px",
        overflow: "hidden",
      }}
    >
      <Show when={store.sidebarVisible}>
        <Sidebar />
      </Show>
      <Show when={!store.sidebarVisible}>
        <button
          class="icon-btn"
          onClick={() => toggleSidebar()}
          title="Show sidebar (Ctrl+B)"
          style={{
            position: "absolute",
            top: "8px",
            left: "8px",
            "z-index": "20",
            background: theme.islandBg,
            border: `1px solid ${theme.border}`,
            color: theme.fgMuted,
            cursor: "pointer",
            "border-radius": "6px",
            padding: "4px 8px",
            "font-size": "12px",
          }}
        >
          &gt;
        </button>
      </Show>
      <TilingLayout />
      <Show when={store.showNewTaskDialog}>
        <NewTaskDialog />
      </Show>
    </main>
  );
}

export default App;
