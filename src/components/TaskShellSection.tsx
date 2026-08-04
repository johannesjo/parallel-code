import { Show, For, createSignal, createEffect, onCleanup, type JSX } from 'solid-js';
import { createStore } from 'solid-js/store';
import {
  store,
  getProject,
  spawnShellForTask,
  runBookmarkInTask,
  closeShell,
  markAgentOutput,
  clearAgentActivity,
  refreshTaskStatus,
  registerFocusFn,
  unregisterFocusFn,
  setActiveTask,
  setTaskFocusedPanel,
  shellPanelId,
  isPanelFocused,
  isPanelFocusedPrefix,
} from '../store/store';
import { TerminalView } from './TerminalView';
import { CloseIcon } from './icons';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { mod } from '../lib/platform';
import { extractLabel, consumePendingShellCommand } from '../lib/bookmarks';
import type { Task } from '../store/types';

const toolbarBtnStyle = (highlighted: boolean): JSX.CSSProperties => ({
  background: theme.taskPanelBg,
  border: `1px solid ${highlighted ? theme.accent : theme.border}`,
  color: theme.fgMuted,
  cursor: 'pointer',
  'border-radius': '4px',
  padding: '4px 12px',
  'font-size': sf(14),
  'line-height': '1',
  display: 'flex',
  'align-items': 'center',
  gap: '4px',
});

interface TaskShellSectionProps {
  task: Task;
  isActive: boolean;
}

export function TaskShellSection(props: TaskShellSectionProps) {
  const [shellToolbarIdx, setShellToolbarIdx] = createSignal(0);
  const [shellToolbarFocused, setShellToolbarFocused] = createSignal(false);
  const [shellExits, setShellExits] = createStore<
    Record<string, { exitCode: number | null; signal: string | null }>
  >({});
  let shellToolbarEl: HTMLDivElement | undefined;

  const projectBookmarks = () => getProject(props.task.projectId)?.terminalBookmarks ?? [];

  // Reactively register shell-toolbar:N focus fns
  createEffect(() => {
    const id = props.task.id;
    const count = 1 + projectBookmarks().length;
    if (shellToolbarIdx() >= count) {
      setShellToolbarIdx(count - 1);
    }
    for (let n = 0; n < count; n++) {
      const idx = n;
      registerFocusFn(`${id}:shell-toolbar:${idx}`, () => {
        setShellToolbarIdx(idx);
        shellToolbarEl?.focus();
      });
    }
    onCleanup(() => {
      for (let i = 0; i < count; i++) {
        unregisterFocusFn(`${id}:shell-toolbar:${i}`);
      }
    });
  });

  const hasShell = () => props.task.shellAgentIds.length > 0;

  // Intrinsic height the flex-first panel tree will size this panel to when
  // it isn't pinned. Empty state collapses to the 28 px toolbar. With agents
  // we pick 140 px as the natural default so the panel stays dragable down to
  // a useful "small terminal" state; focus mode scales up so the terminal has
  // room when it takes over the screen.
  //
  // In split mode this section is the right-column flex absorber. Enforcing a
  // min-height on the inner there would overflow the wrapper when steps grow
  // and compress the absorber, and xterm fits the inner — so the bottom of
  // the terminal output gets clipped by the wrapper's overflow:hidden. Fall
  // back to 0 in that case and let the wrapper's allocated size drive xterm.
  const intrinsicHeight = () => {
    if (!hasShell()) return '28px';
    if (store.focusMode && store.taskSplitMode[props.task.id]) return '0';
    if (store.focusMode) return 'max(200px, 33vh)';
    return '140px';
  };

  return (
    <div
      style={{
        // `height: 100%` fills the wrapper when flex assigns one (absorber in
        // split-right); `min-height` provides the content size otherwise so
        // `flex: 0 0 auto` can pick a sensible default.
        height: '100%',
        'min-height': intrinsicHeight(),
        display: 'flex',
        'flex-direction': 'column',
        background: 'transparent',
        'padding-top': hasShell() ? '0' : '6px',
        'padding-bottom': hasShell() ? '0' : '6px',
      }}
    >
      <div
        ref={(el) => {
          shellToolbarEl = el;
        }}
        class="focusable-panel shell-toolbar-panel"
        data-panel-focused={
          isPanelFocusedPrefix(props.task.id, 'shell-toolbar:') ? 'true' : 'false'
        }
        tabIndex={0}
        onClick={() => setTaskFocusedPanel(props.task.id, `shell-toolbar:${shellToolbarIdx()}`)}
        onFocus={() => setShellToolbarFocused(true)}
        onBlur={() => setShellToolbarFocused(false)}
        onKeyDown={(e) => {
          if (e.altKey) return;
          const itemCount = 1 + projectBookmarks().length;
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            const next = Math.min(itemCount - 1, shellToolbarIdx() + 1);
            setShellToolbarIdx(next);
            setTaskFocusedPanel(props.task.id, `shell-toolbar:${next}`);
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            const next = Math.max(0, shellToolbarIdx() - 1);
            setShellToolbarIdx(next);
            setTaskFocusedPanel(props.task.id, `shell-toolbar:${next}`);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const idx = shellToolbarIdx();
            if (idx === 0) {
              spawnShellForTask(props.task.id);
            } else {
              const bm = projectBookmarks()[idx - 1];
              if (bm) runBookmarkInTask(props.task.id, bm.command);
            }
          }
        }}
        style={{
          height: '28px',
          'min-height': '28px',
          display: 'flex',
          'align-items': 'center',
          padding: '0 8px',
          background: 'transparent',
          gap: '4px',
          outline: 'none',
        }}
      >
        <button
          class="icon-btn"
          onClick={(e) => {
            e.stopPropagation();
            setActiveTask(props.task.id);
            setTaskFocusedPanel(props.task.id, 'shell-toolbar:0');
            spawnShellForTask(props.task.id);
          }}
          tabIndex={-1}
          title={`Open terminal (${mod}+Shift+T)`}
          style={toolbarBtnStyle(shellToolbarIdx() === 0 && shellToolbarFocused())}
        >
          <span style={{ 'font-family': 'monospace', 'font-size': sf(14) }}>&gt;_</span>
          <span>Terminal</span>
        </button>
        <For each={projectBookmarks()}>
          {(bookmark, i) => (
            <button
              class="icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                setActiveTask(props.task.id);
                setTaskFocusedPanel(props.task.id, `shell-toolbar:${i() + 1}`);
                runBookmarkInTask(props.task.id, bookmark.command);
              }}
              tabIndex={-1}
              title={bookmark.command}
              style={toolbarBtnStyle(shellToolbarIdx() === i() + 1 && shellToolbarFocused())}
            >
              <span>{extractLabel(bookmark.command)}</span>
            </button>
          )}
        </For>
      </div>
      <Show when={props.task.shellAgentIds.length > 0}>
        <div
          class="shell-terminals-row"
          style={{
            flex: '1',
            display: 'flex',
            overflow: 'hidden',
            background: theme.taskContainerBg,
            gap: '6px',
            'margin-top': '2px',
          }}
        >
          <For each={props.task.shellAgentIds}>
            {(shellId, i) => {
              const initialCommand = consumePendingShellCommand(shellId);
              let shellFocusFn: (() => void) | undefined;
              let registeredKey: string | undefined;

              createEffect(() => {
                const key = `${props.task.id}:${shellPanelId(i())}`;
                if (registeredKey && registeredKey !== key) unregisterFocusFn(registeredKey);
                if (shellFocusFn) registerFocusFn(key, shellFocusFn);
                registeredKey = key;
              });
              onCleanup(() => {
                if (registeredKey) unregisterFocusFn(registeredKey);
              });

              const isShellPanelFocused = () => isPanelFocused(props.task.id, shellPanelId(i()));

              return (
                <div
                  class="focusable-panel shell-terminal-container"
                  data-panel-focused={isShellPanelFocused() ? 'true' : 'false'}
                  style={{
                    flex: '1',
                    overflow: 'hidden',
                    position: 'relative',
                    background: theme.taskPanelBg,
                  }}
                  onClick={() => setTaskFocusedPanel(props.task.id, shellPanelId(i()))}
                >
                  <button
                    class="shell-terminal-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeShell(props.task.id, shellId);
                    }}
                    title="Close terminal (Ctrl+Shift+Q)"
                    style={{
                      background: 'color-mix(in srgb, var(--island-bg) 85%, transparent)',
                      border: `1px solid ${theme.border}`,
                      color: theme.fgMuted,
                      cursor: 'pointer',
                      'border-radius': '6px',
                      padding: '2px 6px',
                      'line-height': '1',
                      'font-size': '15px',
                    }}
                  >
                    <CloseIcon size={12} />
                  </button>
                  <Show when={shellExits[shellId]}>
                    <div
                      class="exit-badge"
                      style={{
                        position: 'absolute',
                        top: '8px',
                        right: '12px',
                        'z-index': '10',
                        'font-size': sf(12),
                        color: shellExits[shellId]?.exitCode === 0 ? theme.success : theme.error,
                        background: 'color-mix(in srgb, var(--island-bg) 80%, transparent)',
                        padding: '4px 12px',
                        'border-radius': '8px',
                        border: `1px solid ${theme.border}`,
                      }}
                    >
                      Process exited ({shellExits[shellId]?.exitCode ?? '?'})
                    </div>
                  </Show>
                  <TerminalView
                    taskId={props.task.id}
                    agentId={shellId}
                    isShell
                    bookmarksEnabled={false}
                    isFocused={isShellPanelFocused()}
                    command={''}
                    args={['-l']}
                    cwd={props.task.worktreePath}
                    dockerMode={props.task.dockerMode}
                    dockerImage={props.task.dockerImage}
                    initialCommand={initialCommand}
                    onData={(data) => markAgentOutput(shellId, data, props.task.id)}
                    onExit={(info) => {
                      clearAgentActivity(shellId);
                      refreshTaskStatus(props.task.id);
                      setShellExits(shellId, {
                        exitCode: info.exit_code,
                        signal: info.signal,
                      });
                    }}
                    onReady={(focusFn) => {
                      shellFocusFn = focusFn;
                      if (registeredKey) registerFocusFn(registeredKey, focusFn);
                    }}
                    fontSize={12}
                    autoFocus
                  />
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
