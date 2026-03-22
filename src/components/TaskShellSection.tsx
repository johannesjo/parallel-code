import { Show, For, createSignal, createEffect, onCleanup } from 'solid-js';
import { createStore } from 'solid-js/store';
import {
  store,
  getProject,
  spawnShellForTask,
  runBookmarkInTask,
  closeShell,
  markAgentOutput,
  getFontScale,
  registerFocusFn,
  unregisterFocusFn,
  setTaskFocusedPanel,
} from '../store/store';
import { ScalablePanel } from './ScalablePanel';
import { TerminalView } from './TerminalView';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { mod } from '../lib/platform';
import { extractLabel, consumePendingShellCommand } from '../lib/bookmarks';
import type { Task } from '../store/types';

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

  return (
    <ScalablePanel panelId={`${props.task.id}:shell`}>
      <div
        style={{
          height: '100%',
          display: 'flex',
          'flex-direction': 'column',
          background: 'transparent',
        }}
      >
        <div
          ref={(el) => {
            shellToolbarEl = el;
          }}
          class="focusable-panel shell-toolbar-panel"
          tabIndex={0}
          onClick={() =>
            setTaskFocusedPanel(props.task.id, `shell-toolbar:${shellToolbarIdx()}`)
          }
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
              spawnShellForTask(props.task.id);
            }}
            tabIndex={-1}
            title={`Open terminal (${mod}+Shift+T)`}
            style={{
              background: theme.taskPanelBg,
              border: `1px solid ${shellToolbarIdx() === 0 && shellToolbarFocused() ? theme.accent : theme.border}`,
              color: theme.fgMuted,
              cursor: 'pointer',
              'border-radius': '4px',
              padding: '4px 12px',
              'font-size': sf(13),
              'line-height': '1',
              display: 'flex',
              'align-items': 'center',
              gap: '4px',
            }}
          >
            <span style={{ 'font-family': 'monospace', 'font-size': sf(13) }}>&gt;_</span>
            <span>Terminal</span>
          </button>
          <For each={projectBookmarks()}>
            {(bookmark, i) => (
              <button
                class="icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  runBookmarkInTask(props.task.id, bookmark.command);
                }}
                tabIndex={-1}
                title={bookmark.command}
                style={{
                  background: theme.taskPanelBg,
                  border: `1px solid ${shellToolbarIdx() === i() + 1 && shellToolbarFocused() ? theme.accent : theme.border}`,
                  color: theme.fgMuted,
                  cursor: 'pointer',
                  'border-radius': '4px',
                  padding: '4px 12px',
                  'font-size': sf(13),
                  'line-height': '1',
                  display: 'flex',
                  'align-items': 'center',
                  gap: '4px',
                }}
              >
                <span>{extractLabel(bookmark.command)}</span>
              </button>
            )}
          </For>
        </div>
        <Show when={props.task.shellAgentIds.length > 0}>
          <div
            style={{
              flex: '1',
              display: 'flex',
              overflow: 'hidden',
              background: theme.taskContainerBg,
              gap: '6px',
              'margin-top': '6px',
            }}
          >
            <For each={props.task.shellAgentIds}>
              {(shellId, i) => {
                const initialCommand = consumePendingShellCommand(shellId);
                let shellFocusFn: (() => void) | undefined;
                let registeredKey: string | undefined;

                createEffect(() => {
                  const key = `${props.task.id}:shell:${i()}`;
                  if (registeredKey && registeredKey !== key) unregisterFocusFn(registeredKey);
                  if (shellFocusFn) registerFocusFn(key, shellFocusFn);
                  registeredKey = key;
                });
                onCleanup(() => {
                  if (registeredKey) unregisterFocusFn(registeredKey);
                });

                const isShellFocused = () =>
                  store.focusedPanel[props.task.id] === `shell:${i()}`;

                return (
                  <div
                    class="focusable-panel shell-terminal-container"
                    data-shell-focused={isShellFocused() ? 'true' : 'false'}
                    style={{
                      flex: '1',
                      overflow: 'hidden',
                      position: 'relative',
                      background: theme.taskPanelBg,
                    }}
                    onClick={() => setTaskFocusedPanel(props.task.id, `shell:${i()}`)}
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
                        'font-size': '14px',
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                      </svg>
                    </button>
                    <Show when={shellExits[shellId]}>
                      <div
                        class="exit-badge"
                        style={{
                          position: 'absolute',
                          top: '8px',
                          right: '12px',
                          'z-index': '10',
                          'font-size': sf(11),
                          color:
                            shellExits[shellId]?.exitCode === 0 ? theme.success : theme.error,
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
                      isFocused={
                        props.isActive && store.focusedPanel[props.task.id] === `shell:${i()}`
                      }
                      command={''}
                      args={['-l']}
                      cwd={props.task.worktreePath}
                      dockerMode={props.task.dockerMode}
                      dockerImage={props.task.dockerImage}
                      initialCommand={initialCommand}
                      onData={(data) => markAgentOutput(shellId, data, props.task.id)}
                      onExit={(info) =>
                        setShellExits(shellId, {
                          exitCode: info.exit_code,
                          signal: info.signal,
                        })
                      }
                      onReady={(focusFn) => {
                        shellFocusFn = focusFn;
                        if (registeredKey) registerFocusFn(registeredKey, focusFn);
                      }}
                      fontSize={Math.round(11 * getFontScale(`${props.task.id}:shell`))}
                      autoFocus
                    />
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </ScalablePanel>
  );
}
