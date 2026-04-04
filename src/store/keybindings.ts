import { createMemo } from 'solid-js';
import { store, setStore } from './core';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import {
  DEFAULT_BINDINGS,
  resolveBindings,
  resolveAllBindings,
  findConflict,
} from '../lib/keybindings';
import type { KeyBinding, Modifiers, KeybindingConfig } from '../lib/keybindings';

/** Get user overrides for the active preset. */
function activeOverrides(): Record<string, Record<string, unknown> | null> {
  return store.keybindingOverridesByPreset[store.keybindingPreset] ?? {};
}

/** Reactive memo: resolved bindings based on current preset + its user overrides. */
export const resolvedBindings = createMemo(() => {
  const config: KeybindingConfig = {
    preset: store.keybindingPreset,
    userOverrides: activeOverrides() as KeybindingConfig['userOverrides'],
  };
  return resolveBindings(DEFAULT_BINDINGS, config);
});

/** Reactive memo: ALL bindings including unbound ones (for the editor UI). */
export const allBindings = createMemo(() => {
  const config: KeybindingConfig = {
    preset: store.keybindingPreset,
    userOverrides: activeOverrides() as KeybindingConfig['userOverrides'],
  };
  return resolveAllBindings(DEFAULT_BINDINGS, config);
});

/** Load keybinding config from disk on app start. */
export async function loadKeybindings(): Promise<void> {
  try {
    const config = await invoke<{
      preset: string;
      overridesByPreset?: Record<string, Record<string, unknown>>;
      // Legacy format support
      userOverrides?: Record<string, unknown>;
    }>(IPC.LoadKeybindings);
    setStore('keybindingPreset', config.preset);
    if (config.overridesByPreset) {
      setStore(
        'keybindingOverridesByPreset',
        config.overridesByPreset as Record<string, Record<string, Record<string, unknown> | null>>,
      );
    } else if (config.userOverrides && Object.keys(config.userOverrides).length > 0) {
      // Migrate old flat format: assign existing overrides to the active preset
      setStore('keybindingOverridesByPreset', {
        [config.preset]: config.userOverrides as Record<string, Record<string, unknown> | null>,
      });
    }
  } catch {
    // Fall back to defaults — already set in core.ts
  }
}

/** Save current keybinding config to disk. */
async function persist(): Promise<void> {
  const config = {
    preset: store.keybindingPreset,
    overridesByPreset: store.keybindingOverridesByPreset,
  };
  await invoke(IPC.SaveKeybindings, { json: JSON.stringify(config) });
}

/** Switch to a preset. Each preset has its own user overrides. */
export function selectPreset(presetId: string): void {
  setStore('keybindingPreset', presetId);
  persist().catch(console.error);
}

/** Set a user override for a specific binding on the ACTIVE preset. */
export function setUserOverride(
  bindingId: string,
  override: Partial<Pick<KeyBinding, 'key' | 'modifiers'>> | null,
): void {
  const presetId = store.keybindingPreset;
  const current = store.keybindingOverridesByPreset[presetId] ?? {};
  setStore('keybindingOverridesByPreset', {
    ...store.keybindingOverridesByPreset,
    [presetId]: { ...current, [bindingId]: override },
  } as Record<string, Record<string, Record<string, unknown> | null>>);
  persist().catch(console.error);
}

/** Remove a user override on the active preset (revert to preset/default). */
export function clearUserOverride(bindingId: string): void {
  const presetId = store.keybindingPreset;
  const current = store.keybindingOverridesByPreset[presetId];
  if (!current) return;
  const updated = { ...current };
  delete updated[bindingId];
  setStore('keybindingOverridesByPreset', {
    ...store.keybindingOverridesByPreset,
    [presetId]: updated,
  } as Record<string, Record<string, Record<string, unknown> | null>>);
  persist().catch(console.error);
}

/** Reset all user overrides for the active preset. */
export function resetAllBindings(presetId?: string): void {
  const targetPreset = presetId ?? store.keybindingPreset;
  if (presetId) setStore('keybindingPreset', presetId);
  setStore('keybindingOverridesByPreset', {
    ...store.keybindingOverridesByPreset,
    [targetPreset]: {},
  } as Record<string, Record<string, Record<string, unknown> | null>>);
  persist().catch(console.error);
}

/** Check for conflicts within the active preset's resolved bindings. */
export function checkConflict(
  editingId: string,
  proposed: { key: string; modifiers: Modifiers },
): KeyBinding | null {
  return findConflict(resolvedBindings(), editingId, proposed);
}

export function dismissMigrationBanner(): void {
  setStore('keybindingMigrationDismissed', true);
}
