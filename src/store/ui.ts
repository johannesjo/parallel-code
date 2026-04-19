import { batch } from 'solid-js';
import { store, setStore } from './core';
import type { LookPreset } from '../lib/look';
import type { PersistedWindowState, TaskViewportVisibility } from './types';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.0;
const SCALE_STEP = 0.1;

// --- Global Scale ---

export function getGlobalScale(): number {
  return store.globalScale;
}

export function adjustGlobalScale(delta: 1 | -1): void {
  const current = store.globalScale;
  const next =
    Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, current + delta * SCALE_STEP)) * 10) / 10;
  setStore('globalScale', next);
}

export function resetGlobalScale(): void {
  setStore('globalScale', 1);
}

// --- Panel Sizes ---

export function getPanelSize(key: string): number | undefined {
  return store.panelSizes[key];
}

export function setPanelSizes(entries: Record<string, number>): void {
  batch(() => {
    for (const [key, value] of Object.entries(entries)) {
      setStore('panelSizes', key, value);
    }
  });
}

export function getTaskViewportVisibility(taskId: string): TaskViewportVisibility | null {
  return store.taskViewportVisibility[taskId] ?? null;
}

export function setTaskViewportVisibility(entries: Record<string, TaskViewportVisibility>): void {
  setStore('taskViewportVisibility', entries);
}

// --- Sidebar ---

export function toggleSidebar(): void {
  setStore('sidebarVisible', !store.sidebarVisible);
}

export function setTerminalFont(terminalFont: string): void {
  setStore('terminalFont', terminalFont);
}

export function setThemePreset(themePreset: LookPreset): void {
  setStore('themePreset', themePreset);
}

export function setAutoTrustFolders(autoTrustFolders: boolean): void {
  setStore('autoTrustFolders', autoTrustFolders);
}

export function setShowPlans(showPlans: boolean): void {
  setStore('showPlans', showPlans);
}

export function setShowPromptInput(show: boolean): void {
  setStore('showPromptInput', show);
}

export function setFontSmoothing(enabled: boolean): void {
  setStore('fontSmoothing', enabled);
}

export function setDesktopNotificationsEnabled(enabled: boolean): void {
  setStore('desktopNotificationsEnabled', enabled);
}

export function setInactiveColumnOpacity(opacity: number): void {
  setStore('inactiveColumnOpacity', Math.round(Math.max(0.3, Math.min(1.0, opacity)) * 100) / 100);
}

export function setEditorCommand(command: string): void {
  setStore('editorCommand', command);
}

export function setDockerImage(image: string): void {
  setStore('dockerImage', image || 'parallel-code-agent:latest');
}

export function setAskCodeProvider(provider: 'claude' | 'minimax'): void {
  setStore('askCodeProvider', provider);
}

export function setMinimaxApiKey(key: string): void {
  invoke(IPC.SetMinimaxApiKey, { key: key.trim() }).catch((e) =>
    console.warn('Failed to set MiniMax API key:', e),
  );
}

export function setDockerAvailable(available: boolean): void {
  setStore('dockerAvailable', available);
}

export function toggleArena(show?: boolean): void {
  setStore('showArena', show ?? !store.showArena);
}

export function toggleFocusMode(on?: boolean): void {
  setStore('focusMode', on ?? !store.focusMode);
}

export function setWindowState(windowState: PersistedWindowState): void {
  const current = store.windowState;
  if (
    current &&
    current.x === windowState.x &&
    current.y === windowState.y &&
    current.width === windowState.width &&
    current.height === windowState.height &&
    current.maximized === windowState.maximized
  ) {
    return;
  }
  setStore('windowState', windowState);
}
