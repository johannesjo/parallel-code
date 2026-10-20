import type { KeyBinding } from './keybindings';
import type { Modifiers } from './keybindings';
import { matchesKeyEvent } from './keybindings/match';

type ShortcutHandler = (e: KeyboardEvent) => void;
type ActionHandler = (e: KeyboardEvent) => void;

interface ShortcutRegistration {
  key: string;
  modifiers: Modifiers;
  /** When true, the shortcut fires even when an input/textarea/select is focused (e.g. inside a terminal). */
  global?: boolean;
  /** When true, the shortcut fires even when a dialog overlay is open. */
  dialogSafe?: boolean;
  handler: ShortcutHandler;
}

interface RegisteredShortcut {
  binding: KeyBinding;
  handler: ShortcutHandler;
}

const shortcuts: RegisteredShortcut[] = [];

function createShortcutBinding(shortcut: ShortcutRegistration): KeyBinding {
  return {
    id: `shortcut:${shortcut.key}`,
    layer: 'app',
    category: 'App',
    description: '',
    platform: 'both',
    key: shortcut.key,
    modifiers: shortcut.modifiers,
    global: shortcut.global,
    dialogSafe: shortcut.dialogSafe,
  };
}

function matches(e: KeyboardEvent, shortcut: RegisteredShortcut): boolean {
  return matchesKeyEvent(e, shortcut.binding);
}

export function registerShortcut(shortcut: ShortcutRegistration): () => void {
  const registered: RegisteredShortcut = {
    binding: createShortcutBinding(shortcut),
    handler: shortcut.handler,
  };
  shortcuts.push(registered);
  return () => {
    const idx = shortcuts.indexOf(registered);
    if (idx >= 0) shortcuts.splice(idx, 1);
  };
}

interface ZoomShortcutHandlers {
  zoomIn: () => void;
  resetZoom: () => void;
}

export function registerZoomShortcuts(handlers: ZoomShortcutHandlers): () => void {
  const cleanups = [
    // Zoom in variants for keyboard layouts where matches() needs an exact
    // shift-state match (so each case needs its own registration). The
    // canonical Cmd+= and Cmd+- live in the keybindings registry.
    //   key '+' shift     — Ctrl+Shift+= on US/UK keyboards
    //   key '+' no shift  — Ctrl++ on European keyboards and NumPad+
    registerShortcut({
      key: '+',
      modifiers: { cmdOrCtrl: true, shift: true },
      global: true,
      dialogSafe: true,
      handler: () => handlers.zoomIn(),
    }),
    registerShortcut({
      key: '+',
      modifiers: { cmdOrCtrl: true },
      global: true,
      dialogSafe: true,
      handler: () => handlers.zoomIn(),
    }),
    // Some layouts require Shift to produce the digit 0, so Ctrl+0 would miss
    // the registry binding's exact shift-state match without this variant.
    registerShortcut({
      key: '0',
      modifiers: { cmdOrCtrl: true, shift: true },
      global: true,
      dialogSafe: true,
      handler: () => handlers.resetZoom(),
    }),
  ];

  return () => cleanups.forEach((cleanup) => cleanup());
}

/**
 * Register Shift variants of Cmd+1..9 jump-to-task shortcuts.
 *
 * The canonical bindings (Cmd+1..9 without Shift) live in the keybindings
 * registry so they appear in the Keyboard Shortcuts UI and are user-overridable.
 * The Shift variants exist only so layouts where the digit row requires Shift
 * (e.g. AZERTY) still work — keeping them out of the registry avoids 9 duplicate
 * rows in the UI, mirroring how the Cmd+0 reset-zoom shift variant is handled.
 */
export function registerJumpToTaskShortcuts(handler: (index: number) => void): () => void {
  const cleanups = Array.from({ length: 9 }, (_, i) =>
    registerShortcut({
      key: `${i + 1}`,
      modifiers: { cmdOrCtrl: true, shift: true },
      global: true,
      handler: () => handler(i),
    }),
  );
  return () => cleanups.forEach((cleanup) => cleanup());
}

/** Whether a dialog overlay is currently mounted in the DOM. */
function isDialogOpen(): boolean {
  return document.querySelector('.dialog-overlay') !== null;
}

/** Returns true if the event matches any shortcut that should bypass terminal input. */
export function matchesGlobalShortcut(e: KeyboardEvent): boolean {
  const dialogOpen = isDialogOpen();
  return shortcuts.some(
    (s) => (s.binding.global || (dialogOpen && s.binding.dialogSafe)) && matches(e, s),
  );
}

export function initShortcuts(): () => void {
  const handler = (e: KeyboardEvent) => {
    // Don't intercept when typing in input/textarea — unless the shortcut is global
    const tag = (e.composedPath()[0] as HTMLElement)?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    // A menu or popover that already took this Escape marks it handled (the
    // same convention Dialog.tsx honours); one press should not also close
    // dialogs or leave focus mode behind it.
    if (e.key === 'Escape' && e.defaultPrevented) return;

    // Suppress non-dialog-safe shortcuts when a dialog overlay is open
    const dialogOpen = isDialogOpen();

    for (const s of shortcuts) {
      if (
        matches(e, s) &&
        (!inInput || s.binding.global) &&
        (!dialogOpen || s.binding.dialogSafe)
      ) {
        e.preventDefault();
        e.stopPropagation();
        s.handler(e);
        return;
      }
    }
  };

  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}

export function registerFromRegistry(
  bindings: KeyBinding[],
  handlers: Record<string, ActionHandler>,
): () => void {
  const cleanups: (() => void)[] = [];

  for (const binding of bindings) {
    if (binding.layer !== 'app') continue;
    if (!binding.action) continue;

    const handler = handlers[binding.action];
    if (!handler) continue;

    const opts: ShortcutRegistration = {
      key: binding.key,
      modifiers: binding.modifiers,
      global: binding.global,
      dialogSafe: binding.dialogSafe,
      handler,
    };

    cleanups.push(registerShortcut(opts));
  }

  return () => cleanups.forEach((fn) => fn());
}
