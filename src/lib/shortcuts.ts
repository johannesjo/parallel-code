import type { KeyBinding } from './keybindings';

type ShortcutHandler = (e: KeyboardEvent) => void;
type ActionHandler = (e: KeyboardEvent) => void;

interface Shortcut {
  key: string;
  ctrl?: boolean;
  cmdOrCtrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** When true, the shortcut fires even when an input/textarea/select is focused (e.g. inside a terminal). */
  global?: boolean;
  /** When true, the shortcut fires even when a dialog overlay is open. */
  dialogSafe?: boolean;
  handler: ShortcutHandler;
}

const shortcuts: Shortcut[] = [];

function matches(e: KeyboardEvent, s: Shortcut): boolean {
  const ctrlMatch = s.cmdOrCtrl ? e.ctrlKey || e.metaKey : !!e.ctrlKey === !!s.ctrl;
  // For non-cmdOrCtrl shortcuts, require metaKey to not be pressed
  const metaMatch = s.cmdOrCtrl || !e.metaKey;

  return (
    e.key.toLowerCase() === s.key.toLowerCase() &&
    ctrlMatch &&
    metaMatch &&
    !!e.altKey === !!s.alt &&
    !!e.shiftKey === !!s.shift
  );
}

export function registerShortcut(shortcut: Shortcut): () => void {
  shortcuts.push(shortcut);
  return () => {
    const idx = shortcuts.indexOf(shortcut);
    if (idx >= 0) shortcuts.splice(idx, 1);
  };
}

/** Returns true if the event matches any shortcut with `global: true`. */
export function matchesGlobalShortcut(e: KeyboardEvent): boolean {
  return shortcuts.some((s) => s.global && matches(e, s));
}

export function initShortcuts(): () => void {
  const handler = (e: KeyboardEvent) => {
    // Don't intercept when typing in input/textarea — unless the shortcut is global
    const tag = (e.target as HTMLElement)?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    // Suppress non-dialog-safe shortcuts when a dialog overlay is open
    const dialogOpen = document.querySelector('.dialog-overlay') !== null;

    for (const s of shortcuts) {
      if (matches(e, s) && (!inInput || s.global) && (!dialogOpen || s.dialogSafe)) {
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

    const opts: Shortcut = {
      key: binding.key,
      global: binding.global,
      dialogSafe: binding.dialogSafe,
      handler,
    };

    if (binding.modifiers.cmdOrCtrl) {
      opts.cmdOrCtrl = true;
    }
    if (binding.modifiers.ctrl) {
      opts.ctrl = true;
    }
    if (binding.modifiers.alt) {
      opts.alt = true;
    }
    if (binding.modifiers.shift) {
      opts.shift = true;
    }

    cleanups.push(registerShortcut(opts));
  }

  return () => cleanups.forEach((fn) => fn());
}
