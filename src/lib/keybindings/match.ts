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

  // Normalize modifier expectations so matching is exact on every platform.
  // cmdOrCtrl contributes Cmd on macOS and Ctrl elsewhere. Explicit meta/ctrl
  // flags remain additive so bindings that intentionally require both still work.
  const expectedMeta = !!m.meta || (isMac && !!m.cmdOrCtrl);
  const expectedCtrl = !!m.ctrl || (!isMac && !!m.cmdOrCtrl);

  if (e.metaKey !== expectedMeta) return false;
  if (e.ctrlKey !== expectedCtrl) return false;
  if (!!m.alt !== e.altKey) return false;
  if (!!m.shift !== e.shiftKey) return false;
  return true;
}
