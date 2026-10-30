import { matchesTaskProjectFilter } from './task-project-filter';
import { sortByProjectGroup } from './sidebar-order';
import { produce } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore, cleanupPanelEntries } from './core';
import { effectiveAgentId } from './agent-select';
import { clearAgentActivity } from './taskStatus';
import { triggerFocus, getTaskFocusedPanel } from './focused-panel';
import type { Terminal } from './types';
import { warn as logWarn } from '../lib/log';
import { prefersMotion } from '../lib/reducedMotion';
import {
  boardCoversWorkspace,
  boardSidePanelOpen,
  closeBoardSidePanel,
  closeProjectPages,
} from './project-pages';

let terminalCounter = 0;
let lastCreateTime = 0;

// Matches the `.task-removing` and `.task-item-removing` animations in styles.css.
const REMOVE_ANIMATION_MS = 160;
// Under reduced motion nothing animates, so a closed task need not linger.
const removeDelayMs = () => (prefersMotion() ? REMOVE_ANIMATION_MS : 0);

export function createTerminal(): void {
  const now = Date.now();
  if (now - lastCreateTime < 300) return;
  lastCreateTime = now;

  terminalCounter++;
  const id = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const name = `Terminal ${terminalCounter}`;

  const terminal: Terminal = { id, name, agentId };

  setStore('terminals', id, terminal);
  setStore('taskOrder', store.taskOrder.length, id);
  setStore('focusedPanel', id, 'terminal');
  closeProjectPages();
  setStore('activeTaskId', id);
  setStore('activeAgentId', null);
  setStore('sidebarFocused', false);
  setStore('newTaskPanelFocused', false);

  requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'end', behavior: 'instant' });
  });
}

export async function closeTerminal(terminalId: string): Promise<void> {
  const terminal = store.terminals[terminalId];
  if (!terminal || terminal.closingStatus === 'removing' || terminal.closingStatus === 'closing')
    return;

  // Set closing status synchronously to prevent concurrent close calls
  setStore('terminals', terminalId, 'closingStatus', 'closing');
  // As for a closed task, the board's side panel goes at once: it was opened
  // for this terminal and must not land on an unrelated neighbour.
  if (boardSidePanelOpen() && store.activeTaskId === terminalId) closeBoardSidePanel();

  await invoke(IPC.KillAgent, { agentId: terminal.agentId }).catch((err) => {
    logWarn('terminals.close', 'KillAgent failed', { err });
  });
  clearAgentActivity(terminal.agentId);

  const order = sortByProjectGroup(store.taskOrder.filter(matchesTaskProjectFilter));
  const idx = order.indexOf(terminalId);

  // Switch active panel to neighbor before animation
  if (store.activeTaskId === terminalId) {
    const neighborIdx = idx > 0 ? idx - 1 : idx + 1;
    const neighbor = order[neighborIdx] ?? null;
    setStore('activeTaskId', neighbor);
    const neighborTask = neighbor ? store.tasks[neighbor] : null;
    setStore('activeAgentId', neighborTask ? effectiveAgentId(neighborTask) : null);
    // The closed panel took the keyboard with it; the board's cards get it back.
    if (boardCoversWorkspace()) triggerFocus('task-board');
  }

  // Phase 1: mark as removing so UI can animate
  setStore('terminals', terminalId, 'closingStatus', 'removing');

  // Phase 2: actually delete after animation completes
  setTimeout(() => {
    setStore(
      produce((s) => {
        delete s.terminals[terminalId];
        delete s.agents[terminal.agentId];
        cleanupPanelEntries(s, terminalId);

        if (s.activeTaskId === terminalId) {
          s.activeTaskId = s.taskOrder.find(matchesTaskProjectFilter) ?? null;
          const firstTask = s.activeTaskId ? s.tasks[s.activeTaskId] : null;
          s.activeAgentId = firstTask ? effectiveAgentId(firstTask) : null;
        }
      }),
    );

    const activeId = store.activeTaskId;
    // Behind the board the neighbour's panel is hidden and must not take the keyboard.
    if (activeId && !boardCoversWorkspace()) {
      const panel = getTaskFocusedPanel(activeId);
      requestAnimationFrame(() => triggerFocus(`${activeId}:${panel}`));
    }
  }, removeDelayMs());
}

export function updateTerminalName(terminalId: string, name: string): void {
  setStore('terminals', terminalId, 'name', name);
}

/** Restore the auto-increment counter from persisted state. */
export function syncTerminalCounter(): void {
  let max = 0;
  for (const id of store.taskOrder) {
    const t = store.terminals[id];
    if (!t) continue;
    const match = t.name.match(/^Terminal (\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  terminalCounter = max;
}
