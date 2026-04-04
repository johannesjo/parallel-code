import type { KeyBinding, KeybindingConfig, Modifiers } from './types';
import { getPreset } from './presets';

// Safe platform detection — navigator may not exist in test/SSR environments
const isMac: boolean =
  typeof navigator !== 'undefined' ? navigator.userAgent.includes('Mac') : false;

function platformMatches(binding: KeyBinding): boolean {
  if (binding.platform === 'both') return true;
  if (binding.platform === 'mac') return isMac;
  if (binding.platform === 'linux') return !isMac;
  return true;
}

/**
 * Semantically compare two modifier sets, accounting for platform equivalence.
 * On macOS: cmdOrCtrl and meta both mean "Cmd key" — they're equivalent.
 * On Linux: cmdOrCtrl and ctrl both mean "Ctrl key" — they're equivalent.
 */
function modifiersMatch(a: Modifiers, b: Modifiers): boolean {
  // Normalize: resolve cmdOrCtrl into the platform-specific modifier
  const aCmd = isMac
    ? (a.cmdOrCtrl ?? false) || (a.meta ?? false)
    : (a.cmdOrCtrl ?? false) || (a.ctrl ?? false);
  const bCmd = isMac
    ? (b.cmdOrCtrl ?? false) || (b.meta ?? false)
    : (b.cmdOrCtrl ?? false) || (b.ctrl ?? false);

  // On macOS, raw ctrl (without cmdOrCtrl) is a separate modifier
  const aCtrl = isMac ? (a.ctrl ?? false) && !(a.cmdOrCtrl ?? false) : false;
  const bCtrl = isMac ? (b.ctrl ?? false) && !(b.cmdOrCtrl ?? false) : false;

  return (
    aCmd === bCmd &&
    aCtrl === bCtrl &&
    (a.alt ?? false) === (b.alt ?? false) &&
    (a.shift ?? false) === (b.shift ?? false)
  );
}

/**
 * Resolves the full list of active keybindings by applying preset overrides
 * and user overrides on top of the provided defaults, filtered by platform.
 *
 * Priority (highest to lowest): userOverrides > preset overrides > defaults
 * A null override removes (unbinds) the binding.
 */
export function resolveBindings(defaults: KeyBinding[], config: KeybindingConfig): KeyBinding[] {
  const preset = getPreset(config.preset);
  const resolved: KeyBinding[] = [];

  for (const binding of defaults) {
    // Filter by current platform
    if (!platformMatches(binding)) continue;

    const userOverride = Object.prototype.hasOwnProperty.call(config.userOverrides, binding.id)
      ? config.userOverrides[binding.id]
      : undefined;

    const presetOverride = Object.prototype.hasOwnProperty.call(preset.overrides, binding.id)
      ? preset.overrides[binding.id]
      : undefined;

    // User override of null always unbinds
    if (userOverride === null) continue;

    // Preset override of null unbinds unless the user has a non-null override
    if (presetOverride === null && userOverride === undefined) continue;

    // Apply overrides: user > preset > default
    const key = userOverride?.key ?? presetOverride?.key ?? binding.key;
    const modifiers: Modifiers =
      userOverride?.modifiers ?? presetOverride?.modifiers ?? binding.modifiers;

    resolved.push({ ...binding, key, modifiers });
  }

  return resolved;
}

/**
 * Like resolveBindings, but includes ALL platform-filtered bindings — even those
 * unbound by a preset or user override. Unbound bindings have `unbound: true`.
 * Used by the keybinding editor to show the full picture.
 */
export function resolveAllBindings(defaults: KeyBinding[], config: KeybindingConfig): KeyBinding[] {
  const preset = getPreset(config.preset);
  const result: KeyBinding[] = [];

  for (const binding of defaults) {
    if (!platformMatches(binding)) continue;

    const userOverride = Object.prototype.hasOwnProperty.call(config.userOverrides, binding.id)
      ? config.userOverrides[binding.id]
      : undefined;

    const presetOverride = Object.prototype.hasOwnProperty.call(preset.overrides, binding.id)
      ? preset.overrides[binding.id]
      : undefined;

    // Check if unbound
    const isUnbound =
      userOverride === null || (presetOverride === null && userOverride === undefined);

    if (isUnbound) {
      result.push({ ...binding, unbound: true });
      continue;
    }

    // Apply overrides: user > preset > default
    const key = userOverride?.key ?? presetOverride?.key ?? binding.key;
    const modifiers: Modifiers =
      userOverride?.modifiers ?? presetOverride?.modifiers ?? binding.modifiers;

    result.push({ ...binding, key, modifiers });
  }

  return result;
}

/**
 * Checks for a keybinding conflict when assigning a proposed key+modifiers
 * to the binding identified by `editingId`.
 *
 * Returns the conflicting binding, or null if no conflict exists.
 * The binding being edited is excluded from the check (no self-conflict).
 */
export function findConflict(
  resolved: KeyBinding[],
  editingId: string,
  proposed: Pick<KeyBinding, 'key' | 'modifiers'>,
): KeyBinding | null {
  for (const binding of resolved) {
    if (binding.id === editingId) continue;
    if (
      binding.key.toLowerCase() === proposed.key.toLowerCase() &&
      modifiersMatch(binding.modifiers, proposed.modifiers)
    ) {
      return binding;
    }
  }
  return null;
}
