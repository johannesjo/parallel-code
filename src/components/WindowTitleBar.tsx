import { createSignal, onCleanup, onMount } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";

const appWindow = getCurrentWindow();

export function WindowTitleBar() {
  const [isFocused, setIsFocused] = createSignal(true);
  const [isMaximized, setIsMaximized] = createSignal(false);

  let unlistenResize: (() => void) | null = null;
  let unlistenFocus: (() => void) | null = null;

  const syncMaximizedState = async () => {
    const maximized = await appWindow.isMaximized().catch((error) => {
      console.warn("Failed to query maximize state", error);
      return false;
    });
    setIsMaximized(maximized);
  };

  onMount(() => {
    void syncMaximizedState();
    void appWindow.isFocused().then(setIsFocused).catch((error) => {
      console.warn("Failed to query focus state", error);
    });

    void (async () => {
      try {
        unlistenResize = await appWindow.onResized(() => {
          void syncMaximizedState();
        });
      } catch {
        unlistenResize = null;
      }

      try {
        unlistenFocus = await appWindow.onFocusChanged((event) => {
          setIsFocused(Boolean(event.payload));
        });
      } catch {
        unlistenFocus = null;
      }
    })();
  });

  onCleanup(() => {
    unlistenResize?.();
    unlistenFocus?.();
  });

  const handleToggleMaximize = async () => {
    await appWindow.toggleMaximize().catch((error) => {
      console.warn("Failed to toggle maximize", error);
    });
    void syncMaximizedState();
  };

  const handleDragStart = (event: MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void appWindow.startDragging().catch((error) => {
      console.warn("Failed to start dragging window", error);
    });
  };

  return (
    <div class={`window-titlebar${isFocused() ? "" : " unfocused"}`}>
      <div
        data-tauri-drag-region
        class="window-drag-region"
        onMouseDown={handleDragStart}
        onDblClick={() => void handleToggleMaximize()}
      >
        <svg
          class="window-title-icon"
          viewBox="0 0 56 56"
          fill="none"
          stroke="#ffffff"
          stroke-width="4"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <line x1="10" y1="6" x2="10" y2="50" />
          <line x1="22" y1="6" x2="22" y2="50" />
          <path d="M30 8 H47 V24 H30" />
          <path d="M49 32 H32 V48 H49" />
        </svg>
      </div>
      <div class="window-controls">
        <button
          class="window-control-btn"
          onClick={() => {
            void appWindow.minimize().catch((error) => {
              console.warn("Failed to minimize window", error);
            });
          }}
          aria-label="Minimize window"
          title="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M1 5h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </button>
        <button
          class="window-control-btn"
          onClick={() => void handleToggleMaximize()}
          aria-label={isMaximized() ? "Restore window" : "Maximize window"}
          title={isMaximized() ? "Restore" : "Maximize"}
        >
          {isMaximized() ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M2 1.5h6v6H2z" stroke="currentColor" stroke-width="1.1" />
              <path d="M1 3.5v5h5" stroke="currentColor" stroke-width="1.1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" stroke-width="1.1" />
            </svg>
          )}
        </button>
        <button
          class="window-control-btn close"
          onClick={() => {
            void appWindow.close().catch((error) => {
              console.warn("Failed to close window", error);
            });
          }}
          aria-label="Close window"
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2 2l6 6M8 2 2 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
