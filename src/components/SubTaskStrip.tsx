import { For, Show, createMemo, createSignal, createUniqueId, onMount } from 'solid-js';
import { store, setActiveTask, getTaskDotStatus, uncollapseTask } from '../store/store';
import { getCoordinatorChildren } from '../store/sidebar-order';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { StatusDot } from './StatusDot';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { Dialog } from './Dialog';
import { CheckIcon, CloseIcon } from './icons';

interface SubTaskStripProps {
  coordinatorTaskId: string;
}

interface MCPLogEntry {
  level: 'info' | 'error';
  msg: string;
  ts: number;
}

function MCPLogModal(props: { onClose: () => void }) {
  const [logs, setLogs] = createSignal<MCPLogEntry[]>([]);
  const [loading, setLoading] = createSignal(true);
  const titleId = createUniqueId();

  onMount(() => {
    void invoke<MCPLogEntry[]>(IPC.GetMCPLogs).then((entries) => {
      setLogs(entries);
      setLoading(false);
    });
  });

  return (
    <Dialog
      open={true}
      onClose={props.onClose}
      width="680px"
      labelledBy={titleId}
      panelStyle={{
        background: theme.bgElevated,
        'border-radius': 'var(--radius-md)',
        padding: '16px',
        'max-height': '60vh',
        gap: '8px',
      }}
    >
      <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
        <span id={titleId} style={{ 'font-size': sf(12), 'font-weight': '600', color: theme.fg }}>
          MCP Logs
        </span>
        <button
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: theme.fgSubtle,
            'font-size': sf(14),
          }}
          onClick={() => props.onClose()}
        >
          <CloseIcon size={14} />
        </button>
      </div>
      <div
        style={{
          'overflow-y': 'auto',
          'font-family': "'JetBrains Mono', monospace",
          'font-size': sf(11),
          background: theme.bgInput,
          'border-radius': 'var(--radius-xs)',
          padding: '8px',
          flex: '1',
          'min-height': '0',
        }}
      >
        <Show when={!loading()} fallback={<span style={{ color: theme.fgSubtle }}>Loading…</span>}>
          <Show
            when={logs().length > 0}
            fallback={<span style={{ color: theme.fgSubtle }}>No MCP log entries yet.</span>}
          >
            <For each={logs()}>
              {(entry) => (
                <div
                  style={{
                    color: entry.level === 'error' ? theme.error : theme.fgMuted,
                    'margin-bottom': '2px',
                  }}
                >
                  <span style={{ color: theme.fgSubtle }}>
                    {new Date(entry.ts).toLocaleTimeString()}{' '}
                  </span>
                  <span style={{ color: entry.level === 'error' ? theme.error : theme.fg }}>
                    [{entry.level}]{' '}
                  </span>
                  {entry.msg}
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
      <div style={{ 'font-size': sf(11), color: theme.fgSubtle }}>
        Showing last 200 entries. Refresh to reload.
        <button
          style={{
            'margin-left': '8px',
            background: 'none',
            border: `1px solid ${theme.border}`,
            cursor: 'pointer',
            color: theme.fgMuted,
            'font-size': sf(11),
            'border-radius': 'var(--radius-xs)',
            padding: '1px 6px',
          }}
          onClick={() => {
            setLoading(true);
            void invoke<MCPLogEntry[]>(IPC.GetMCPLogs).then((entries) => {
              setLogs(entries);
              setLoading(false);
            });
          }}
        >
          Refresh
        </button>
      </div>
    </Dialog>
  );
}

export function SubTaskStrip(props: SubTaskStripProps) {
  const [showLogs, setShowLogs] = createSignal(false);

  const subTasks = createMemo(() => {
    const { active, collapsed } = getCoordinatorChildren(props.coordinatorTaskId);
    return [...active, ...collapsed].map((id) => store.tasks[id]).filter(Boolean);
  });

  const taskTone = (task: (typeof store.tasks)[string]) => {
    if (task.landingState === 'landed_pending_review' || task.landingState === 'reviewed') {
      return { color: theme.success, label: 'landed' };
    }
    if (
      task.landingState === 'landed_cleanup_failed' ||
      task.landingState === 'landing_escalated'
    ) {
      return { color: theme.warning, label: task.landingState };
    }
    if (task.landingState === 'landing_failed') {
      return { color: theme.error, label: 'landing failed' };
    }
    if (task.signalDoneReceived) return { color: theme.success, label: 'signalled done' };
    return null;
  };

  return (
    <>
      <Show when={showLogs()}>
        <MCPLogModal onClose={() => setShowLogs(false)} />
      </Show>
      <Show when={subTasks().length > 0}>
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '6px',
            padding: '4px 10px',
            background: theme.bgInput,
            'border-bottom': `1px solid ${theme.border}`,
            'overflow-x': 'auto',
            'flex-shrink': '0',
          }}
        >
          <span
            style={{
              'font-size': sf(11),
              color: theme.fgSubtle,
              'white-space': 'nowrap',
              'flex-shrink': '0',
            }}
          >
            Sub-tasks:
          </span>
          <For each={subTasks()}>
            {(task) => (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (task.collapsed) {
                    uncollapseTask(task.id);
                  }
                  setActiveTask(task.id);
                }}
                title={taskTone(task) ? `${task.name} — ${taskTone(task)?.label}` : task.name}
                style={{
                  display: 'inline-flex',
                  'align-items': 'center',
                  gap: '4px',
                  padding: '2px 8px',
                  'border-radius': '999px',
                  background: taskTone(task)
                    ? `color-mix(in srgb, ${taskTone(task)?.color} 12%, transparent)`
                    : `color-mix(in srgb, ${theme.fgSubtle} 8%, transparent)`,
                  border: `1px solid ${taskTone(task) ? `${taskTone(task)?.color}44` : theme.border}`,
                  color: theme.fgMuted,
                  'font-size': sf(11),
                  'font-family': "'JetBrains Mono', monospace",
                  cursor: 'pointer',
                  'white-space': 'nowrap',
                  'max-width': '160px',
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis',
                  'flex-shrink': '0',
                }}
              >
                <Show
                  when={taskTone(task)}
                  fallback={<StatusDot status={getTaskDotStatus(task.id)} size="sm" />}
                >
                  {(tone) => (
                    <span style={{ color: tone().color, display: 'inline-flex' }}>
                      <CheckIcon size={10} />
                    </span>
                  )}
                </Show>
                <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>{task.name}</span>
              </button>
            )}
          </For>
          <Show when={store.verboseLogging}>
            <button
              onClick={() => setShowLogs(true)}
              title="View MCP logs"
              style={{
                'margin-left': 'auto',
                'flex-shrink': '0',
                background: 'none',
                border: `1px solid ${theme.border}`,
                'border-radius': 'var(--radius-sm)',
                cursor: 'pointer',
                color: theme.fgSubtle,
                'font-size': sf(11),
                padding: '1px 6px',
                'white-space': 'nowrap',
              }}
            >
              MCP logs
            </button>
          </Show>
        </div>
      </Show>
      <Show when={subTasks().length === 0 && store.verboseLogging}>
        <div
          style={{
            display: 'flex',
            'justify-content': 'flex-end',
            padding: '3px 10px',
            background: theme.bgInput,
            'border-bottom': `1px solid ${theme.border}`,
            'flex-shrink': '0',
          }}
        >
          <button
            onClick={() => setShowLogs(true)}
            title="View MCP logs"
            style={{
              background: 'none',
              border: `1px solid ${theme.border}`,
              'border-radius': 'var(--radius-sm)',
              cursor: 'pointer',
              color: theme.fgSubtle,
              'font-size': sf(11),
              padding: '1px 6px',
              'white-space': 'nowrap',
            }}
          >
            MCP logs
          </button>
        </div>
      </Show>
    </>
  );
}
