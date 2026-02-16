import "@xterm/xterm/css/xterm.css";
import { onMount, onCleanup, Show } from "solid-js";
import { Sidebar } from "./components/Sidebar";
import { TilingLayout } from "./components/TilingLayout";
import { NewTaskDialog } from "./components/NewTaskDialog";
import { theme } from "./lib/theme";
import {
  store,
  loadAgents,
  toggleNewTaskDialog,
  navigateTask,
  navigateAgent,
} from "./store/store";
import { registerShortcut, initShortcuts } from "./lib/shortcuts";

function App() {
  onMount(async () => {
    await loadAgents();

    const cleanupShortcuts = initShortcuts();

    registerShortcut({
      key: "n",
      ctrl: true,
      handler: () => toggleNewTaskDialog(true),
    });

    registerShortcut({
      key: "ArrowLeft",
      alt: true,
      handler: () => navigateTask("left"),
    });

    registerShortcut({
      key: "ArrowRight",
      alt: true,
      handler: () => navigateTask("right"),
    });

    registerShortcut({
      key: "ArrowUp",
      alt: true,
      handler: () => navigateAgent("up"),
    });

    registerShortcut({
      key: "ArrowDown",
      alt: true,
      handler: () => navigateAgent("down"),
    });

    registerShortcut({
      key: "Escape",
      handler: () => {
        if (store.showNewTaskDialog) toggleNewTaskDialog(false);
      },
    });

    onCleanup(cleanupShortcuts);
  });

  return (
    <main
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        background: theme.bg,
        color: theme.fg,
        "font-family":
          "'JetBrains Sans', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        overflow: "hidden",
      }}
    >
      <Sidebar />
      <TilingLayout />
      <Show when={store.showNewTaskDialog}>
        <NewTaskDialog />
      </Show>
    </main>
  );
}

export default App;
