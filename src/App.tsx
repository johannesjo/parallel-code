import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { onMount, onCleanup, createEffect, Show, ErrorBoundary, createSignal } from 'solid-js';
import { invoke } from './lib/ipc';
import { IPC } from '../electron/ipc/channels';
import { appWindow } from './lib/window';
import { confirm } from './lib/dialog';
import { Sidebar } from './components/Sidebar';
import { TilingLayout } from './components/TilingLayout';
import { NewTaskDialog } from './components/NewTaskDialog';
import { HelpDialog } from './components/HelpDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { WindowTitleBar } from './components/WindowTitleBar';
import { WindowResizeHandles } from './components/WindowResizeHandles';
import { theme } from './lib/theme';
import {
  store,
  loadAgents,
  loadState,
  saveState,
  toggleNewTaskDialog,
  toggleSidebar,
  moveActiveTask,
  getGlobalScale,
  adjustGlobalScale,
  resetGlobalScale,
  resetFontScale,
  startTaskStatusPolling,
  stopTaskStatusPolling,
  navigateRow,
  navigateColumn,
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
} from './store/store';
import { isGitHubUrl } from './lib/github-url';
import type { PersistedWindowState } from './store/types';
import { registerShortcut, initShortcuts } from './lib/shortcuts';
import { setupAutosave } from './store/autosave';
import { isMac, mod } from './lib/platform';
import { createCtrlWheelZoomHandler } from './lib/wheelZoom';

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
          'font-size': '16px',
          'font-weight': '600',
          'font-family': 'var(--font-ui)',
        }}
      >
        Drop GitHub link to create task
      </span>
      <span
        style={{
          color: theme.fgMuted,
          'font-size': '12px',
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

  // Sync theme preset to <html> so Portal content inherits CSS variables
  createEffect(() => {
    document.documentElement.dataset.look = store.themePreset;
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

      try {
        unlistenMoved = await appWindow.onMoved(() => {
          void captureWindowState();
        });
      } catch {
        unlistenMoved = null;
      }
    })();

    await loadAgents();
    await loadState();
    await restoreWindowState();
    await captureWindowState();
    setupAutosave();
    startTaskStatusPolling();

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
        const shouldKill = await confirm(
          `You have ${countLabel}. They can be restored on app restart. Kill them and quit, or keep them alive in the background?`,
          {
            title: 'Running Terminals',
            kind: 'warning',
            okLabel: 'Kill & Quit',
            cancelLabel: 'Keep in Background',
          },
        ).catch(() => false);

        if (shouldKill) {
          await invoke(IPC.KillAllAgents).catch(console.error);
          allowClose = true;
          await appWindow.close().catch(console.error);
          return;
        }

        await appWindow.hide().catch(console.error);
      } finally {
        handlingClose = false;
      }
    });

    // Navigation shortcuts (all global — work even in terminals)
    registerShortcut({ key: 'ArrowUp', alt: true, global: true, handler: () => navigateRow('up') });
    registerShortcut({
      key: 'ArrowDown',
      alt: true,
      global: true,
      handler: () => navigateRow('down'),
    });
    registerShortcut({
      key: 'ArrowLeft',
      alt: true,
      global: true,
      handler: () => navigateColumn('left'),
    });
    registerShortcut({
      key: 'ArrowRight',
      alt: true,
      global: true,
      handler: () => navigateColumn('right'),
    });

    // Task reordering
    registerShortcut({
      key: 'ArrowLeft',
      cmdOrCtrl: true,
      shift: true,
      global: true,
      handler: () => moveActiveTask('left'),
    });
    registerShortcut({
      key: 'ArrowRight',
      cmdOrCtrl: true,
      shift: true,
      global: true,
      handler: () => moveActiveTask('right'),
    });

    // Task actions
    registerShortcut({
      key: 'w',
      cmdOrCtrl: true,
      global: true,
      handler: () => {
        const taskId = store.activeTaskId;
        if (!taskId) return;
        const panel = store.focusedPanel[taskId] ?? '';
        if (panel.startsWith('shell:')) {
          const idx = parseInt(panel.slice(6), 10);
          const shellId = store.tasks[taskId]?.shellAgentIds[idx];
          if (shellId) closeShell(taskId, shellId);
        }
      },
    });
    registerShortcut({
      key: 'W',
      cmdOrCtrl: true,
      shift: true,
      global: true,
      handler: () => {
        const id = store.activeTaskId;
        if (!id) return;
        if (store.terminals[id]) {
          closeTerminal(id);
          return;
        }
        if (store.tasks[id]) setPendingAction({ type: 'close', taskId: id });
      },
    });
    registerShortcut({
      key: 'M',
      cmdOrCtrl: true,
      shift: true,
      global: true,
      handler: () => {
        const id = store.activeTaskId;
        if (id && store.tasks[id]) setPendingAction({ type: 'merge', taskId: id });
      },
    });
    registerShortcut({
      key: 'P',
      cmdOrCtrl: true,
      shift: true,
      global: true,
      handler: () => {
        const id = store.activeTaskId;
        if (id && store.tasks[id]) setPendingAction({ type: 'push', taskId: id });
      },
    });
    registerShortcut({
      key: 'T',
      cmdOrCtrl: true,
      shift: true,
      global: true,
      handler: () => {
        const id = store.activeTaskId;
        if (id && store.tasks[id]) spawnShellForTask(id);
      },
    });
    registerShortcut({
      key: 'Enter',
      cmdOrCtrl: true,
      global: true,
      handler: () => sendActivePrompt(),
    });

    // App shortcuts
    registerShortcut({
      key: 'D',
      cmdOrCtrl: true,
      shift: true,
      global: true,
      handler: (e) => {
        if (!e.repeat) createTerminal();
      },
    });
    registerShortcut({
      key: 'n',
      cmdOrCtrl: true,
      global: true,
      handler: () => toggleNewTaskDialog(true),
    });
    registerShortcut({
      key: 'a',
      cmdOrCtrl: true,
      shift: true,
      global: true,
      handler: () => toggleNewTaskDialog(true),
    });
    registerShortcut({ key: 'b', cmdOrCtrl: true, handler: () => toggleSidebar() });
    registerShortcut({
      key: '/',
      cmdOrCtrl: true,
      global: true,
      dialogSafe: true,
      handler: () => toggleHelpDialog(),
    });
    registerShortcut({
      key: ',',
      cmdOrCtrl: true,
      global: true,
      dialogSafe: true,
      handler: () => toggleSettingsDialog(),
    });
    registerShortcut({ key: 'F1', global: true, dialogSafe: true, handler: () => toggleHelpDialog() });
    registerShortcut({
      key: 'Escape',
      dialogSafe: true,
      handler: () => {
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
    });
    registerShortcut({
      key: '0',
      cmdOrCtrl: true,
      handler: () => {
        const taskId = store.activeTaskId;
        if (taskId) resetFontScale(taskId);
        resetGlobalScale();
      },
    });

    onCleanup(() => {
      document.removeEventListener('paste', handlePaste);
      mainRef.removeEventListener('wheel', handleWheel);
      unlistenCloseRequested();
      cleanupShortcuts();
      stopTaskStatusPolling();
      unlistenFocusChanged?.();
      unlistenResized?.();
      unlistenMoved?.();
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
          <div style={{ 'font-size': '18px', 'font-weight': '600', color: theme.error }}>
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
              'font-size': '14px',
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
          width: `${100 / getGlobalScale()}vw`,
          height: `${100 / getGlobalScale()}vh`,
          transform: `scale(${getGlobalScale()})`,
          'transform-origin': '0 0',
          display: 'flex',
          'flex-direction': 'column',
          position: 'relative',
          background: theme.bg,
          color: theme.fg,
          'font-family': "var(--font-ui, 'Sora', sans-serif)",
          'font-size': '13px',
          overflow: 'hidden',
        }}
      >
        <Show when={!isMac}>
          <WindowTitleBar />
        </Show>
        <Show when={isMac}>
          <div class="mac-titlebar-spacer" data-tauri-drag-region />
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
          <NewTaskDialog open={store.showNewTaskDialog} onClose={() => toggleNewTaskDialog(false)} />
        </main>
        <Show when={!isMac}>
          <WindowResizeHandles />
        </Show>
        <HelpDialog open={store.showHelpDialog} onClose={() => toggleHelpDialog(false)} />
        <SettingsDialog
          open={store.showSettingsDialog}
          onClose={() => toggleSettingsDialog(false)}
        />
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
              'font-size': '13px',
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
