import { produce } from 'solid-js/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { store, setStore } from './core';
import { randomPastelColor } from './projects';
import { markAgentSpawned } from './taskStatus';
import { getLocalDateKey } from '../lib/date';
import type {
  Agent,
  Task,
  PersistedState,
  PersistedTask,
  PersistedWindowState,
  Project,
} from './types';
import type { AgentDef } from '../ipc/types';
import { DEFAULT_TERMINAL_FONT, isTerminalFont } from '../lib/fonts';
import { isLookPreset } from '../lib/look';
import { syncTerminalCounter } from './terminals';

export async function saveState(): Promise<void> {
  const persisted: PersistedState = {
    projects: store.projects.map((p) => ({ ...p })),
    lastProjectId: store.lastProjectId,
    lastAgentId: store.lastAgentId,
    taskOrder: [...store.taskOrder],
    tasks: {},
    activeTaskId: store.activeTaskId,
    sidebarVisible: store.sidebarVisible,
    fontScales: { ...store.fontScales },
    panelSizes: { ...store.panelSizes },
    globalScale: store.globalScale,
    completedTaskDate: store.completedTaskDate,
    completedTaskCount: store.completedTaskCount,
    mergedLinesAdded: store.mergedLinesAdded,
    mergedLinesRemoved: store.mergedLinesRemoved,
    terminalFont: store.terminalFont,
    themePreset: store.themePreset,
    windowState: store.windowState ? { ...store.windowState } : undefined,
    autoTrustFolders: store.autoTrustFolders,
    inactiveColumnOpacity: store.inactiveColumnOpacity,
    customAgents: store.customAgents.length > 0 ? [...store.customAgents] : undefined,
  };

  for (const taskId of store.taskOrder) {
    const task = store.tasks[taskId];
    if (!task) continue;

    const firstAgent = task.agentIds[0] ? store.agents[task.agentIds[0]] : null;

    persisted.tasks[taskId] = {
      id: task.id,
      name: task.name,
      projectId: task.projectId,
      branchName: task.branchName,
      worktreePath: task.worktreePath,
      notes: task.notes,
      lastPrompt: task.lastPrompt,
      shellCount: task.shellAgentIds.length,
      agentDef: firstAgent?.def ?? null,
      directMode: task.directMode,
      skipPermissions: task.skipPermissions,
      githubUrl: task.githubUrl,
      savedInitialPrompt: task.savedInitialPrompt,
    };
  }

  for (const id of store.taskOrder) {
    const terminal = store.terminals[id];
    if (!terminal) continue;
    if (!persisted.terminals) persisted.terminals = {};
    persisted.terminals[id] = { id: terminal.id, name: terminal.name };
  }

  await invoke(IPC.SaveAppState, { json: JSON.stringify(persisted) }).catch((e) =>
    console.warn('Failed to save state:', e),
  );
}

function isStringNumberRecord(v: unknown): v is Record<string, number> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (val) => typeof val === 'number' && Number.isFinite(val),
  );
}

function parsePersistedWindowState(v: unknown): PersistedWindowState | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;

  const raw = v as Record<string, unknown>;
  const x = raw.x;
  const y = raw.y;
  const width = raw.width;
  const height = raw.height;
  const maximized = raw.maximized;

  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height <= 0 ||
    typeof maximized !== 'boolean'
  ) {
    return null;
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    maximized,
  };
}

interface LegacyPersistedState {
  projectRoot?: string;
  projects?: Project[];
  lastProjectId?: string | null;
  lastAgentId?: string | null;
  taskOrder: string[];
  tasks: Record<string, PersistedTask & { projectId?: string }>;
  activeTaskId: string | null;
  sidebarVisible: boolean;
}

export async function loadState(): Promise<void> {
  const json = await invoke<string | null>(IPC.LoadAppState).catch(() => null);
  if (!json) return;

  let raw: LegacyPersistedState;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn('Failed to parse persisted state');
    return;
  }

  // Validate essential structure
  if (
    !raw ||
    typeof raw !== 'object' ||
    !Array.isArray(raw.taskOrder) ||
    typeof raw.tasks !== 'object'
  ) {
    console.warn('Invalid persisted state structure, skipping load');
    return;
  }

  // Migrate from old format if needed
  let projects: Project[] = raw.projects ?? [];
  let lastProjectId: string | null = raw.lastProjectId ?? null;
  const lastAgentId: string | null = raw.lastAgentId ?? null;

  // Assign colors to projects that don't have one (backward compat)
  for (const p of projects) {
    if (!p.color) p.color = randomPastelColor();
  }

  if (projects.length === 0 && raw.projectRoot) {
    const segments = raw.projectRoot.split('/');
    const name = segments[segments.length - 1] || raw.projectRoot;
    const id = crypto.randomUUID();
    projects = [{ id, name, path: raw.projectRoot, color: randomPastelColor() }];
    lastProjectId = id;

    // Assign this project to all existing tasks
    for (const taskId of raw.taskOrder) {
      const pt = raw.tasks[taskId];
      if (pt && !pt.projectId) {
        pt.projectId = id;
      }
    }
  }

  const restoredRunningAgentIds: string[] = [];
  const today = getLocalDateKey();

  setStore(
    produce((s) => {
      s.projects = projects;
      s.lastProjectId = lastProjectId;
      s.lastAgentId = lastAgentId;
      s.taskOrder = raw.taskOrder;
      s.activeTaskId = raw.activeTaskId;
      s.sidebarVisible = raw.sidebarVisible;
      const rawAny = raw as unknown as Record<string, unknown>;
      s.fontScales = isStringNumberRecord(rawAny.fontScales) ? rawAny.fontScales : {};
      s.panelSizes = isStringNumberRecord(rawAny.panelSizes) ? rawAny.panelSizes : {};
      s.globalScale = typeof rawAny.globalScale === 'number' ? rawAny.globalScale : 1;
      const completedTaskDate =
        typeof rawAny.completedTaskDate === 'string' ? rawAny.completedTaskDate : today;
      const completedTaskCountRaw = rawAny.completedTaskCount;
      const completedTaskCount =
        typeof completedTaskCountRaw === 'number' && Number.isFinite(completedTaskCountRaw)
          ? Math.max(0, Math.floor(completedTaskCountRaw))
          : 0;
      if (completedTaskDate === today) {
        s.completedTaskDate = completedTaskDate;
        s.completedTaskCount = completedTaskCount;
      } else {
        s.completedTaskDate = today;
        s.completedTaskCount = 0;
      }
      const mergedLinesAddedRaw = rawAny.mergedLinesAdded;
      const mergedLinesRemovedRaw = rawAny.mergedLinesRemoved;
      s.mergedLinesAdded =
        typeof mergedLinesAddedRaw === 'number' && Number.isFinite(mergedLinesAddedRaw)
          ? Math.max(0, Math.floor(mergedLinesAddedRaw))
          : 0;
      s.mergedLinesRemoved =
        typeof mergedLinesRemovedRaw === 'number' && Number.isFinite(mergedLinesRemovedRaw)
          ? Math.max(0, Math.floor(mergedLinesRemovedRaw))
          : 0;
      s.terminalFont = isTerminalFont(rawAny.terminalFont)
        ? rawAny.terminalFont
        : DEFAULT_TERMINAL_FONT;
      s.themePreset = isLookPreset(rawAny.themePreset) ? rawAny.themePreset : 'minimal';
      s.windowState = parsePersistedWindowState(rawAny.windowState);
      s.autoTrustFolders =
        typeof rawAny.autoTrustFolders === 'boolean' ? rawAny.autoTrustFolders : false;
      const rawOpacity = rawAny.inactiveColumnOpacity;
      s.inactiveColumnOpacity =
        typeof rawOpacity === 'number' &&
        Number.isFinite(rawOpacity) &&
        rawOpacity >= 0.3 &&
        rawOpacity <= 1.0
          ? Math.round(rawOpacity * 100) / 100
          : 0.6;

      // Restore custom agents
      const rawCustomAgents = rawAny.customAgents;
      if (Array.isArray(rawCustomAgents)) {
        s.customAgents = rawCustomAgents.filter(
          (a: unknown): a is AgentDef =>
            typeof a === 'object' &&
            a !== null &&
            typeof (a as AgentDef).id === 'string' &&
            typeof (a as AgentDef).name === 'string' &&
            typeof (a as AgentDef).command === 'string',
        );
      }

      // Make custom agents findable during task restoration
      for (const ca of s.customAgents) {
        if (!s.availableAgents.some((a) => a.id === ca.id)) {
          s.availableAgents.push(ca);
        }
      }

      for (const taskId of raw.taskOrder) {
        const pt = raw.tasks[taskId];
        if (!pt) continue;

        const agentId = crypto.randomUUID();
        const agentDef = pt.agentDef;

        // Enrich with resume_args/skip_permissions_args from fresh defaults (handles old state files)
        if (agentDef) {
          const fresh = s.availableAgents.find((a) => a.id === agentDef.id);
          if (fresh) {
            if (!agentDef.resume_args) agentDef.resume_args = fresh.resume_args;
            if (!agentDef.skip_permissions_args)
              agentDef.skip_permissions_args = fresh.skip_permissions_args;
          }
        }

        const shellAgentIds: string[] = [];
        for (let i = 0; i < pt.shellCount; i++) {
          shellAgentIds.push(crypto.randomUUID());
        }

        const task: Task = {
          id: pt.id,
          name: pt.name,
          projectId: pt.projectId ?? '',
          branchName: pt.branchName,
          worktreePath: pt.worktreePath,
          agentIds: agentDef ? [agentId] : [],
          shellAgentIds,
          notes: pt.notes,
          lastPrompt: pt.lastPrompt,
          directMode: pt.directMode,
          skipPermissions: pt.skipPermissions === true,
          githubUrl: pt.githubUrl,
          savedInitialPrompt: pt.savedInitialPrompt,
        };

        s.tasks[taskId] = task;

        if (agentDef) {
          const agent: Agent = {
            id: agentId,
            taskId,
            def: agentDef,
            resumed: true,
            status: 'running',
            exitCode: null,
            signal: null,
            lastOutput: [],
            generation: 0,
          };
          s.agents[agentId] = agent;
          restoredRunningAgentIds.push(agentId);
        }
      }

      // Restore terminals
      const rawTerminals = (rawAny.terminals ?? {}) as Record<string, { id: string; name: string }>;
      for (const termId of raw.taskOrder) {
        const pt = rawTerminals[termId];
        if (!pt) continue;
        const agentId = crypto.randomUUID();
        s.terminals[termId] = { id: pt.id, name: pt.name, agentId };
      }

      // Remove orphaned entries from taskOrder
      s.taskOrder = s.taskOrder.filter((id) => s.tasks[id] || s.terminals[id]);

      // Set activeAgentId from the active task
      if (s.activeTaskId && s.tasks[s.activeTaskId]) {
        s.activeAgentId = s.tasks[s.activeTaskId].agentIds[0] ?? null;
      }
    }),
  );

  // Restored agents are considered running; reflect that immediately in task status dots.
  for (const agentId of restoredRunningAgentIds) {
    markAgentSpawned(agentId);
  }

  syncTerminalCounter();
}
