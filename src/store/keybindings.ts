import { createMemo } from 'solid-js';
import { produce } from 'solid-js/store';
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

/** Reactive memo: resolved bindings based on current preset + user overrides. */
export const resolvedBindings = createMemo(() => {
  const config: KeybindingConfig = {
    preset: store.keybindingPreset,
    userOverrides: store.keybindingUserOverrides as KeybindingConfig['userOverrides'],
  };
  return resolveBindings(DEFAULT_BINDINGS, config);
});

/** Reactive memo: ALL bindings including unbound ones (for the editor UI). */
export const allBindings = createMemo(() => {
  const config: KeybindingConfig = {
    preset: store.keybindingPreset,
    userOverrides: store.keybindingUserOverrides as KeybindingConfig['userOverrides'],
  };
  return resolveAllBindings(DEFAULT_BINDINGS, config);
});

/** Load keybinding config from disk on app start. */
export async function loadKeybindings(): Promise<void> {
  try {
    const config = await invoke<{ preset: string; userOverrides: Record<string, unknown> }>(
      IPC.LoadKeybindings,
    );
    setStore('keybindingPreset', config.preset);
    setStore(
      'keybindingUserOverrides',
      config.userOverrides as Record<string, Record<string, unknown> | null>,
    );
  } catch {
    // Fall back to defaults — already set in core.ts
  }
}

/** Save current keybinding config to disk. */
async function persist(): Promise<void> {
  const config = {
    preset: store.keybindingPreset,
    userOverrides: store.keybindingUserOverrides,
  };
  await invoke(IPC.SaveKeybindings, { json: JSON.stringify(config) });
}

/** Switch to a preset. Keeps existing user overrides. */
export function selectPreset(presetId: string): void {
  setStore('keybindingPreset', presetId);
  persist().catch(console.error);
}

/** Set a user override for a specific binding. Pass null to unbind. */
export function setUserOverride(
  bindingId: string,
  override: Partial<Pick<KeyBinding, 'key' | 'modifiers'>> | null,
): void {
  setStore(
    produce((s) => {
      (s.keybindingUserOverrides as Record<string, unknown>)[bindingId] = override;
    }),
  );
  persist().catch(console.error);
}

/** Remove a user override (revert to preset/default). */
export function clearUserOverride(bindingId: string): void {
  setStore(
    produce((s) => {
      delete (s.keybindingUserOverrides as Record<string, unknown>)[bindingId];
    }),
  );
  persist().catch(console.error);
}

/** Reset all user overrides and optionally switch preset. */
export function resetAllBindings(presetId?: string): void {
  setStore('keybindingUserOverrides', {});
  if (presetId) setStore('keybindingPreset', presetId);
  persist().catch(console.error);
}

/** Check for conflicts. */
export function checkConflict(
  editingId: string,
  proposed: { key: string; modifiers: Modifiers },
): KeyBinding | null {
  return findConflict(resolvedBindings(), editingId, proposed);
}

export function dismissMigrationBanner(): void {
  setStore('keybindingMigrationDismissed', true);
}
