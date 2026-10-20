import { shellPanelIndex } from './focused-panel';

/** What the "close current panel" shortcut (Cmd/Ctrl+W) acts on. */
export type PanelCloseTarget =
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'shell'; taskId: string; shellId: string }
  | { kind: 'canvas'; taskId: string };

interface PanelCloseState {
  activeTaskId: string | null;
  sidebarFocused: boolean;
  placeholderFocused: boolean;
  newTaskPanelFocused: boolean;
  terminals: Record<string, unknown>;
  tasks: Record<string, { shellAgentIds: string[] }>;
  focusedPanel: Record<string, string>;
}

export function resolvePanelCloseTarget(state: PanelCloseState): PanelCloseTarget | null {
  // Focus can sit outside the active slot while `activeTaskId` still points at
  // it — the same reason `isPanelFocused` consults these flags. Killing a
  // live pty from a shortcut aimed outside that slot would be unrecoverable.
  if (state.sidebarFocused || state.placeholderFocused || state.newTaskPanelFocused) return null;

  const id = state.activeTaskId;
  if (!id) return null;

  if (state.terminals[id]) return { kind: 'terminal', terminalId: id };

  const focusedPanel = state.focusedPanel[id] ?? '';
  if (focusedPanel === 'canvas' && state.tasks[id]) return { kind: 'canvas', taskId: id };

  const index = shellPanelIndex(focusedPanel);
  if (index === null) return null;

  const shellId = state.tasks[id]?.shellAgentIds[index];
  return shellId ? { kind: 'shell', taskId: id, shellId } : null;
}
