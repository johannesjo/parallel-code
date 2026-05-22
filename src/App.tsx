import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { onMount, onCleanup, createEffect, Show, ErrorBoundary, createSignal } from 'solid-js';
import { invoke } from './lib/ipc';
import { IPC } from '../electron/ipc/channels';
import { appWindow } from './lib/window';
import { choice } from './lib/dialog';
import { CLOSE_DIALOG_BUTTONS, resolveCloseChoice } from './lib/close-decision';
import { Sidebar } from './components/Sidebar';
import { TilingLayout } from './components/TilingLayout';
import { NewTaskDialog } from './components/NewTaskDialog';
import { HelpDialog } from './components/HelpDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { WindowTitleBar } from './components/WindowTitleBar';
import { FocusModeTaskIndicators } from './components/FocusModeTaskIndicators';
import { WindowResizeHandles } from './components/WindowResizeHandles';
import { theme } from './lib/theme';
import * as log from './lib/log';
import {
  store,
  loadAgents,
  loadState,
  saveState,
  toggleNewTaskDialog,
  toggleSidebar,
  toggleArena,
  moveActiveTask,
  jumpToTask,
  adjustGlobalScale,
  resetGlobalScale,
  startTaskStatusPolling,
  stopTaskStatusPolling,
  navigateRow,
  navigateColumn,
  navigateTask,
  setPendingAction,
  toggleHelpDialog,
  toggleSettingsDialog,
  sendActivePrompt,
  spawnShellForTask,
  closeShell,
  clearNotification,
  setWindowState,
  createTerminal,
  closeTerminal,
  setNewTaskDropUrl,
  validateProjectPaths,
  setPlanContent,
  setStepsContent,
  setDockerAvailable,
  toggleTaskFocusMode,
  initMCPListeners,
  markTaskMcpPending,
  markTaskMcpReady,
  setTaskMcpLaunchArgs,
  markTaskMcpError,
} from './store/store';
import { isGitHubUrl } from './lib/github-url';
import type { PersistedWindowState } from './store/types';
import {
  initShortcuts,
  registerFromRegistry,
  registerJumpToTaskShortcuts,
  registerZoomShortcuts,
} from './lib/shortcuts';
import { resolvedBindings, loadKeybindings, dismissMigrationBanner } from './store/keybindings';
import { setupAutosave } from './store/autosave';
import { buildCustomThemeCss } from './lib/custom-theme';
import { osIsDark } from './lib/os-appearance';
import { applyAppearanceMode, markCustomThemesReady, loadCustomThemes } from './store/store';
import { isMac, mod } from './lib/platform';
import { createCtrlWheelZoomHandler } from './lib/wheelZoom';
import { ArenaOverlay } from './arena/ArenaOverlay';
import { startDesktopNotificationWatcher } from './store/desktopNotifications';
import { startPrChecksSubscription } from './store/pr-checks';
import { startUpdateSubscription } from './store/updates';

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
      <svg
        width="48"
        height="48"
        viewBox="0 0 16 16"
        fill={theme.accent}
        style={{ opacity: '0.9' }}
      >
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
      <span
        style={{
          color: theme.fg,
          'font-size': '17px',
          'font-weight': '600',
          'font-family': 'var(--font-ui)',
        }}
      >
        Drop GitHub link to create task
      </span>
      <span
        style={{
          color: theme.fgMuted,
          'font-size': '13px',
          'font-family': 'var(--font-ui)',
        }}
      >
        A new task will be created with the link in the prompt
      </span>
    </div>
  );
}

function App() {
  let mainRef!: HTMLDivElement;
  const [windowFocused, setWindowFocused] = createSignal(true);
  const [windowMaximized, setWindowMaximized] = createSignal(false);
  const [showDropOverlay, setShowDropOverlay] = createSignal(false);
  let dragCounter = 0;

  function extractGitHubUrl(dt: DataTransfer): string | null {
    const uriList = dt.getData('text/uri-list');
    if (uriList) {
      const firstUrl = uriList
        .split('\n')
        .find((l) => !l.startsWith('#'))
        ?.trim();
      if (firstUrl && isGitHubUrl(firstUrl)) return firstUrl;
    }
    const text = dt.getData('text/plain')?.trim();
    if (text && isGitHubUrl(text)) return text;
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
    const url = extractGitHubUrl(e.dataTransfer);
    if (!url) return;
    setNewTaskDropUrl(url);
    toggleNewTaskDialog(true);
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
    if (isMac) {
      await appWindow.setTitleBarStyle('overlay').catch((error) => {
        console.warn('Failed to enable macOS overlay titlebar', error);
      });
    } else {
      // Keep native titlebar on macOS, use custom frameless chrome elsewhere.
      await appWindow.setDecorations(false).catch((error) => {
        console.warn('Failed to disable native decorations', error);
      });
    }

    void syncWindowFocused();
    void syncWindowMaximized();

    void (async () => {
      try {
        unlistenFocusChanged = await appWindow.onFocusChanged((event) => {
          setWindowFocused(Boolean(event.payload));
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
    await loadState();
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
          worktreePath: task.gitIsolation === 'worktree' ? task.worktreePath : undefined,
          skipPermissions: task.skipPermissions ?? false,
          propagateSkipPermissions: task.propagateSkipPermissions ?? false,
          agentCommand: agentDef?.command ?? 'claude',
          agentArgs: agentDef?.args ?? [],
          dockerContainerName,
          dockerImage: task.dockerMode ? task.dockerImage : undefined,
        })
          .then((result) => {
            setTaskMcpLaunchArgs(taskId, result?.mcpLaunchArgs);
            markTaskMcpReady(taskId);
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
      // Skip if coordinator restore failed — hydrating into a broken coordinator leaves
      // children with stale MCP wiring and misleading 'ready' status.
      if (store.tasks[task.coordinatedBy]?.mcpStartupStatus !== 'ready') continue;
      const projectRoot = store.projects.find((p) => p.id === task.projectId)?.path;
      if (!projectRoot) continue;
      markTaskMcpPending(task.id);
      hydratePromises.push(
        invoke(IPC.MCP_HydrateCoordinatedTask, {
          id: task.id,
          name: task.name,
          projectId: task.projectId,
          projectRoot,
          branchName: task.branchName,
          baseBranch: task.baseBranch,
          worktreePath: task.worktreePath,
          coordinatorTaskId: task.coordinatedBy,
          controlledBy: task.controlledBy,
          agentId: task.agentIds[0],
          signalDoneAt: task.signalDoneAt,
          signalDoneConsumed: task.signalDoneConsumed,
          mcpConfigPath: task.mcpConfigPath,
          preambleFileExistedBefore: task.preambleFileExistedBefore,
        })
          .then(() => markTaskMcpReady(task.id))
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
      invoke<{ content: string; fileName: string } | null>(IPC.ReadPlanContent, {
        worktreePath: task.worktreePath,
        fileName: task.planFileName,
      })
        .then((result) => {
          if (result) setPlanContent(taskId, result.content, result.fileName);
        })
        .catch((err) => {
          console.warn(`Failed to restore plan for task ${taskId}:`, err);
        });
    }

    // Restore steps content for tasks that had steps before restart
    for (const taskId of [...store.taskOrder, ...store.collapsedTaskOrder]) {
      const task = store.tasks[taskId];
      if (!task?.worktreePath || !task.stepsEnabled) continue;
      invoke<unknown[] | null>(IPC.ReadStepsContent, {
        worktreePath: task.worktreePath,
      })
        .then((result) => {
          if (result) setStepsContent(taskId, result);
        })
        .catch((err) => {
          console.warn(`Failed to restore steps for task ${taskId}:`, err);
        });
    }

    await validateProjectPaths();
    await restoreWindowState();
    await captureWindowState();
    setupAutosave();
    startTaskStatusPolling();
    const stopMCPListeners = initMCPListeners();
    const stopNotificationWatcher = startDesktopNotificationWatcher(windowFocused);
    const stopPrChecksSubscription = startPrChecksSubscription();
    const stopUpdateSubscription = startUpdateSubscription();

    // Listen for plan content pushed from backend plan watcher
    const offPlanContent = window.electron.ipcRenderer.on(IPC.PlanContent, (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const msg = data as { taskId: string; content: string | null; fileName: string | null };
      if (msg.taskId && store.tasks[msg.taskId]) {
        setPlanContent(msg.taskId, msg.content, msg.fileName);
      }
    });

    // Listen for steps content pushed from backend steps watcher
    const offStepsContent = window.electron.ipcRenderer.on(IPC.StepsContent, (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const msg = data as { taskId: string; steps: unknown[] | null };
      console.warn('[steps.recv]', msg.taskId, 'len=', msg.steps?.length ?? 'null');
      if (msg.taskId && store.tasks[msg.taskId]) {
        setStepsContent(msg.taskId, msg.steps);
      }
    });

    const handlePaste = (e: ClipboardEvent) => {
      if (store.showNewTaskDialog || store.showHelpDialog || store.showSettingsDialog) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable) ||
        el?.closest?.('.xterm')
      ) {
        return;
      }
      const text = e.clipboardData?.getData('text/plain')?.trim();
      if (text && isGitHubUrl(text)) {
        e.preventDefault();
        setNewTaskDropUrl(text);
        toggleNewTaskDialog(true);
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

    const actionHandlers: Record<string, (e: KeyboardEvent) => void> = {
      'navigateRow:up': () => navigateRow('up'),
      'navigateRow:down': () => navigateRow('down'),
      'navigateColumn:left': () => navigateColumn('left'),
      'navigateColumn:right': () => navigateColumn('right'),
      'navigateTask:left': () => navigateTask('left'),
      'navigateTask:right': () => navigateTask('right'),
      'moveActiveTask:left': () => moveActiveTask('left'),
      'moveActiveTask:right': () => moveActiveTask('right'),
      ...Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [`jumpToTask:${i + 1}`, () => jumpToTask(i)]),
      ),
      closeShell: () => {
        const taskId = store.activeTaskId;
        if (!taskId) return;
        const panel = store.focusedPanel[taskId] ?? '';
        if (panel.startsWith('shell:')) {
          const idx = parseInt(panel.slice(6), 10);
          const shellId = store.tasks[taskId]?.shellAgentIds[idx];
          if (shellId) closeShell(taskId, shellId);
        }
      },
      closeTask: () => {
        const id = store.activeTaskId;
        if (!id) return;
        if (store.terminals[id]) {
          closeTerminal(id);
          return;
        }
        if (store.tasks[id]) setPendingAction({ type: 'close', taskId: id });
      },
      mergeTask: () => {
        const id = store.activeTaskId;
        if (id && store.tasks[id]) setPendingAction({ type: 'merge', taskId: id });
      },
      pushTask: () => {
        const id = store.activeTaskId;
        if (id && store.tasks[id]) setPendingAction({ type: 'push', taskId: id });
      },
      spawnShell: () => {
        const id = store.activeTaskId;
        if (id && store.tasks[id]) spawnShellForTask(id);
      },
      sendPrompt: () => sendActivePrompt(),
      createTerminal: (e) => {
        if (!e.repeat) createTerminal();
      },
      newTask: () => toggleNewTaskDialog(true),
      toggleSidebar: () => toggleSidebar(),
      toggleFocusMode: () => toggleTaskFocusMode(),
      toggleHelp: () => toggleHelpDialog(),
      toggleSettings: () => toggleSettingsDialog(),
      closeDialogs: () => {
        if (store.showArena) return;
        if (store.showHelpDialog) {
          toggleHelpDialog(false);
          return;
        }
        if (store.showSettingsDialog) {
          toggleSettingsDialog(false);
          return;
        }
        if (store.showNewTaskDialog) {
          toggleNewTaskDialog(false);
          return;
        }
      },
      resetZoom: () => resetGlobalScale(),
    };

    const cleanupZoomShortcuts = registerZoomShortcuts({
      zoomIn: () => adjustGlobalScale(1),
      zoomOut: () => adjustGlobalScale(-1),
      resetZoom: () => resetGlobalScale(),
    });

    const cleanupJumpToTaskShortcuts = registerJumpToTaskShortcuts((i) => jumpToTask(i));

    createEffect(() => {
      const cleanup = registerFromRegistry(resolvedBindings(), actionHandlers);
      onCleanup(cleanup);
    });

    onCleanup(() => {
      document.removeEventListener('paste', handlePaste);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      mainRef.removeEventListener('wheel', handleWheel);
      unlistenCloseRequested();
      cleanupShortcuts();
      stopTaskStatusPolling();
      stopMCPListeners();
      stopNotificationWatcher();
      stopPrChecksSubscription();
      stopUpdateSubscription();
      offPlanContent();
      offStepsContent();
      unlistenFocusChanged?.();
      unlistenResized?.();
      unlistenMoved?.();
      cleanupZoomShortcuts();
      cleanupJumpToTaskShortcuts();
    });
  });

  return (
    <ErrorBoundary
      fallback={(err, reset) => (
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
          <div style={{ 'font-size': '19px', 'font-weight': '600', color: theme.error }}>
            Something went wrong
          </div>
          <div
            style={{
              'max-width': '500px',
              'text-align': 'center',
              color: theme.fgMuted,
              'word-break': 'break-word',
            }}
          >
            {String(err)}
          </div>
          <button
            onClick={reset}
            style={{
              background: theme.bgElevated,
              border: `1px solid ${theme.border}`,
              color: theme.fg,
              padding: '8px 24px',
              'border-radius': '8px',
              cursor: 'pointer',
              'font-size': '15px',
            }}
          >
            Reload
          </button>
        </div>
      )}
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
          <WindowTitleBar />
        </Show>
        <Show when={isMac}>
          <div class="mac-titlebar-spacer" data-tauri-drag-region>
            <FocusModeTaskIndicators />
          </div>
        </Show>
        <Show when={!store.keybindingMigrationDismissed}>
          <div
            style={{
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-bottom': `1px solid ${theme.border}`,
              padding: '8px 16px',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'space-between',
              'font-size': '13px',
              color: theme.fg,
              'flex-shrink': '0',
            }}
          >
            <span>
              Keyboard shortcuts are now configurable.{' '}
              <button
                type="button"
                onClick={() => {
                  toggleHelpDialog(true);
                  dismissMigrationBanner();
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: '0',
                  font: 'inherit',
                  color: theme.accent,
                  cursor: 'pointer',
                  'text-decoration': 'underline',
                }}
              >
                Pick a preset for your coding agent
              </button>{' '}
              or{' '}
              <button
                type="button"
                onClick={() => dismissMigrationBanner()}
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: '0',
                  font: 'inherit',
                  color: theme.fgMuted,
                  cursor: 'pointer',
                  'text-decoration': 'underline',
                }}
              >
                dismiss
              </button>
              .
            </span>
            <button
              onClick={() => dismissMigrationBanner()}
              style={{
                background: 'transparent',
                border: 'none',
                color: theme.fgMuted,
                cursor: 'pointer',
                'font-size': '16px',
                padding: '0 4px',
                'line-height': '1',
              }}
            >
              &times;
            </button>
          </div>
        </Show>
        <main style={{ flex: '1', display: 'flex', overflow: 'hidden' }}>
          <Show when={store.sidebarVisible}>
            <Sidebar />
          </Show>
          <Show when={!store.sidebarVisible}>
            <button
              class="icon-btn"
              onClick={() => toggleSidebar()}
              title={`Show sidebar (${mod}+B)`}
              style={{
                width: '24px',
                'min-width': '24px',
                height: 'calc(100% - 12px)',
                margin: '6px 4px 6px 0',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                cursor: 'pointer',
                color: theme.fgSubtle,
                background: 'transparent',
                'border-top': `2px dashed ${theme.border}`,
                'border-right': `2px dashed ${theme.border}`,
                'border-bottom': `2px dashed ${theme.border}`,
                'border-left': 'none',
                'border-radius': '0 12px 12px 0',
                'user-select': 'none',
                'flex-shrink': '0',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          </Show>
          <TilingLayout />
          <NewTaskDialog
            open={store.showNewTaskDialog}
            onClose={() => toggleNewTaskDialog(false)}
          />
        </main>
        <Show when={!isMac}>
          <WindowResizeHandles />
        </Show>
        <HelpDialog open={store.showHelpDialog} onClose={() => toggleHelpDialog(false)} />
        <SettingsDialog
          open={store.showSettingsDialog}
          onClose={() => toggleSettingsDialog(false)}
        />
        <Show when={store.showArena}>
          <ArenaOverlay onClose={() => toggleArena(false)} />
        </Show>
        <Show when={showDropOverlay()}>
          <DropOverlay />
        </Show>
        <Show when={store.notification}>
          <div
            onClick={() => clearNotification()}
            style={{
              position: 'fixed',
              bottom: '24px',
              left: '50%',
              transform: 'translateX(-50%)',
              background: theme.islandBg,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '10px 20px',
              color: theme.fg,
              'font-size': '14px',
              'z-index': '2000',
              'box-shadow': '0 4px 24px rgba(0,0,0,0.4)',
              cursor: 'pointer',
            }}
          >
            {store.notification}
          </div>
        </Show>
      </div>
    </ErrorBoundary>
  );
}

export default App;
