import type { KeyBinding } from './types';

// Safe platform detection — navigator may not exist in test/SSR environments
const isMac: boolean =
  typeof navigator !== 'undefined' ? navigator.userAgent.includes('Mac') : false;

/**
 * Check whether a KeyboardEvent matches a KeyBinding's key + modifiers.
 * Handles cmdOrCtrl → Cmd on macOS / Ctrl on Linux, and raw meta/ctrl.
 * Shared by both app-layer (shortcuts.ts) and terminal-layer (TerminalView).
 */
export function matchesKeyEvent(e: KeyboardEvent, binding: KeyBinding): boolean {
  if (e.key.toLowerCase() !== binding.key.toLowerCase()) return false;
  const m = binding.modifiers;

  // cmdOrCtrl: Cmd on mac, Ctrl on linux
  if (m.cmdOrCtrl) {
    if (!(isMac ? e.metaKey : e.ctrlKey)) return false;
  } else {
    // Direct meta (rare — mac-only terminal bindings like Cmd+Left)
    if (m.meta && !e.metaKey) return false;
    if (!m.meta && e.metaKey) return false;
    // Direct ctrl (rare — linux-only terminal bindings)
    if (m.ctrl && !e.ctrlKey) return false;
    if (!m.ctrl && !m.cmdOrCtrl && e.ctrlKey) return false;
  }

  if (!!m.alt !== e.altKey) return false;
  if (!!m.shift !== e.shiftKey) return false;
  return true;
}
