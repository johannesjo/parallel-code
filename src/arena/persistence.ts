import { unwrap } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { loadPresets, loadHistory, arenaStore } from './store';
import type { ArenaPreset, ArenaMatch } from './types';

export async function loadArenaPresets(): Promise<void> {
  const json = await invoke<string | null>(IPC.LoadArenaData, {
    filename: 'arena-presets.json',
  }).catch(() => null);
  if (!json) return;
  try {
    const presets = JSON.parse(json) as ArenaPreset[];
    if (Array.isArray(presets)) loadPresets(presets);
  } catch {
    console.warn('Failed to parse arena presets');
  }
}

export async function saveArenaPresets(): Promise<void> {
  await invoke(IPC.SaveArenaData, {
    filename: 'arena-presets.json',
    json: JSON.stringify(unwrap(arenaStore.presets)),
  }).catch((e) => console.warn('Failed to save arena presets:', e));
}

export async function loadArenaHistory(): Promise<void> {
  const json = await invoke<string | null>(IPC.LoadArenaData, {
    filename: 'arena-history.json',
  }).catch(() => null);
  if (!json) return;
  try {
    const raw = JSON.parse(json) as ArenaMatch[];
    if (Array.isArray(raw)) {
      // Normalize old entries that lack new fields
      const history = raw.map((m) => ({
        ...m,
        cwd: m.cwd ?? null,
        competitors: m.competitors.map((c) => ({
          ...c,
          worktreePath: c.worktreePath ?? null,
          branchName: c.branchName ?? null,
          merged: c.merged ?? false,
          terminalOutput: c.terminalOutput ?? null,
        })),
      }));
      loadHistory(history);
    }
  } catch {
    console.warn('Failed to parse arena history');
  }
}

export async function saveArenaHistory(): Promise<void> {
  await invoke(IPC.SaveArenaData, {
    filename: 'arena-history.json',
    json: JSON.stringify(unwrap(arenaStore.history)),
  }).catch((e) => console.warn('Failed to save arena history:', e));
}
