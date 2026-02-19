import { produce } from "solid-js/store";
import { store, setStore } from "./core";
import type { TerminalFont } from "../lib/fonts";
import type { LookPreset } from "../lib/look";
import type { PersistedWindowState } from "./types";

// --- Font Scale ---

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.0;
const SCALE_STEP = 0.1;

export function getFontScale(panelId: string): number {
  return store.fontScales[panelId] ?? 1;
}

export function adjustFontScale(panelId: string, delta: 1 | -1): void {
  const current = getFontScale(panelId);
  const next = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, current + delta * SCALE_STEP)) * 10) / 10;
  setStore("fontScales", panelId, next);
}

export function resetFontScale(panelId: string): void {
  if (panelId.includes(":")) {
    setStore("fontScales", panelId, 1.0);
  } else {
    // Reset all sub-panels for this task (or "sidebar")
    setStore(produce((s) => {
      const prefix = panelId + ":";
      for (const key of Object.keys(s.fontScales)) {
        if (key === panelId || key.startsWith(prefix)) s.fontScales[key] = 1.0;
      }
    }));
  }
}

// --- Global Scale ---

export function getGlobalScale(): number {
  return store.globalScale;
}

export function adjustGlobalScale(delta: 1 | -1): void {
  const current = store.globalScale;
  const next = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, current + delta * SCALE_STEP)) * 10) / 10;
  setStore("globalScale", next);
}

export function resetGlobalScale(): void {
  setStore("globalScale", 1);
}

// --- Panel Sizes ---

export function getPanelSize(key: string): number | undefined {
  return store.panelSizes[key];
}

export function setPanelSizes(entries: Record<string, number>): void {
  for (const [key, value] of Object.entries(entries)) {
    setStore("panelSizes", key, value);
  }
}

// --- Sidebar ---

export function toggleSidebar(): void {
  setStore("sidebarVisible", !store.sidebarVisible);
}

export function setTerminalFont(terminalFont: TerminalFont): void {
  setStore("terminalFont", terminalFont);
}

export function setThemePreset(themePreset: LookPreset): void {
  setStore("themePreset", themePreset);
}

export function setAutoTrustFolders(autoTrustFolders: boolean): void {
  setStore("autoTrustFolders", autoTrustFolders);
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
  setStore("windowState", windowState);
}
