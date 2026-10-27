import {
  Show,
  For,
  createSignal,
  createEffect,
  onCleanup,
  onMount,
  untrack,
  type JSX,
} from 'solid-js';
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
  getTaskShellLayout,
  setTaskShellAutoLayout,
} from '../store/store';
import { TerminalView } from './TerminalView';
import { fileLinkMenu, type ChangesLink } from './file-link-menu';
import { findBareFile } from '../lib/find-bare-file';
import { createMarkdownViewer } from './MarkdownViewerDialog';
import { editAsDocument } from '../documents/store';
import { CloseIcon, TerminalSmallIcon } from './icons';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { mod } from '../lib/platform';
import { extractLabel, consumePendingShellCommand } from '../lib/bookmarks';
import { autoShellLayout, shellColumns } from '../lib/shellLayout';
import { ShellLayoutMenu } from './ShellLayoutMenu';
import type { Task } from '../store/types';

/** Outlined terminal launchers retain a clear boundary without a filled bar. */
const toolbarBtnStyle = (highlighted: boolean, iconOnly = false): JSX.CSSProperties => ({
  background: 'transparent',
  border: `1px solid ${highlighted ? theme.borderFocus : theme.border}`,
  color: highlighted ? theme.fg : theme.fgMuted,
  cursor: 'pointer',
  'border-radius': 'var(--radius-sm)',
  'box-sizing': 'border-box',
  height: '26px',
  width: iconOnly ? '26px' : undefined,
  padding: iconOnly ? '0' : '0 9px',
  'font-size': sf(12),
  'line-height': '16px',
  display: 'flex',
  'align-items': 'center',
  'justify-content': 'center',
  'flex-shrink': '0',
  gap: '5px',
});

interface TaskShellSectionProps {
  task: Task;
  isActive: boolean;
  /** Opens a worktree-relative file in the task's side panel. */
  onOpenInSidePanel?: (relativePath: string) => void;
  /** The task's changed files, which links open in the changes dialog. */
  changes?: ChangesLink;
}

/** Smallest height the shell section can show without clipping its open
 *  terminals; its cell must never be sized below this. Focus mode's floor is
 *  `max(200px, 33vh)`, so 200 is the part a pixel floor can promise. */
export function shellSectionMinHeight(task: Task): number {
  if (task.shellAgentIds.length === 0 || store.taskSplitMode[task.id]) return 35;
  return store.focusMode ? 200 : 140;
}

export function TaskShellSection(props: TaskShellSectionProps) {
  const [shellToolbarIdx, setShellToolbarIdx] = createSignal(0);
  const [shellToolbarFocused, setShellToolbarFocused] = createSignal(false);
  const [shellExits, setShellExits] = createStore<
    Record<string, { exitCode: number | null; signal: string | null }>
  >({});
  let shellToolbarEl: HTMLDivElement | undefined;
  let sectionEl: HTMLDivElement | undefined;
  const [sectionWidth, setSectionWidth] = createSignal(0);

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
  const shellCount = () => props.task.shellAgentIds.length;
  const layout = () => getTaskShellLayout(props.task.id);
  const cols = () => shellColumns(layout(), shellCount());

  onMount(() => {
    if (!sectionEl) return;
    const ro = new ResizeObserver((entries) => {
      setSectionWidth(entries[0]?.contentRect.width ?? 0);
    });
    ro.observe(sectionEl);
    setSectionWidth(sectionEl.clientWidth);
    onCleanup(() => ro.disconnect());
  });

  // The size-based pick lives in the store so keyboard navigation (focus.ts)
  // walks the same rows the user sees.
  createEffect(() => {
    const width = sectionWidth();
    if (width <= 0) return;
    const id = props.task.id;
    const prev = untrack(() => store.taskShellAutoLayout[id]);
    const split = !!store.taskSplitMode[id];
    setTaskShellAutoLayout(id, autoShellLayout({ width, count: shellCount(), split, prev }));
  });

  // Intrinsic height the flex-first panel tree will size this panel to when
  // it isn't pinned. Empty state collapses to the 35 px toolbar. With agents
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
    if (!hasShell()) return '35px';
    if (store.taskSplitMode[props.task.id]) return '0';
    if (store.focusMode) return 'max(200px, 33vh)';
    return '140px';
  };

  const markdownViewer = createMarkdownViewer();

  return (
    <div
      ref={sectionEl}
      style={{
        // `height: 100%` fills the wrapper when flex assigns one (absorber in
        // split-right); `min-height` provides the content size otherwise so
        // `flex: 0 0 auto` can pick a sensible default.
        height: '100%',
        'min-height': intrinsicHeight(),
        display: 'flex',
        'flex-direction': 'column',
        background: 'transparent',
      }}
    >
      {/* The layout menu sits outside the scrolling toolbar so many bookmarks can't push it out of reach. */}
      <div style={{ display: 'flex', 'align-items': 'center', 'flex-shrink': '0', gap: '4px' }}>
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
            flex: '1',
            'min-width': '0',
            height: '35px',
            'min-height': '35px',
            display: 'flex',
            'align-items': 'center',
            padding: '4px 5px',
            background: 'transparent',
            'box-sizing': 'border-box',
            gap: '4px',
            'overflow-x': 'auto',
            'overflow-y': 'hidden',
            outline: 'none',
          }}
        >
          <button
            class="shell-toolbar-button"
            onClick={(e) => {
              e.stopPropagation();
              setActiveTask(props.task.id);
              setTaskFocusedPanel(props.task.id, 'shell-toolbar:0');
              spawnShellForTask(props.task.id);
            }}
            tabIndex={-1}
            title={`Open terminal (${mod}+Shift+T)`}
            aria-label="Open terminal"
            style={toolbarBtnStyle(shellToolbarIdx() === 0 && shellToolbarFocused(), true)}
          >
            <TerminalSmallIcon size={14} style={{ 'flex-shrink': '0' }} />
          </button>
          <For each={projectBookmarks()}>
            {(bookmark, i) => (
              <button
                class="shell-toolbar-button"
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
        <Show when={shellCount() >= 2}>
          <ShellLayoutMenu taskId={props.task.id} mode={layout()} />
        </Show>
      </div>
      <Show when={props.task.shellAgentIds.length > 0}>
        <div
          class="shell-terminals-row"
          style={{
            flex: '1',
            'min-height': '0',
            display: 'grid',
            'grid-template-columns': `repeat(${cols()}, minmax(0, 1fr))`,
            // Stacked shells keep a usable height; the area scrolls rather
            // than squeezing them when a pinned layout doesn't fit.
            'grid-auto-rows': cols() < shellCount() ? 'minmax(80px, 1fr)' : 'minmax(0, 1fr)',
            'overflow-x': 'hidden',
            'overflow-y': 'auto',
            background: theme.taskContainerBg,
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
                    'min-width': '0',
                    'min-height': '0',
                    overflow: 'hidden',
                    position: 'relative',
                    background: theme.taskPanelBg,
                    'border-left': i() % cols() > 0 ? '1px solid var(--border)' : undefined,
                    'border-top': i() >= cols() ? '1px solid var(--border)' : undefined,
                  }}
                  onPointerDown={() => setTaskFocusedPanel(props.task.id, shellPanelId(i()))}
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
                      'border-radius': 'var(--radius-sm)',
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
                        'border-radius': 'var(--radius-md)',
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
                    onEditAsDocument={store.documentWorkspacesEnabled ? editAsDocument : undefined}
                    fileLinkMenu={(filePath, line) =>
                      fileLinkMenu(filePath, line, {
                        worktreePath: props.task.worktreePath,
                        openDialog: markdownViewer.show,
                        openInSidePanel: props.onOpenInSidePanel,
                        changes: props.changes,
                      })
                    }
                    findBareFile={(name) => findBareFile(name, props.task)}
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
      {markdownViewer.view()}
    </div>
  );
}
