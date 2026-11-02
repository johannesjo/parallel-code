import { GitHubIssuesPage } from './components/GitHubIssuesPage';
import { KanbanPage } from './components/KanbanPage';
import { TaskBoard } from './components/TaskBoard';
import { openBesideBoard } from './components/board/TaskStatus';
import { navigateBoard, navigateBoardTask } from './components/task-board-keys';
import { openNextAttentionTask, openPreviousAttentionTask } from './components/next-attention-task';
import {
  BoardSidePanelClose,
  BoardSidePanelHandle,
  boardSidePanelBasis,
  closeSidePanel,
} from './components/BoardSidePanel';
import {
  boardCoversWorkspace,
  boardShown,
  boardSidePanelOpen,
  closeBoard,
  projectPageOpen,
} from './store/project-pages';
import '@xterm/xterm/css/xterm.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/sora/400.css';
import '@fontsource/sora/500.css';
import '@fontsource/sora/600.css';
import '@fontsource/sora/700.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';
import {
  onMount,
  onCleanup,
  createEffect,
  Show,
  ErrorBoundary,
  createSignal,
  createMemo,
  lazy,
} from 'solid-js';
import { invoke } from './lib/ipc';
import { IPC } from '../electron/ipc/channels';
import { appWindow } from './lib/window';
import { startWindowVisibilityTracking } from './lib/windowVisibility';
import { choice } from './lib/dialog';
import { CLOSE_DIALOG_BUTTONS, resolveCloseChoice } from './lib/close-decision';
import { resolvePanelCloseTarget } from './store/close-target';
import { Sidebar } from './components/Sidebar';
import { TilingLayout } from './components/TilingLayout';
import { HelpDialog } from './components/HelpDialog';
import { IdeaDialog, toggleIdeaDialog } from './components/IdeaDialog';
import { TaskSwitcher } from './components/TaskSwitcher';
import { SettingsDialog } from './components/SettingsDialog';
import { WorkspaceControls } from './components/WorkspaceControls';
import { WindowTitleBar } from './components/WindowTitleBar';
import { TaskBoardControls } from './components/TaskBoardControls';
import { FocusModeTaskIndicators } from './components/FocusModeTaskIndicators';
import { UsageStatusBar } from './components/UsageStatusBar';
import { WelcomeScreen } from './components/WelcomeScreen';
import { linkButtonStyle, theme } from './lib/theme';
import * as log from './lib/log';
import {
  store,
  loadAgents,
  loadState,
  isStateLoaded,
  saveState,
  toggleNewTaskPanel,
  toggleSidebar,
  toggleArena,
  moveActiveTask,
  jumpToTask,
  adjustGlobalScale,
  resetGlobalScale,
  startTaskStatusPolling,
  stopTaskStatusPolling,
  startUsagePolling,
  stopUsagePolling,
  navigateRow,
  navigateColumn,
  navigateTask,
  setPendingAction,
  toggleHelpDialog,
  toggleSettingsDialog,
  openThinkingSpace,
  sendActivePrompt,
  spawnShellForTask,
  closeShell,
  clearNotification,
  notificationAction,
  setWindowState,
  createTerminal,
  closeTerminal,
  setNewTaskDropUrl,
  validateProjectPaths,
  setPlanContent,
  setDockerAvailable,
  setWorkspaceView,
  toggleBoardView,
  workspaceView,
  workspaceViewTransitionTypes,
  toggleFocusMode,
  initMCPListeners,
  markTaskMcpPending,
  applyTaskMcpLaunchResult,
  markTaskMcpError,
  getProject,
  triggerAction,
} from './store/store';
import { isGitHubUrl } from './lib/github-url';
import { isClaudeSessionUrl } from './lib/claude-session-url';
import { getDeepActiveElement } from './lib/dom-focus';
import { HoldToQuit } from './components/HoldToQuit';
import type { PersistedWindowState } from './store/types';
import {
  initShortcuts,
  registerFromRegistry,
  registerJumpToTaskShortcuts,
  registerZoomShortcuts,
} from './lib/shortcuts';
import {
  allBindings,
  resolvedBindings,
  loadKeybindings,
  dismissMigrationBanner,
} from './store/keybindings';
import { switcherActions } from './lib/switcher-actions';
import { openItemName } from './store/navigation';
import { setupAutosave } from './store/autosave';
import { buildCustomThemeCss } from './lib/custom-theme';
import { osIsDark } from './lib/os-appearance';
import { applyAppearanceMode, markCustomThemesReady, loadCustomThemes } from './store/store';
import { isMac } from './lib/platform';
import { createCtrlWheelZoomHandler } from './lib/wheelZoom';
import { redrawAllTerminals } from './lib/terminalFitManager';
import { withViewTransition } from './lib/viewTransition';
import { isDocumentAgentTaskId } from './documents/agent-task';
import { isHiddenAgentTaskId } from './documents/task-id';
import {
  closeDocumentReview,
  closeDocumentWorkspace,
  inlineReview,
  initDocumentListeners,
  setDocumentComposerDraft,
  setDocumentSelection,
} from './documents/store';
import { closeTopCompareForm, dismissPinnedBubbles, setFilesOpen } from './documents/workspace-ui';
import { resetForNewMatch } from './arena/store';
import { startDesktopNotificationWatcher } from './store/desktopNotifications';
import { startSuperProductivitySync, startSpOpenListener } from './store/store';
import { startBackgroundTaskWatcher } from './store/background-tasks';
import { startTaskBriefWatcher } from './store/task-brief';
import { showPlanTasks, startKanbanAutomation } from './store/kanban';
import { startPrChecksSubscription } from './store/pr-checks';
import { startPrBabysitWatcher } from './store/pr-babysit';
import { restartApp, startUpdateSubscription } from './store/updates';
import { isStaleBuildError } from './lib/stale-build';
import { startRemoteTaskHandlers } from './store/remoteTaskHandler';
import { startRemoteStatusSync } from './store/remoteStatusSync';
import { startAgentHookStatusListener } from './store/agentHookStatus';
import { applyPlanContent } from './store/canvas';
import { startBackgroundChecks } from './store/background-checks';
import type { PlanContentMessage } from './store/canvas';
import { CircleCheckIcon, GitHubMarkIcon, SyncIcon } from './components/icons';

const ThinkingSpace = lazy(() =>
  import('./components/thinking/ThinkingSpace').then((m) => ({ default: m.ThinkingSpace })),
);
const ArenaOverlay = lazy(() =>
  import('./arena/ArenaOverlay').then((m) => ({ default: m.ArenaOverlay })),
);

const MIN_WINDOW_DIMENSION = 100;

function DropOverlay() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: '0',
        background: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        'flex-direction': 'column',
        'align-items': 'center',
        'justify-content': 'center',
        gap: '16px',
        'z-index': '9999',
        'pointer-events': 'none',
        'backdrop-filter': 'blur(4px)',
      }}
    >
      {/* Drag events hide the link until drop, so both kinds are announced. */}
      <div style={{ display: 'flex', gap: '24px' }}>
        <GitHubMarkIcon size={48} style={{ color: theme.accent, opacity: '0.9' }} />
        <svg width="48" height="48" viewBox="0 0 24 24" fill="#D97757" style={{ opacity: '0.9' }}>
          <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
        </svg>
      </div>
      <span
        style={{
          color: theme.fg,
          'font-size': '17px',
          'font-weight': '600',
          'font-family': 'var(--font-ui)',
        }}
      >
        Drop a GitHub or Claude session link to create a task
      </span>
      <span
        style={{
          color: theme.fgMuted,
          'font-size': '13px',
          'font-family': 'var(--font-ui)',
        }}
      >
        GitHub links prefill a review; Claude session links teleport
      </span>
    </div>
  );
}

const WELCOME_ACTIONS = new Set([
  'toggleHelp',
  'toggleSettings',
  'closeDialogs',
  'zoomIn',
  'zoomOut',
  'resetZoom',
]);

function App() {
  let mainRef!: HTMLDivElement;
  const [windowFocused, setWindowFocused] = createSignal(true);
  const [windowMaximized, setWindowMaximized] = createSignal(false);
  const [showDropOverlay, setShowDropOverlay] = createSignal(false);
  const [closeHandlerReady, setCloseHandlerReady] = createSignal(false);
  const [taskSwitcherOpen, setTaskSwitcherOpen] = createSignal(false);
  const [stateLoaded, setStateLoaded] = createSignal(false);
  const [stateRestored, setStateRestored] = createSignal(false);
  // A new install sees only the welcome screen, whatever view is selected; and
  // nothing flashes up before the saved state says whether it is one. An
  // unreadable state is no first run: its projects would not be saved.
  const welcome = () => stateRestored() && store.projects.length === 0;
  // The welcome screen hides the workspace; only shortcuts that open their own UI work there.
  const fitsScreen = (binding: { action?: string }) =>
    !welcome() || (binding.action !== undefined && WELCOME_ACTIONS.has(binding.action));
  // A document workspace's hidden agent task can be the active one; it has
  // no worktree to close, merge or push and no panel a shell could show in.
  const listedTask = (id: string) =>
    !projectPageOpen() && store.tasks[id] !== undefined && !isHiddenAgentTaskId(id);
  // Filled in on mount; the switcher only runs actions after that.
  let actionHandlers: Record<string, (e: KeyboardEvent) => void> = {};
  // The same actions the shortcuts reach right now, unbound ones included,
  // less those whose handler would do nothing without an active item.
  const paletteActions = createMemo(() => {
    const id = store.activeTaskId;
    return switcherActions(allBindings().filter(fitsScreen), {
      activeName: id && !projectPageOpen() ? openItemName(id) : null,
      taskActive: id !== null && listedTask(id),
      documentOpen: store.activeDocumentProjectId !== null && isDocumentAgentTaskId(id),
    });
  });
  const bare = () => !stateLoaded() || welcome();
  let dragCounter = 0;

  function closeArena() {
    void resetForNewMatch();
    toggleArena(false);
  }

  // GitHub links prefill a review; Claude web session links teleport.
  const isTaskSourceUrl = (url: string) => isGitHubUrl(url) || isClaudeSessionUrl(url);

  function extractDroppedUrl(dt: DataTransfer): string | null {
    const uriList = dt.getData('text/uri-list');
    if (uriList) {
      const firstUrl = uriList
        .split('\n')
        .find((l) => !l.startsWith('#'))
        ?.trim();
      if (firstUrl && isTaskSourceUrl(firstUrl)) return firstUrl;
    }
    const text = dt.getData('text/plain')?.trim();
    if (text && isTaskSourceUrl(text)) return text;
    return null;
  }

  // Can't inspect data during dragenter/dragover — only check types exist.
  // Exclude file drags (OS file manager, desktop icons) to avoid false positives.
  function mayContainUrl(dt: DataTransfer): boolean {
    if (dt.types.includes('Files')) return false;
    return dt.types.includes('text/uri-list') || dt.types.includes('text/plain');
  }

  function handleDragEnter(e: DragEvent) {
    if (!e.dataTransfer || !mayContainUrl(e.dataTransfer)) return;
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) setShowDropOverlay(true);
  }

  function handleDragOver(e: DragEvent) {
    if (!showDropOverlay()) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function handleDragLeave(_e: DragEvent) {
    if (!showDropOverlay()) return;
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      setShowDropOverlay(false);
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragCounter = 0;
    setShowDropOverlay(false);
    if (!e.dataTransfer) return;
    const url = extractDroppedUrl(e.dataTransfer);
    if (!url) return;
    setNewTaskDropUrl(url);
    toggleNewTaskPanel(true);
  }

  let unlistenFocusChanged: (() => void) | null = null;
  let unlistenResized: (() => void) | null = null;
  let unlistenMoved: (() => void) | null = null;

  const syncWindowFocused = async () => {
    const focused = await appWindow.isFocused().catch(() => true);
    setWindowFocused(focused);
  };

  const syncWindowMaximized = async () => {
    const maximized = await appWindow.isMaximized().catch(() => false);
    setWindowMaximized(maximized);
  };

  const readWindowGeometry = async (): Promise<Omit<PersistedWindowState, 'maximized'> | null> => {
    const [position, size] = await Promise.all([
      appWindow.outerPosition().catch(() => null),
      appWindow.outerSize().catch(() => null),
    ]);

    if (!position || !size) return null;
    if (size.width < MIN_WINDOW_DIMENSION || size.height < MIN_WINDOW_DIMENSION) return null;

    return {
      x: Math.round(position.x),
      y: Math.round(position.y),
      width: Math.round(size.width),
      height: Math.round(size.height),
    };
  };

  const captureWindowState = async (): Promise<void> => {
    const maximized = await appWindow.isMaximized().catch(() => false);
    const current = store.windowState;

    if (maximized && current) {
      if (!current.maximized) {
        setWindowState({ ...current, maximized: true });
      }
      return;
    }

    const geometry = await readWindowGeometry();
    if (!geometry) return;

    setWindowState({ ...geometry, maximized });
  };

  const restoreWindowState = async (): Promise<void> => {
    const saved = store.windowState;
    if (!saved) return;
    if (saved.width < MIN_WINDOW_DIMENSION || saved.height < MIN_WINDOW_DIMENSION) return;

    await appWindow.unmaximize().catch(() => {});
    await appWindow.setSize({ width: saved.width, height: saved.height }).catch(() => {});
    await appWindow.setPosition({ x: saved.x, y: saved.y }).catch(() => {});

    if (saved.maximized) {
      await appWindow.maximize().catch(() => {});
    }

    void syncWindowMaximized();
  };

  // Re-derive effective theme whenever OS dark mode or appearance mode/slots change
  createEffect(() => {
    osIsDark(); // reactive dependency
    applyAppearanceMode();
  });

  // Sync theme to <html> so Portal content (dialogs, tooltips) inherits CSS variables.
  // data-look always holds the base preset so structural rules (islands, workbench, etc.)
  // continue to apply. data-custom-theme overlays color variables when a custom theme is active.
  createEffect(() => {
    document.documentElement.dataset.look = store.themePreset;
    const customId = store.activeCustomThemeId;
    if (customId) {
      document.documentElement.dataset.customTheme = customId;
    } else {
      delete document.documentElement.dataset.customTheme;
    }
  });

  // Inject/update custom theme CSS into a dedicated <style> tag
  createEffect(() => {
    const customId = store.activeCustomThemeId;
    let styleEl = document.getElementById('custom-theme-style') as HTMLStyleElement | null;
    if (!customId) {
      if (styleEl) styleEl.textContent = '';
      return;
    }
    const theme = store.customThemes[customId];
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'custom-theme-style';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = theme ? buildCustomThemeCss(theme) : '';
  });

  // Toggle font smoothing CSS class on body
  createEffect(() => {
    document.body.classList.toggle('font-smoothing', store.fontSmoothing);
  });

  // Apply zoom via Electron's webFrame so window.devicePixelRatio scales with it.
  // CSS transform: scale() does not affect devicePixelRatio, so canvas-based renderers
  // (xterm.js WebGL) would render at insufficient pixel density and look blurry.
  // webFrame.setZoomFactor() raises devicePixelRatio proportionally, triggering
  // xterm's ScreenDprMonitor to re-render at the correct resolution.
  createEffect(() => {
    window.electron.setZoomFactor(store.globalScale);
  });

  // Sync the renderer logger's verbose state with the persisted setting.
  createEffect(() => {
    log.setVerbose(store.verboseLogging);
  });

  onMount(async () => {
    // Before the first await: restored agents start firing hooks as soon as
    // loadState spawns them, and IPC does not replay what nobody listened to.
    const stopMCPListeners = initMCPListeners();
    const stopAgentHookStatusListener = startAgentHookStatusListener();
    const stopBackgroundChecks = startBackgroundChecks();
    // Listen for plan content pushed from backend plan watcher
    const offPlanContent = window.electron.ipcRenderer.on(IPC.PlanContent, (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      applyPlanContent(data as PlanContentMessage);
    });

    const stopDocumentListeners = initDocumentListeners();
    const stopWindowVisibilityTracking = startWindowVisibilityTracking();
    void syncWindowFocused();
    void syncWindowMaximized();

    void (async () => {
      try {
        unlistenFocusChanged = await appWindow.onFocusChanged((event) => {
          const focused = Boolean(event.payload);
          setWindowFocused(focused);
          // The compositor can throttle the window's WebGL surface while it's
          // backgrounded, leaving a corrupt glyph atlas (issue #121). Repaint
          // every terminal on refocus so the corruption clears reliably.
          // macOS-only: the corruption has never been reported on Linux, so
          // Linux users don't pay the per-refocus repaint. The manual
          // redrawTerminals shortcut stays cross-platform as an escape hatch.
          if (focused && isMac) redrawAllTerminals();
        });
      } catch {
        unlistenFocusChanged = null;
      }

      try {
        let resizeTimer: ReturnType<typeof setTimeout> | undefined;
        unlistenResized = await appWindow.onResized(() => {
          if (resizeTimer !== undefined) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            resizeTimer = undefined;
            void syncWindowMaximized();
            void captureWindowState();
          }, 200);
        });
      } catch {
        unlistenResized = null;
      }

      let moveTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        unlistenMoved = await appWindow.onMoved(() => {
          if (moveTimer !== undefined) clearTimeout(moveTimer);
          moveTimer = setTimeout(() => {
            moveTimer = undefined;
            void captureWindowState();
          }, 200);
        });
      } catch {
        unlistenMoved = null;
      }
    })();

    await loadAgents();
    invoke<boolean>(IPC.CheckDockerAvailable).then(
      (available) => setDockerAvailable(available),
      () => setDockerAvailable(false),
    );
    try {
      await loadState();
    } finally {
      setStateRestored(isStateLoaded());
      setStateLoaded(true);
    }
    const themesLoaded = await loadCustomThemes();
    // Only unlock slot-ID sanitization when the IPC call succeeded. On failure
    // customThemes remains {} and we must not null out the user's persisted selections.
    if (themesLoaded) markCustomThemesReady();
    await loadKeybindings();

    // Rewrite MCP config files for persisted coordinator tasks so the new
    // session's port/token are in effect before any agent resumes.
    // Docker coordinator tasks have no persisted mcpConfigPath (their .mcp.json
    // lives in the worktree, not a temp file), but they still need StartMCPServer
    // called so the remote server starts and the container name is registered.
    const mcpRestorePromises: Promise<unknown>[] = [];
    for (const taskId of [...store.taskOrder, ...store.collapsedTaskOrder]) {
      const task = store.tasks[taskId];
      if (!task?.coordinatorMode) continue;
      const projectRoot = store.projects.find((p) => p.id === task.projectId)?.path;
      if (!projectRoot) continue;
      const agentDef = task.agentIds[0] ? store.agents[task.agentIds[0]]?.def : undefined;
      // Reconstruct Docker container name from the coordinator's PTY agent id.
      // The container may be dead after restart, but this wires up docker exec for sub-tasks
      // when the user manually restarts the coordinator agent.
      const dockerContainerName =
        task.dockerMode && task.agentIds[0]
          ? `parallel-code-${task.agentIds[0].slice(0, 12)}`
          : undefined;
      markTaskMcpPending(taskId);
      mcpRestorePromises.push(
        invoke<{ mcpLaunchArgs?: string[] }>(IPC.StartMCPServer, {
          coordinatorTaskId: task.id,
          projectId: task.projectId,
          projectRoot,
          coordinatorBranch: task.branchName || undefined,
          worktreePath: task.gitIsolation === 'worktree' ? task.worktreePath : undefined,
          skipPermissions: task.skipPermissions ?? false,
          propagateSkipPermissions: task.propagateSkipPermissions ?? false,
          maxConcurrentTasks: task.maxConcurrentTasks,
          verifyCommand: getProject(task.projectId)?.verifyCommand,
          agentCommand: agentDef?.command ?? 'claude',
          agentArgs: agentDef?.args ?? [],
          agentEnvFile: agentDef ? store.agentEnvFiles[agentDef.id] : undefined,
          dockerContainerName,
          dockerImage: task.dockerMode ? task.dockerImage : undefined,
        })
          .then((result) => {
            applyTaskMcpLaunchResult(taskId, result);
          })
          .catch((err) => {
            console.warn(`[MCP] Failed to restore MCP server for coordinator task ${taskId}:`, err);
            markTaskMcpError(taskId, String(err));
          }),
      );
    }
    // Wait for all coordinators to register before hydrating their children —
    // hydrateTask() needs the coordinator entry to exist in the backend registry.
    await Promise.allSettled(mcpRestorePromises);

    // Hydrate backend coordinator task registry with persisted child tasks so MCP
    // tools (list_tasks, send_prompt, close_task, etc.) work after app restart.
    const hydratePromises: Promise<void>[] = [];
    for (const taskId of [...store.taskOrder, ...store.collapsedTaskOrder]) {
      const task = store.tasks[taskId];
      if (!task?.coordinatedBy) continue;
      if (
        task.landingState === 'landed_pending_review' ||
        task.landingState === 'landed_cleanup_failed' ||
        task.landingState === 'reviewed'
      )
        continue;
      // Skip if coordinator restore failed — hydrating into a broken coordinator leaves
      // children with stale MCP wiring and misleading 'ready' status.
      const parent = store.tasks[task.coordinatedBy];
      if (!parent || (parent.coordinatorMode && parent.mcpStartupStatus !== 'ready')) continue;
      const projectRoot = store.projects.find((p) => p.id === task.projectId)?.path;
      if (!projectRoot) continue;
      markTaskMcpPending(task.id);
      hydratePromises.push(
        invoke<{ mcpLaunchArgs?: string[] }>(IPC.MCP_HydrateCoordinatedTask, {
          id: task.id,
          name: task.name,
          projectId: task.projectId,
          projectRoot,
          branchName: task.branchName,
          baseBranch: task.baseBranch,
          worktreePath: task.worktreePath,
          coordinatorTaskId: task.coordinatedBy,
          integrationPolicy: task.integrationPolicy,
          controlledBy: task.controlledBy,
          agentId: task.agentIds[0],
          completion: task.completion,
          reviewRevision: task.reviewRevision,
          signalDoneAt: task.signalDoneAt,
          signalDoneConsumed: task.signalDoneConsumed,
          verification: task.verification,
          landingState: task.landingState,
          landingReason: task.landingReason,
          landingSummary: task.landingSummary,
          landedMetadata: task.landedMetadata,
          mcpConfigPath: task.mcpConfigPath,
          agentCommand: store.agents[task.agentIds[0]]?.def.command ?? 'claude',
          preambleFileExistedBefore: task.preambleFileExistedBefore,
          initialPrompt: task.initialPrompt,
        })
          .then((result) => {
            applyTaskMcpLaunchResult(task.id, result);
          })
          .catch((err) => {
            console.warn(`[MCP] Failed to hydrate coordinated task ${taskId}:`, err);
            markTaskMcpError(task.id, String(err));
          }),
      );
    }
    await Promise.allSettled(hydratePromises);

    // Restore plan content for tasks that had a plan file before restart
    for (const taskId of [...store.taskOrder, ...store.collapsedTaskOrder]) {
      const task = store.tasks[taskId];
      if (!task?.worktreePath || !task.planFileName) continue;
      invoke<{ content: string; fileName: string; relativePath: string } | null>(
        IPC.ReadPlanContent,
        { worktreePath: task.worktreePath, fileName: task.planFileName },
      )
        .then((result) => {
          if (result) setPlanContent(taskId, result.content, result.fileName, result.relativePath);
        })
        .catch((err) => {
          console.warn(`Failed to restore plan for task ${taskId}:`, err);
        });
    }

    await validateProjectPaths();
    await restoreWindowState();
    await captureWindowState();
    setupAutosave();
    startTaskStatusPolling();
    startUsagePolling();

    const stopNotificationWatcher = startDesktopNotificationWatcher(windowFocused);
    const stopSuperProductivitySync = startSuperProductivitySync(windowFocused);
    const stopSpOpenListener = startSpOpenListener();
    const stopBackgroundTaskWatcher = startBackgroundTaskWatcher();
    const stopTaskBriefWatcher = startTaskBriefWatcher();
    const stopKanbanAutomation = startKanbanAutomation();
    const stopPrChecksSubscription = startPrChecksSubscription();
    const stopPrBabysitWatcher = startPrBabysitWatcher();
    const stopUpdateSubscription = startUpdateSubscription();
    const stopRemoteTaskHandlers = startRemoteTaskHandlers();
    const stopRemoteStatusSync = startRemoteStatusSync();

    const handlePaste = (e: ClipboardEvent) => {
      if (store.showNewTaskPanel || store.showHelpDialog || store.showSettingsDialog) return;
      const el = getDeepActiveElement();
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable) ||
        el?.closest?.('.xterm')
      ) {
        return;
      }
      const text = e.clipboardData?.getData('text/plain')?.trim();
      if (text && isTaskSourceUrl(text)) {
        e.preventDefault();
        setNewTaskDropUrl(text);
        toggleNewTaskPanel(true);
      }
    };
    document.addEventListener('paste', handlePaste);

    const handleBeforeUnload = () => {
      void saveState();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    const handleWheel = createCtrlWheelZoomHandler((delta) => adjustGlobalScale(delta));
    mainRef.addEventListener('wheel', handleWheel, { passive: false });

    const cleanupShortcuts = initShortcuts();
    let allowClose = false;
    let handlingClose = false;
    const unlistenCloseRequested = await appWindow.onCloseRequested(async (event) => {
      await captureWindowState();
      await saveState();

      if (allowClose) return;
      if (handlingClose) {
        event.preventDefault();
        return;
      }

      const runningCount = await invoke<number>(IPC.CountRunningAgents).catch(() => 0);
      if (runningCount <= 0) return;

      event.preventDefault();
      handlingClose = true;
      try {
        const countLabel =
          runningCount === 1
            ? '1 running terminal session'
            : `${runningCount} running terminal sessions`;
        const selected = await choice(
          `You have ${countLabel}. They can be restored on app restart. Kill them and quit, keep them alive in the background, or cancel?`,
          {
            title: 'Running Terminals',
            kind: 'warning',
            buttons: [...CLOSE_DIALOG_BUTTONS],
            defaultId: 2,
            cancelId: 2,
          },
        ).catch(() => 2);

        const action = resolveCloseChoice(selected);
        if (action === 'kill') {
          await invoke(IPC.KillAllAgents).catch(console.error);
          allowClose = true;
          await appWindow.close().catch(console.error);
          return;
        }
        if (action === 'background') {
          await appWindow.hide().catch(console.error);
        }
        // 'abort': close already prevented above — leave the window open.
      } finally {
        handlingClose = false;
      }
    });
    setCloseHandlerReady(true);

    actionHandlers = {
      // The board takes these first while it, rather than its side panel, has the keyboard.
      'navigateRow:up': () => navigateBoard('up') || navigateRow('up'),
      'navigateRow:down': () => navigateBoard('down') || navigateRow('down'),
      'navigateColumn:left': () => navigateBoard('left') || navigateColumn('left'),
      'navigateColumn:right': () => navigateBoard('right') || navigateColumn('right'),
      'navigateTask:left': () => navigateBoardTask('left') || navigateTask('left'),
      'navigateTask:right': () => navigateBoardTask('right') || navigateTask('right'),
      'navigateBoardTask:up': () => navigateBoardTask('up'),
      'navigateBoardTask:down': () => navigateBoardTask('down'),
      'moveActiveTask:left': () => moveActiveTask('left'),
      'moveActiveTask:right': () => moveActiveTask('right'),
      ...Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [`jumpToTask:${i + 1}`, () => jumpToTask(i)]),
      ),
      closeShell: (e) => {
        if (projectPageOpen()) return;
        // Auto-repeat would walk through adjacent terminals or canvas tabs.
        if (e.repeat) return;
        const target = resolvePanelCloseTarget(store);
        if (!target) return;
        if (target.kind === 'terminal') closeTerminal(target.terminalId);
        else if (target.kind === 'shell') closeShell(target.taskId, target.shellId);
        else triggerAction(`${target.taskId}:close-canvas-active-tab`);
      },
      closeTask: () => {
        if (projectPageOpen()) return;
        const id = store.activeTaskId;
        if (!id) return;
        if (store.terminals[id]) {
          closeTerminal(id);
          return;
        }
        if (isDocumentAgentTaskId(id)) {
          closeDocumentWorkspace();
          return;
        }
        if (listedTask(id)) setPendingAction({ type: 'close', taskId: id });
      },
      finishTask: () => {
        const id = store.activeTaskId;
        if (id && listedTask(id)) setPendingAction({ type: 'finish', taskId: id });
      },
      createPullRequest: () => {
        const id = store.activeTaskId;
        if (id && listedTask(id)) setPendingAction({ type: 'create-pr', taskId: id });
      },
      spawnShell: () => {
        const id = store.activeTaskId;
        if (id && listedTask(id)) spawnShellForTask(id);
      },
      secondOpinion: (e) => {
        const id = store.activeTaskId;
        if (!e.repeat && id && listedTask(id)) triggerAction(`${id}:second-opinion`);
      },
      sendPrompt: () => {
        if (!projectPageOpen()) sendActivePrompt();
      },
      createTerminal: (e) => {
        if (e.repeat) return;
        // On the board the new terminal opens in its side panel, not the tiled view.
        if (boardShown()) openBesideBoard(null, createTerminal);
        else createTerminal();
      },
      newTask: () => withViewTransition(() => toggleNewTaskPanel(true)),
      addIdea: () => toggleIdeaDialog(),
      toggleSidebar: () => toggleSidebar(),
      toggleFocusMode: () => {
        const next = workspaceView() === 'focus' ? 'tiles' : 'focus';
        withViewTransition(() => setWorkspaceView(next), workspaceViewTransitionTypes(next));
      },
      toggleBoardView: () => withViewTransition(toggleBoardView),
      openNextAttentionTask: () => openNextAttentionTask(),
      openPreviousAttentionTask: () => openPreviousAttentionTask(),
      switchDocument: () => {
        if (store.activeDocumentProjectId && isDocumentAgentTaskId(store.activeTaskId))
          setFilesOpen(true);
      },
      toggleHelp: () => toggleHelpDialog(),
      openTaskSwitcher: () => setTaskSwitcherOpen(true),
      toggleSettings: () => toggleSettingsDialog(),
      newThinkingTour: () => openThinkingSpace('new'),
      closeDialogs: () => {
        if (store.showArena) {
          closeArena();
          return;
        }
        if (store.activeDocumentProjectId && isDocumentAgentTaskId(store.activeTaskId)) {
          // A pinned note covers the prose and goes first. Then an inline
          // proposal review, left undecided (its open refine form first).
          // Then the composer, up with a passage or with a draft opened from
          // the toolbar or a note. Escape never closes the workspace itself: it is a full
          // view, and a stray press would throw away the reading position.
          if (dismissPinnedBubbles()) return;
          if (inlineReview()) {
            if (!closeTopCompareForm()) closeDocumentReview();
            return;
          }
          setDocumentSelection(null);
          setDocumentComposerDraft(null);
          return;
        }
        if (store.showHelpDialog) {
          toggleHelpDialog(false);
          return;
        }
        if (store.showSettingsDialog) {
          toggleSettingsDialog(false);
          return;
        }
        // The workspace behind the welcome screen stays as it is.
        if (welcome()) return;
        // The board covers focus mode, so it closes first, its side panel
        // before it. A draft in the side panel handles Escape itself.
        if (boardShown()) {
          if (store.showNewTaskPanel) return;
          if (store.boardPeek) closeSidePanel();
          // A plan steps back to its project's running tasks before the board closes.
          else if (store.kanbanProjectId) withViewTransition(showPlanTasks);
          // closeBoard, not a toggle: the update runs a frame later, so a
          // repeated Escape would otherwise reopen the board.
          else withViewTransition(closeBoard);
          return;
        }
        // Not global, so an Escape typed into the agent terminal still
        // reaches the agent instead of leaving focus mode. Exits directly:
        // toggleTaskFocusMode ignores a standalone terminal as the active item.
        // The new-task draft and project pages cover the focused task; leave it for
        // when they close rather than flipping it unseen.
        if (store.focusMode && !store.showNewTaskPanel && !projectPageOpen()) {
          withViewTransition(() => toggleFocusMode(false), workspaceViewTransitionTypes('tiles'));
        }
      },
      zoomIn: () => adjustGlobalScale(1),
      zoomOut: () => adjustGlobalScale(-1),
      resetZoom: () => resetGlobalScale(),
      redrawTerminals: () => redrawAllTerminals(),
    };

    const cleanupZoomShortcuts = registerZoomShortcuts({
      zoomIn: () => adjustGlobalScale(1),
      resetZoom: () => resetGlobalScale(),
    });

    const cleanupJumpToTaskShortcuts = registerJumpToTaskShortcuts((i) => jumpToTask(i));

    // Shortcuts always swallow their keys, so the board's own ones exist only
    // while it is shown; Alt+PageUp/PageDown stay with terminals otherwise.
    const boardOnly = (binding: { action?: string }) =>
      binding.action?.startsWith('navigateBoardTask:') === true;
    createEffect(() => {
      const bindings = resolvedBindings().filter(
        (binding) => !boardOnly(binding) && fitsScreen(binding),
      );
      onCleanup(registerFromRegistry(bindings, actionHandlers));
    });
    createEffect(() => {
      if (!boardShown()) return;
      onCleanup(registerFromRegistry(resolvedBindings().filter(boardOnly), actionHandlers));
    });

    onCleanup(() => {
      document.removeEventListener('paste', handlePaste);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      mainRef.removeEventListener('wheel', handleWheel);
      unlistenCloseRequested();
      cleanupShortcuts();
      stopTaskStatusPolling();
      stopUsagePolling();
      stopMCPListeners();
      stopNotificationWatcher();
      stopSuperProductivitySync();
      stopSpOpenListener();
      stopBackgroundTaskWatcher();
      stopTaskBriefWatcher();
      stopKanbanAutomation();
      stopPrChecksSubscription();
      stopPrBabysitWatcher();
      stopUpdateSubscription();
      stopRemoteTaskHandlers();
      stopRemoteStatusSync();
      stopAgentHookStatusListener();
      stopBackgroundChecks();
      stopDocumentListeners();
      stopWindowVisibilityTracking();
      offPlanContent();
      unlistenFocusChanged?.();
      unlistenResized?.();
      unlistenMoved?.();
      cleanupZoomShortcuts();
      cleanupJumpToTaskShortcuts();
    });
  });

  return (
    <ErrorBoundary
      fallback={(err, reset) => {
        const stale = isStaleBuildError(err);
        return (
          <div
            style={{
              width: '100vw',
              height: '100vh',
              display: 'flex',
              'flex-direction': 'column',
              'align-items': 'center',
              'justify-content': 'center',
              gap: '16px',
              background: theme.bg,
              color: theme.fg,
              'font-family': "var(--font-ui, 'Sora', sans-serif)",
            }}
          >
            <div
              style={{
                'font-size': '19px',
                'font-weight': '600',
                color: stale ? theme.fg : theme.error,
              }}
            >
              {stale ? 'Parallel Code was updated' : 'Something went wrong'}
            </div>
            <div
              style={{
                'max-width': '500px',
                'text-align': 'center',
                color: theme.fgMuted,
                'word-break': 'break-word',
              }}
            >
              {stale
                ? 'A newer version was installed while the app was running. Restart to load it.'
                : String(err)}
            </div>
            <button
              class="btn-with-icon"
              onClick={() => (stale ? restartApp() : reset())}
              style={{
                background: theme.bgElevated,
                border: `1px solid ${theme.border}`,
                color: theme.fg,
                padding: '8px 24px',
                'border-radius': 'var(--radius-md)',
                cursor: 'pointer',
                'font-size': '15px',
              }}
            >
              <SyncIcon size={14} />
              {stale ? 'Restart' : 'Reload'}
            </button>
          </div>
        );
      }}
    >
      <div
        ref={mainRef}
        class="app-shell"
        data-look={store.themePreset}
        data-window-border={!isMac ? 'true' : 'false'}
        data-window-focused={windowFocused() ? 'true' : 'false'}
        data-window-maximized={windowMaximized() ? 'true' : 'false'}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          '--inactive-column-opacity': store.inactiveColumnOpacity,
          width: '100vw',
          height: '100vh',
          display: 'flex',
          'flex-direction': 'column',
          position: 'relative',
          background: theme.bg,
          color: theme.fg,
          'font-family': "var(--font-ui, 'Sora', sans-serif)",
          'font-size': '14px',
          overflow: 'hidden',
        }}
      >
        <Show when={!isMac}>
          <WindowTitleBar bare={bare()} />
        </Show>
        <Show when={isMac}>
          <div class="mac-titlebar-spacer" data-tauri-drag-region>
            <Show when={!bare()}>
              <WorkspaceControls />
              <FocusModeTaskIndicators />
              <TaskBoardControls />
            </Show>
          </div>
        </Show>
        <Show when={!bare() && !store.keybindingMigrationDismissed}>
          <div
            class="keybinding-migration-notice"
            role="region"
            aria-label="Keyboard shortcuts update"
          >
            <span>
              Keyboard shortcuts are now configurable.{' '}
              <button
                type="button"
                class="keybinding-migration-notice-action"
                onClick={() => {
                  toggleHelpDialog(true);
                  dismissMigrationBanner();
                }}
              >
                Pick a preset for your coding agent
              </button>{' '}
              or{' '}
              <button
                type="button"
                class="keybinding-migration-notice-action secondary"
                onClick={() => dismissMigrationBanner()}
              >
                dismiss
              </button>
              .
            </span>
            <button
              type="button"
              class="keybinding-migration-notice-close"
              aria-label="Dismiss keyboard shortcuts update"
              onClick={() => dismissMigrationBanner()}
            >
              &times;
            </button>
          </div>
        </Show>
        <Show when={welcome()}>
          <WelcomeScreen />
        </Show>
        {/* Hidden rather than unmounted, so startup sees the workspace it always has. */}
        <main
          style={{ flex: '1', display: bare() ? 'none' : 'flex', overflow: 'hidden' }}
          classList={{ 'board-panel-left': boardSidePanelOpen() && store.boardSidePanelLeft }}
        >
          <Show when={store.sidebarVisible}>
            <Sidebar />
          </Show>
          <Show when={boardShown()}>
            <Show when={store.kanbanProjectId} fallback={<TaskBoard />}>
              <KanbanPage />
            </Show>
          </Show>
          {/* Keep terminals mounted while a page or the board occupies the
              workspace; the board shows it as its side panel. */}
          <div
            class="task-workspace"
            classList={{
              'board-side-panel': boardSidePanelOpen(),
              'panel-left': boardSidePanelOpen() && store.boardSidePanelLeft,
            }}
            style={{
              display: projectPageOpen() || boardCoversWorkspace() ? 'none' : undefined,
              'flex-basis': boardSidePanelOpen() ? boardSidePanelBasis() : undefined,
            }}
          >
            <Show when={boardSidePanelOpen()}>
              <BoardSidePanelHandle />
              <BoardSidePanelClose />
            </Show>
            <TilingLayout />
          </div>
          <GitHubIssuesPage />
        </main>
        <Show when={!bare()}>
          <UsageStatusBar />
        </Show>
        <IdeaDialog />
        <HelpDialog open={store.showHelpDialog} onClose={() => toggleHelpDialog(false)} />
        <TaskSwitcher
          open={taskSwitcherOpen()}
          onClose={() => setTaskSwitcherOpen(false)}
          actions={paletteActions()}
          // A fresh event: no handler sees auto-repeat from a palette pick.
          onAction={(action) => actionHandlers[action]?.(new KeyboardEvent('keydown'))}
        />
        <SettingsDialog
          open={store.showSettingsDialog}
          onClose={() => toggleSettingsDialog(false)}
        />
        <Show when={store.thinkingSpace}>
          {(mode) => <ThinkingSpace mode={mode()} onClose={() => openThinkingSpace(null)} />}
        </Show>
        <Show when={store.showArena}>
          <ArenaOverlay onClose={closeArena} />
        </Show>
        <Show when={showDropOverlay()}>
          <DropOverlay />
        </Show>
        {/* Not before the close handler is listening: Cmd+Q closes the window,
            and a close nobody answers hits the backend's 5s watchdog, which
            force-destroys and takes the terminals with it. */}
        <Show when={isMac && closeHandlerReady()}>
          <HoldToQuit />
        </Show>
        {/* The live region stays mounted: screen readers announce changes to
            an existing region, not a region that appears with its text. */}
        <div role="status" aria-live="polite">
          <Show when={store.notification}>
            <div
              class="app-notice"
              onClick={() => clearNotification()}
              style={{
                position: 'fixed',
                bottom: '24px',
                left: '50%',
                transform: 'translateX(-50%)',
                'border-radius': 'var(--radius-md)',
                padding: '10px 20px',
                color: theme.fg,
                'font-size': '14px',
                'z-index': 'var(--z-overlay)',
                cursor: 'pointer',
                display: 'flex',
                'align-items': 'center',
                gap: '8px',
              }}
            >
              <Show when={store.notificationBusy}>
                <span class="inline-spinner" aria-hidden="true" />
              </Show>
              <Show when={store.notificationTone === 'success'}>
                <span class="app-notice-check" aria-hidden="true">
                  <CircleCheckIcon size={16} />
                </span>
              </Show>
              {store.notification}
              <Show when={notificationAction()}>
                {(action) => (
                  <button
                    type="button"
                    style={{ ...linkButtonStyle, color: theme.fg, 'font-size': 'inherit' }}
                    onClick={(e) => {
                      // The notice dismisses on any click; clear it before running, so a notice the action shows stays up.
                      e.stopPropagation();
                      const { run } = action();
                      clearNotification();
                      run();
                    }}
                  >
                    {action().label}
                  </button>
                )}
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </ErrorBoundary>
  );
}

export default App;
