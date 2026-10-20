/**
 * macOS press-and-hold quit, the way Chrome and other mac apps do it.
 *
 * A single tap of Cmd+Q used to quit outright, which for this app means tearing
 * down every running terminal — far too easy to trigger next to Cmd+W and
 * Cmd+Tab. The key only counts once it has been held for `HOLD_TO_QUIT_MS`.
 *
 * Known gap: macOS does not deliver keyup for character keys while Command is
 * down, so "released q but kept Cmd held" is not observable. Dropping Cmd
 * cancels, and so does pressing any other key, but holding Cmd alone for the
 * full second still completes the hold. The close confirmation is the backstop.
 */
export const HOLD_TO_QUIT_MS = 1000;

type HoldKeyDownEvent = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'preventDefault'
>;

interface HoldToQuitOptions {
  /** Toggles the "Hold ⌘Q to Quit" hint. */
  onHoldChange: (holding: boolean) => void;
  onQuit: () => void;
}

export interface HoldToQuit {
  handleKeyDown: (e: HoldKeyDownEvent) => void;
  handleKeyUp: (e: Pick<KeyboardEvent, 'key'>) => void;
  /** Abandon an in-progress hold (window blur). */
  cancel: () => void;
}

/** Modifiers never end a hold — Command itself is half the chord. */
const MODIFIER_KEYS = new Set(['Meta', 'Shift', 'Control', 'Alt', 'CapsLock']);

// Exact match, like matchesKeyEvent: Cmd+Shift+Q and friends are other people's
// shortcuts and must not start a quit hold (or get swallowed by one).
const isQuitChord = (e: HoldKeyDownEvent): boolean =>
  e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'q';

export function createHoldToQuit({ onHoldChange, onQuit }: HoldToQuitOptions): HoldToQuit {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    onHoldChange(false);
  };

  return {
    handleKeyDown: (e) => {
      if (!isQuitChord(e)) {
        // Another key means Command is anchoring something else (Cmd+Tab,
        // Cmd+W). With no 'q' keyup coming, this is the only release signal
        // available short of dropping Command itself.
        if (!MODIFIER_KEYS.has(e.key)) cancel();
        return;
      }
      // Swallow it either way: a tap must do nothing at all.
      e.preventDefault();
      // Auto-repeat fires while the key is held — it must not restart the hold.
      if (timer !== undefined || e.repeat) return;
      timer = setTimeout(() => {
        timer = undefined;
        onHoldChange(false);
        onQuit();
      }, HOLD_TO_QUIT_MS);
      onHoldChange(true);
    },
    handleKeyUp: (e) => {
      // Releasing Cmd is the signal that always arrives; the 'q' keyup still
      // comes through when Cmd was released first.
      if (e.key.toLowerCase() === 'q' || e.key === 'Meta') cancel();
    },
    cancel,
  };
}
