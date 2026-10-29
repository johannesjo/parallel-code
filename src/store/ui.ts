import { documentAgentTaskId } from '../documents/task-id';
import { batch } from 'solid-js';
import { produce, reconcile } from 'solid-js/store';
import { store, setStore } from './core';
import { setActiveTask } from './navigation';
import { setTaskFocusedPanel } from './focused-panel';
import { closeBoard, closeProjectPages, projectPageOpen } from './project-pages';
import type { LookPreset, AppearanceMode } from '../lib/look';
import { osIsDark } from '../lib/os-appearance';
import type { CustomTheme } from '../lib/custom-theme';
import { themeToCss } from '../lib/custom-theme';
import type { ReviewModelSettings } from '../lib/task-review';
import type { BriefBarFields } from '../lib/task-brief';
import type { PersistedWindowState, TaskViewportVisibility } from './types';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { defaultAskCodeModel, type AskCodeProvider } from '../../electron/shared/ask-code-models';
import type { BriefModelId, TaskNameModelId } from '../../electron/shared/task-name-model';

// Set to true after loadCustomThemes() resolves. Sanitization of persisted slot
// IDs is skipped until then so the startup reactive effect cannot null them out
// before the theme files have been loaded into the store.
let customThemesReady = false;

export function markCustomThemesReady(): void {
  customThemesReady = true;
  applyAppearanceMode();
}

export function _resetCustomThemesReadyForTest(): void {
  customThemesReady = false;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.0;
const SCALE_STEP = 0.1;

// --- Global Scale ---

export function adjustGlobalScale(delta: 1 | -1): void {
  const current = store.globalScale;
  const next =
    Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, current + delta * SCALE_STEP)) * 10) / 10;
  setStore('globalScale', next);
}

export function resetGlobalScale(): void {
  setStore('globalScale', 1);
}

// --- Panel User Sizes ---
//
// Presence of an entry means the user dragged the panel to that pixel size;
// absence means the panel falls back to its content-sized or flex-absorber
// default. No separate "manual" flag — the entry itself is the pin.

export function getPanelUserSize(key: string): number | undefined {
  return store.panelUserSize[key];
}

export function setPanelUserSize(key: string, px: number): void {
  setStore('panelUserSize', key, px);
}

export function deletePanelUserSize(keys: string[]): void {
  if (keys.length === 0) return;
  batch(() => {
    setStore(
      'panelUserSize',
      produce((sizes: Record<string, number>) => {
        for (const key of keys) delete sizes[key];
      }),
    );
  });
}

export function getTaskViewportVisibility(taskId: string): TaskViewportVisibility | null {
  return store.taskViewportVisibility[taskId] ?? null;
}

export function setTaskViewportVisibility(entries: Record<string, TaskViewportVisibility>): void {
  // reconcile, not a plain set: Solid merges objects, so tiles that left the
  // strip would keep reporting their last position.
  setStore('taskViewportVisibility', reconcile(entries));
}

// --- Sidebar ---

export function toggleSidebar(): void {
  setStore('sidebarVisible', !store.sidebarVisible);
}

export function setTerminalFont(terminalFont: string): void {
  setStore('terminalFont', terminalFont);
}

export function setTerminalScreenReaderMode(enabled: boolean): void {
  setStore('terminalScreenReaderMode', enabled);
}

export function applyAppearanceMode(): void {
  const isDark = osIsDark();
  const mode = store.appearanceMode;
  const slot = mode === 'system' ? (isDark ? 'dark' : 'light') : mode;

  // Sanitize both slots so the inactive grid in System mode also shows a selected card.
  // Skip before customThemesReady: theme files aren't in the store yet, and nulling
  // the persisted IDs now would permanently lose the user's selection.
  if (customThemesReady) {
    const rawDark = store.darkThemeCustomId;
    if (rawDark && !store.customThemes[rawDark]) setStore('darkThemeCustomId', null);
    const rawLight = store.lightThemeCustomId;
    if (rawLight && !store.customThemes[rawLight]) setStore('lightThemeCustomId', null);
  }

  const preset = slot === 'dark' ? store.darkThemePreset : store.lightThemePreset;
  const customId = slot === 'dark' ? store.darkThemeCustomId : store.lightThemeCustomId;
  setStore('themePreset', preset);
  setStore('activeCustomThemeId', customId);
}

export function setAppearanceMode(mode: AppearanceMode): void {
  setStore('appearanceMode', mode);
  applyAppearanceMode();
}

export function setLightTheme(preset: LookPreset, customId: string | null): void {
  batch(() => {
    setStore('lightThemePreset', preset);
    setStore('lightThemeCustomId', customId);
  });
  applyAppearanceMode();
}

export function setDarkTheme(preset: LookPreset, customId: string | null): void {
  batch(() => {
    setStore('darkThemePreset', preset);
    setStore('darkThemeCustomId', customId);
  });
  applyAppearanceMode();
}

export async function saveCustomTheme(theme: CustomTheme): Promise<void> {
  const css = themeToCss(theme.name, theme.description, theme.terminalBackground, theme.vars);
  await invoke(IPC.SaveCustomTheme, { id: theme.id, css });
  setStore('customThemes', theme.id, theme);
}

export async function deleteCustomTheme(id: string): Promise<void> {
  await invoke(IPC.DeleteCustomTheme, { id });
  setStore(
    'customThemes',
    produce((themes: Record<string, CustomTheme>) => {
      delete themes[id];
    }),
  );
  batch(() => {
    if (store.darkThemeCustomId === id) setStore('darkThemeCustomId', null);
    if (store.lightThemeCustomId === id) setStore('lightThemeCustomId', null);
    if (store.activeCustomThemeId === id) setStore('activeCustomThemeId', null);
  });
  applyAppearanceMode();
}

export function setAutoTrustFolders(autoTrustFolders: boolean): void {
  setStore('autoTrustFolders', autoTrustFolders);
}

export function setShowPlans(showPlans: boolean): void {
  setStore('showPlans', showPlans);
}

export function setKanbanHideDetails(hide: boolean): void {
  setStore('kanbanHideDetails', hide);
}

export function setModelTaskNames(enabled: boolean): void {
  setStore('modelTaskNames', enabled);
}

export function setTaskNameModel(model: TaskNameModelId): void {
  setStore('taskNameModel', model);
}

export function setTaskBriefs(enabled: boolean): void {
  setStore('taskBriefs', enabled);
}

export function setBriefBarField(field: keyof BriefBarFields, shown: boolean): void {
  setStore('briefBarFields', field, shown);
}

export function setBriefModel(model: BriefModelId): void {
  setStore('briefModel', model);
}

export function setReviewGuidance(guidance: string): void {
  setStore('reviewGuidance', guidance);
}

export function setShowSidebarTips(show: boolean): void {
  setStore('showSidebarTips', show);
}

export function setShowSidebarProgress(show: boolean): void {
  setStore('showSidebarProgress', show);
}

export function setSidebarNeedsInputFirst(enabled: boolean): void {
  setStore('sidebarNeedsInputFirst', enabled);
}

export function setProjectsCollapsed(collapsed: boolean): void {
  batch(() => {
    setStore('projectsCollapsed', collapsed);
    // Drop any project highlight when the section hides — keeping it would let
    // ↑/↓ walk through invisible items with no visual feedback.
    if (collapsed && store.sidebarFocusedProjectId !== null) {
      setStore('sidebarFocusedProjectId', null);
    }
  });
}

export function setProjectTasksCollapsed(projectId: string, collapsed: boolean): void {
  setStore(
    produce((s) => {
      const project = s.projects.find((entry) => entry.id === projectId);
      if (!project) return;
      project.tasksCollapsed = collapsed;

      const focusedTaskId = s.sidebarFocusedTaskId;
      if (collapsed && focusedTaskId && s.tasks[focusedTaskId]?.projectId === projectId) {
        s.sidebarFocusedTaskId = null;
      }
    }),
  );
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

export function setVerboseLogging(enabled: boolean): void {
  setStore('verboseLogging', enabled);
}

export function setPreferUiMode(enabled: boolean): void {
  setStore('preferUiMode', enabled);
}

export function setDisableClaudeUiMode(disabled: boolean): void {
  setStore('disableClaudeUiMode', disabled);
}

export function setDefaultSkipPermissions(enabled: boolean): void {
  setStore('defaultSkipPermissions', enabled);
}

export function setCanvasOwnershipBadges(enabled: boolean): void {
  setStore('canvasOwnershipBadges', enabled);
}

export function setFinishReview(enabled: boolean): void {
  setStore('finishReview', enabled);
}

export function setReviewModel(model: ReviewModelSettings): void {
  // Replaced whole: a model left out of the new choice must not survive from the old one.
  setStore('reviewModel', reconcile(model));
}

export function setDefaultPropagateSkipPermissions(enabled: boolean): void {
  setStore('defaultPropagateSkipPermissions', enabled);
}

export function setCoordinatorNotificationDelayMs(ms: number): void {
  const clamped = Math.max(5_000, Math.min(300_000, Math.round(ms)));
  setStore('coordinatorNotificationDelayMs', clamped);
}

export function setInactiveColumnOpacity(opacity: number): void {
  setStore('inactiveColumnOpacity', Math.round(Math.max(0.1, Math.min(1.0, opacity)) * 100) / 100);
}

export function setEditorCommand(command: string): void {
  setStore('editorCommand', command);
}

export function setDockerImage(image: string): void {
  setStore('dockerImage', image || 'parallel-code-agent:latest');
}

export function setAskCodeProvider(provider: AskCodeProvider): void {
  if (provider === store.askCodeProvider) return;
  setStore('askCodeProvider', provider);
  // Model names do not carry across providers — a Claude alias is not a Codex
  // slug — so the new provider starts on its own default until one is picked.
  setStore('askCodeModel', defaultAskCodeModel(provider));
}

export function setAskCodeModel(model: string): void {
  setStore('askCodeModel', model);
}

/** Remembers a reasoning level per provider; an empty level returns to the CLI default. */
export function setAskCodeEffort(provider: AskCodeProvider, effort: string): void {
  // An undefined value deletes the key, so a cleared level is not saved.
  setStore('askCodeEffort', provider, effort || undefined);
}

export function setMinimaxApiKey(key: string): void {
  invoke(IPC.SetMinimaxApiKey, { key: key.trim() }).catch((e) =>
    console.warn('Failed to set MiniMax API key:', e),
  );
}

export function setDockerAvailable(available: boolean): void {
  setStore('dockerAvailable', available);
}

export function setShareDockerAgentAuth(enabled: boolean): void {
  setStore('shareDockerAgentAuth', enabled);
}

export function setDocumentWorkspacesEnabled(enabled: boolean): void {
  setStore('documentWorkspacesEnabled', enabled);
  if (!enabled) setStore('activeDocumentProjectId', null);
}

export function setDocumentFullWidth(fullWidth: boolean): void {
  setStore('documentFullWidth', fullWidth);
}

export function toggleArena(show?: boolean): void {
  setStore('showArena', show ?? !store.showArena);
}

/** Opens the thinking space on its list, or on a new blank tour; null closes it. */
export function openThinkingSpace(mode: 'list' | 'new' | null): void {
  setStore('thinkingSpace', mode);
}

export function toggleFocusMode(on?: boolean): void {
  setStore('focusMode', on ?? !store.focusMode);
}

export function toggleTaskFocusMode(taskId: string | null = store.activeTaskId): void {
  const isDocument =
    store.activeDocumentProjectId && taskId === documentAgentTaskId(store.activeDocumentProjectId);
  if (!taskId || (!store.tasks[taskId] && !isDocument)) return;
  // From the board's side panel the button expands the task into focus mode.
  const enteringFocusMode = !store.focusMode || store.boardView;
  if (store.activeTaskId !== taskId) setActiveTask(taskId);
  closeBoard();
  toggleFocusMode(enteringFocusMode);
  // An open draft is what focus mode shows; it keeps its own focus.
  if (!enteringFocusMode || store.showNewTaskPanel) return;
  const panel = store.focusedPanel[taskId] ?? 'ai-terminal';
  requestAnimationFrame(() => setTaskFocusedPanel(taskId, panel));
}

export type WorkspaceView = 'focus' | 'tiles' | 'board';

/** The view the workspace toggle shows as pressed; the board covers the other two. */
export function workspaceView(): WorkspaceView {
  if (store.boardView) return 'board';
  return store.focusMode ? 'focus' : 'tiles';
}

/** View-transition types for switching to `next`. Tiles and focus share one
 *  layout strip, so between them the active task can grow into focus and
 *  shrink back; the board and pages have their own transitions. */
export function workspaceViewTransitionTypes(next: WorkspaceView): string[] {
  const current = workspaceView();
  if (current === next || current === 'board' || next === 'board' || projectPageOpen()) return [];
  // Without a task focus stays on tiles; animating would only shimmer the tiles.
  if (next === 'focus' && !store.activeTaskId) return [];
  return [next === 'focus' ? 'focus-enter' : 'focus-exit'];
}

/** Shows one of the three workspace views, closing any page that covers them. */
export function setWorkspaceView(view: WorkspaceView): void {
  batch(() => {
    closeProjectPages();
    if (view === 'board') {
      setStore('boardView', true);
      return;
    }
    closeBoard();
    // Focus mode needs a task to show; without one this stays on tiles.
    if ((view === 'focus') !== store.focusMode) toggleTaskFocusMode();
  });
}

/** Opens the board, or returns to the focus or tiles view it covered. */
export function toggleBoardView(): void {
  if (store.boardView) closeBoard();
  else setWorkspaceView('board');
}

export function setTaskSplitMode(taskId: string, active: boolean): void {
  if (!!store.taskSplitMode[taskId] === active) return;
  setStore('taskSplitMode', taskId, active);
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
