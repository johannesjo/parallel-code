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
import { inferDockerSource } from '../lib/docker';
import { DEFAULT_TERMINAL_FONT } from '../lib/fonts';
import { isLookPreset } from '../lib/look';
import { syncTerminalCounter } from './terminals';

/** Enrich an agent def with resume/skip-permissions args from fresh defaults. */
function enrichAgentDef(agentDef: AgentDef | null | undefined, availableAgents: AgentDef[]): void {
  if (!agentDef) return;
  const fresh = availableAgents.find((a) => a.id === agentDef.id);
  if (fresh) {
    if (!agentDef.resume_args) agentDef.resume_args = fresh.resume_args;
    if (!agentDef.skip_permissions_args)
      agentDef.skip_permissions_args = fresh.skip_permissions_args;
  }
}

export async function saveState(): Promise<void> {
  const persisted: PersistedState = {
    projects: store.projects.map((p) => ({ ...p })),
    lastProjectId: store.lastProjectId,
    lastAgentId: store.lastAgentId,
    taskOrder: [...store.taskOrder],
    collapsedTaskOrder: [...store.collapsedTaskOrder],
    tasks: {},
    activeTaskId: store.activeTaskId,
    sidebarVisible: store.sidebarVisible,
    panelSizes: { ...store.panelSizes },
    globalScale: store.globalScale,
    completedTaskDate: store.completedTaskDate,
    completedTaskCount: store.completedTaskCount,
    mergedLinesAdded: store.mergedLinesAdded,
    mergedLinesRemoved: store.mergedLinesRemoved,
    terminalFont: store.terminalFont,
    themePreset: store.themePreset,
    showPromptInput: store.showPromptInput,
    fontSmoothing: store.fontSmoothing,
    windowState: store.windowState ? { ...store.windowState } : undefined,
    autoTrustFolders: store.autoTrustFolders,
    showPlans: store.showPlans,
    showSteps: store.showSteps,
    desktopNotificationsEnabled: store.desktopNotificationsEnabled,
    inactiveColumnOpacity: store.inactiveColumnOpacity,
    editorCommand: store.editorCommand || undefined,
    dockerImage: store.dockerImage !== 'parallel-code-agent:latest' ? store.dockerImage : undefined,
    askCodeProvider: store.askCodeProvider !== 'claude' ? store.askCodeProvider : undefined,
    customAgents: store.customAgents.length > 0 ? [...store.customAgents] : undefined,
    focusMode: store.focusMode || undefined,
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
      gitIsolation: task.gitIsolation,
      baseBranch: task.baseBranch,
      externalWorktree: task.externalWorktree,
      skipPermissions: task.skipPermissions,
      dockerMode: task.dockerMode,
      dockerSource: task.dockerSource,
      dockerImage: task.dockerImage,
      githubUrl: task.githubUrl,
      savedInitialPrompt: task.savedInitialPrompt,
      planFileName: task.planFileName,
      stepsEnabled: task.stepsEnabled,
    };
  }

  for (const taskId of store.collapsedTaskOrder) {
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
      agentDef: firstAgent?.def ?? task.savedAgentDef ?? null,
      gitIsolation: task.gitIsolation,
      baseBranch: task.baseBranch,
      externalWorktree: task.externalWorktree,
      skipPermissions: task.skipPermissions,
      dockerMode: task.dockerMode,
      dockerSource: task.dockerSource,
      dockerImage: task.dockerImage,
      githubUrl: task.githubUrl,
      savedInitialPrompt: task.savedInitialPrompt,
      planFileName: task.planFileName,
      stepsEnabled: task.stepsEnabled,
      collapsed: true,
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
  collapsedTaskOrder?: string[];
  tasks: Record<string, PersistedTask & { projectId?: string }>;
  activeTaskId: string | null;
  sidebarVisible: boolean;
  // Fields that may be present in newer state files (validated at runtime)
  panelSizes?: unknown;
  globalScale?: unknown;
  completedTaskDate?: unknown;
  completedTaskCount?: unknown;
  mergedLinesAdded?: unknown;
  mergedLinesRemoved?: unknown;
  terminalFont?: unknown;
  themePreset?: unknown;
  showPromptInput?: unknown;
  fontSmoothing?: unknown;
  windowState?: unknown;
  autoTrustFolders?: unknown;
  showPlans?: unknown;
  showSteps?: unknown;
  desktopNotificationsEnabled?: unknown;
  inactiveColumnOpacity?: unknown;
  editorCommand?: unknown;
  dockerImage?: unknown;
  askCodeProvider?: unknown;
  minimaxApiKey?: unknown;
  customAgents?: unknown;
  terminals?: unknown;
  focusMode?: unknown;
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
  // Also migrate defaultDirectMode -> defaultGitIsolation
  for (const p of projects) {
    if (!p.color) p.color = randomPastelColor();
    // Migrate defaultDirectMode -> defaultGitIsolation
    const legacy = p as Project & { defaultDirectMode?: boolean };
    if (legacy.defaultDirectMode !== undefined && p.defaultGitIsolation === undefined) {
      p.defaultGitIsolation = legacy.defaultDirectMode ? 'direct' : undefined;
      delete (legacy as unknown as Record<string, unknown>).defaultDirectMode;
    }
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
      s.panelSizes = isStringNumberRecord(raw.panelSizes) ? raw.panelSizes : {};
      s.globalScale = typeof raw.globalScale === 'number' ? raw.globalScale : 1;
      const completedTaskDate =
        typeof raw.completedTaskDate === 'string' ? raw.completedTaskDate : today;
      const completedTaskCountRaw = raw.completedTaskCount;
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
      const mergedLinesAddedRaw = raw.mergedLinesAdded;
      const mergedLinesRemovedRaw = raw.mergedLinesRemoved;
      s.mergedLinesAdded =
        typeof mergedLinesAddedRaw === 'number' && Number.isFinite(mergedLinesAddedRaw)
          ? Math.max(0, Math.floor(mergedLinesAddedRaw))
          : 0;
      s.mergedLinesRemoved =
        typeof mergedLinesRemovedRaw === 'number' && Number.isFinite(mergedLinesRemovedRaw)
          ? Math.max(0, Math.floor(mergedLinesRemovedRaw))
          : 0;
      s.terminalFont =
        typeof raw.terminalFont === 'string' && raw.terminalFont.trim()
          ? raw.terminalFont
          : DEFAULT_TERMINAL_FONT;
      s.themePreset = isLookPreset(raw.themePreset) ? raw.themePreset : 'minimal';
      s.showPromptInput = typeof raw.showPromptInput === 'boolean' ? raw.showPromptInput : true;
      s.fontSmoothing = typeof raw.fontSmoothing === 'boolean' ? raw.fontSmoothing : true;
      s.windowState = parsePersistedWindowState(raw.windowState);
      s.autoTrustFolders = typeof raw.autoTrustFolders === 'boolean' ? raw.autoTrustFolders : false;
      s.showPlans = typeof raw.showPlans === 'boolean' ? raw.showPlans : true;
      s.showSteps = typeof raw.showSteps === 'boolean' ? raw.showSteps : false;
      s.desktopNotificationsEnabled =
        typeof raw.desktopNotificationsEnabled === 'boolean'
          ? raw.desktopNotificationsEnabled
          : false;
      const rawOpacity = raw.inactiveColumnOpacity;
      s.inactiveColumnOpacity =
        typeof rawOpacity === 'number' &&
        Number.isFinite(rawOpacity) &&
        rawOpacity >= 0.3 &&
        rawOpacity <= 1.0
          ? Math.round(rawOpacity * 100) / 100
          : 0.6;

      const rawEditorCommand = raw.editorCommand;
      s.editorCommand = typeof rawEditorCommand === 'string' ? rawEditorCommand.trim() : '';

      s.focusMode = raw.focusMode === true;

      const rawDockerImage = raw.dockerImage;
      s.dockerImage =
        typeof rawDockerImage === 'string' && rawDockerImage.trim()
          ? rawDockerImage.trim()
          : 'parallel-code-agent:latest';

      s.askCodeProvider = raw.askCodeProvider === 'minimax' ? 'minimax' : 'claude';

      // Restore custom agents
      if (Array.isArray(raw.customAgents)) {
        s.customAgents = raw.customAgents.filter(
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

        enrichAgentDef(agentDef, s.availableAgents);

        const shellAgentIds: string[] = [];
        for (let i = 0; i < pt.shellCount; i++) {
          shellAgentIds.push(crypto.randomUUID());
        }

        const legacy = pt as PersistedTask & { directMode?: boolean };
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
          gitIsolation: legacy.gitIsolation ?? (legacy.directMode ? 'direct' : 'worktree'),
          baseBranch: legacy.baseBranch || undefined,
          externalWorktree: pt.externalWorktree,
          skipPermissions: pt.skipPermissions === true,
          dockerMode: pt.dockerMode === true ? true : undefined,
          dockerSource:
            pt.dockerMode === true
              ? (pt.dockerSource ??
                inferDockerSource(typeof pt.dockerImage === 'string' ? pt.dockerImage : undefined))
              : undefined,
          dockerImage: typeof pt.dockerImage === 'string' ? pt.dockerImage : undefined,
          githubUrl: pt.githubUrl,
          savedInitialPrompt: pt.savedInitialPrompt,
          planFileName: pt.planFileName,
          stepsEnabled: pt.stepsEnabled,
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
      const rawTerminals = (raw.terminals ?? {}) as Record<string, { id: string; name: string }>;
      for (const termId of raw.taskOrder) {
        const pt = rawTerminals[termId];
        if (!pt) continue;
        const agentId = crypto.randomUUID();
        s.terminals[termId] = { id: pt.id, name: pt.name, agentId };
      }

      // Remove orphaned entries from taskOrder
      s.taskOrder = s.taskOrder.filter((id) => s.tasks[id] || s.terminals[id]);

      // Restore collapsed tasks
      const collapsedOrder = raw.collapsedTaskOrder ?? [];
      for (const taskId of collapsedOrder) {
        const pt = raw.tasks[taskId];
        if (!pt || !pt.collapsed) continue;

        const agentDef = pt.agentDef;
        enrichAgentDef(agentDef, s.availableAgents);

        const legacyCollapsed = pt as PersistedTask & { directMode?: boolean };
        const task: Task = {
          id: pt.id,
          name: pt.name,
          projectId: pt.projectId ?? '',
          branchName: pt.branchName,
          worktreePath: pt.worktreePath,
          agentIds: [],
          shellAgentIds: [],
          notes: pt.notes,
          lastPrompt: pt.lastPrompt,
          gitIsolation:
            legacyCollapsed.gitIsolation ?? (legacyCollapsed.directMode ? 'direct' : 'worktree'),
          baseBranch: legacyCollapsed.baseBranch || undefined,
          externalWorktree: pt.externalWorktree,
          skipPermissions: pt.skipPermissions === true,
          dockerMode: pt.dockerMode === true ? true : undefined,
          dockerSource:
            pt.dockerMode === true
              ? (pt.dockerSource ??
                inferDockerSource(typeof pt.dockerImage === 'string' ? pt.dockerImage : undefined))
              : undefined,
          dockerImage: typeof pt.dockerImage === 'string' ? pt.dockerImage : undefined,
          githubUrl: pt.githubUrl,
          savedInitialPrompt: pt.savedInitialPrompt,
          planFileName: pt.planFileName,
          stepsEnabled: pt.stepsEnabled,
          collapsed: true,
          savedAgentDef: agentDef ?? undefined,
        };

        s.tasks[taskId] = task;
      }
      s.collapsedTaskOrder = collapsedOrder.filter((id) => s.tasks[id]);

      // Defensive: ensure no task appears in both arrays (corrupted state)
      const activeSet = new Set(s.taskOrder);
      s.collapsedTaskOrder = s.collapsedTaskOrder.filter((id) => !activeSet.has(id));

      // Focus mode requires a valid active panel; without one, every panel is
      // hidden and the strip reads blank. Repair or drop focus mode.
      if (s.focusMode) {
        const activeValid =
          s.activeTaskId !== null &&
          (s.tasks[s.activeTaskId] !== undefined || s.terminals[s.activeTaskId] !== undefined);
        if (!activeValid) {
          s.activeTaskId = s.taskOrder[0] ?? null;
          if (s.activeTaskId === null) s.focusMode = false;
        }
      }

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
