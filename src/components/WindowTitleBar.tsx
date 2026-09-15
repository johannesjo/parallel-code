import { createSignal, onCleanup, onMount } from 'solid-js';
import { appWindow } from '../lib/window';
import { FocusModeTaskIndicators } from './FocusModeTaskIndicators';
import { CloseThinIcon, LogoIcon, MaximizeIcon, MinimizeIcon, RestoreIcon } from './icons';

export function WindowTitleBar() {
  const [isFocused, setIsFocused] = createSignal(true);
  const [isMaximized, setIsMaximized] = createSignal(false);

  let unlistenResize: (() => void) | null = null;
  let unlistenFocus: (() => void) | null = null;

  const syncMaximizedState = async () => {
    const maximized = await appWindow.isMaximized().catch((error) => {
      console.warn('Failed to query maximize state', error);
      return false;
    });
    setIsMaximized(maximized);
  };

  let maximizeDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedSyncMaximized = () => {
    if (maximizeDebounceTimer !== undefined) clearTimeout(maximizeDebounceTimer);
    maximizeDebounceTimer = setTimeout(() => {
      maximizeDebounceTimer = undefined;
      void syncMaximizedState();
    }, 150);
  };

  onMount(() => {
    void syncMaximizedState();
    void appWindow
      .isFocused()
      .then(setIsFocused)
      .catch((error) => {
        console.warn('Failed to query focus state', error);
      });

    let cleaned = false;

    void (async () => {
      try {
        unlistenResize = await appWindow.onResized(() => {
          debouncedSyncMaximized();
        });
        if (cleaned) {
          unlistenResize();
          unlistenResize = null;
        }
      } catch {
        unlistenResize = null;
      }

      try {
        unlistenFocus = await appWindow.onFocusChanged((event) => {
          setIsFocused(Boolean(event.payload));
        });
        if (cleaned) {
          unlistenFocus();
          unlistenFocus = null;
        }
      } catch {
        unlistenFocus = null;
      }
    })();

    onCleanup(() => {
      cleaned = true;
      if (maximizeDebounceTimer !== undefined) clearTimeout(maximizeDebounceTimer);
      unlistenResize?.();
      unlistenFocus?.();
    });
  });

  const handleToggleMaximize = async () => {
    await appWindow.toggleMaximize().catch((error) => {
      console.warn('Failed to toggle maximize', error);
    });
    void syncMaximizedState();
  };

  return (
    <div class={`window-titlebar${isFocused() ? '' : ' unfocused'}`}>
      <div
        data-tauri-drag-region
        class="window-drag-region"
        onDblClick={() => void handleToggleMaximize()}
      >
        <LogoIcon
          size={14}
          class="window-title-icon"
          style={{
            color: '#ffffff',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
          }}
        />
      </div>
      <FocusModeTaskIndicators />
      <div class="window-controls">
        <button
          class="window-control-btn"
          onClick={() => {
            void appWindow.minimize().catch((error) => {
              console.warn('Failed to minimize window', error);
            });
          }}
          aria-label="Minimize window"
          title="Minimize"
        >
          <MinimizeIcon size={10} />
        </button>
        <button
          class="window-control-btn"
          onClick={() => void handleToggleMaximize()}
          aria-label={isMaximized() ? 'Restore window' : 'Maximize window'}
          title={isMaximized() ? 'Restore' : 'Maximize'}
        >
          {isMaximized() ? <RestoreIcon size={10} /> : <MaximizeIcon size={10} />}
        </button>
        <button
          class="window-control-btn close"
          onClick={() => {
            void appWindow.close().catch((error) => {
              console.warn('Failed to close window', error);
            });
          }}
          aria-label="Close window"
          title="Close"
        >
          <CloseThinIcon size={10} />
        </button>
      </div>
    </div>
  );
}
