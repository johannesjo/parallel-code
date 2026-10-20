import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { createHoldToQuit, HOLD_TO_QUIT_MS } from '../lib/hold-to-quit';
import { appWindow } from '../lib/window';

/**
 * macOS-only "Hold ⌘Q to Quit" hint, and the key handling behind it.
 *
 * Quitting goes through `appWindow.close()`: closing the last window is what
 * quits the app, and the close path is where the "kill / keep alive in the
 * background / cancel" prompt lives, so nothing is torn down unconfirmed.
 */
export function HoldToQuit() {
  const [holding, setHolding] = createSignal(false);

  onMount(() => {
    const holdToQuit = createHoldToQuit({
      onHoldChange: setHolding,
      onQuit: () => void appWindow.close().catch(console.error),
    });
    const listeners = new AbortController();
    const { signal } = listeners;
    window.addEventListener('keydown', holdToQuit.handleKeyDown, { signal });
    window.addEventListener('keyup', holdToQuit.handleKeyUp, { signal });
    window.addEventListener('blur', holdToQuit.cancel, { signal });
    onCleanup(() => {
      listeners.abort();
      holdToQuit.cancel();
    });
  });

  return (
    <Show when={holding()}>
      <div
        class="hold-to-quit"
        role="status"
        style={{ '--hold-to-quit-ms': `${HOLD_TO_QUIT_MS}ms` }}
      >
        <span>
          Hold <kbd>⌘Q</kbd> to Quit
        </span>
        <span class="hold-to-quit-track" aria-hidden="true">
          <span class="hold-to-quit-fill" />
        </span>
      </div>
    </Show>
  );
}
