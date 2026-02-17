import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { onMount, onCleanup, Show, ErrorBoundary } from "solid-js";
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
  resetFontScale,
} from "./store/store";
import { registerShortcut, initShortcuts } from "./lib/shortcuts";
import { setupAutosave } from "./store/autosave";

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

    onCleanup(cleanupShortcuts);
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
        "font-family": "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
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
    </ErrorBoundary>
  );
}

export default App;
