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
  getGlobalScale,
  adjustGlobalScale,
  resetGlobalScale,
  startTaskStatusPolling,
  stopTaskStatusPolling,
} from "./store/store";
import { registerShortcut, initShortcuts } from "./lib/shortcuts";
import { setupAutosave } from "./store/autosave";

function App() {
  let mainRef!: HTMLElement;

  onMount(async () => {
    await loadAgents();
    await loadState();
    setupAutosave();
    startTaskStatusPolling();

    mainRef.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      adjustGlobalScale(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });

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
      resetGlobalScale();
    } });

    onCleanup(() => {
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
        ref={mainRef}
        style={{
          width: `${100 / getGlobalScale()}vw`,
          height: `${100 / getGlobalScale()}vh`,
          transform: `scale(${getGlobalScale()})`,
          "transform-origin": "0 0",
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
          <div
            onClick={() => toggleSidebar()}
            title="Show sidebar (Ctrl+B)"
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
      </main>
    </ErrorBoundary>
  );
}

export default App;
