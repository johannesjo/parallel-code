import './Delegation.css';
import { For, Show, createMemo, createSignal, createUniqueId, onMount } from 'solid-js';
import {
  store,
  activateTaskFromPointer,
  getTaskDotStatus,
  uncollapseTask,
  showNotification,
} from '../store/store';
import { getCoordinatorChildren } from '../store/sidebar-order';
import { getChildAttentionSummary } from '../store/sidebar-attention';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { StatusDot, getDotTooltip } from './StatusDot';
import { getTaskAttentionState } from '../store/taskStatus';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { Dialog } from './Dialog';
import { ChevronDownIcon, ChevronRightIcon, CloseIcon, StopIcon, SyncIcon } from './icons';

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
          class="btn-with-icon"
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
          <SyncIcon size={12} />
          Refresh
        </button>
      </div>
    </Dialog>
  );
}

export function SubTaskStrip(props: SubTaskStripProps) {
  const [showLogs, setShowLogs] = createSignal(false);
  const summary = createMemo(() => getChildAttentionSummary(props.coordinatorTaskId));

  const subTasks = createMemo(() => {
    const { active, collapsed } = getCoordinatorChildren(props.coordinatorTaskId);
    return [...active, ...collapsed].map((id) => store.tasks[id]).filter(Boolean);
  });

  // `urgent` tones get a tinted chip; plain merged work stays neutral.
  const taskTone = (
    task: (typeof store.tasks)[string],
  ): { color: string; label: string; urgent: boolean } | null => {
    if (task.landingState === 'landed_pending_review') {
      return { color: theme.warning, label: 'Merged · review pending', urgent: true };
    }
    if (task.landingState === 'reviewed') {
      return { color: theme.success, label: 'Merged', urgent: false };
    }
    if (
      task.landingState === 'landed_cleanup_failed' ||
      task.landingState === 'landing_escalated'
    ) {
      return {
        color: theme.warning,
        label:
          task.landingState === 'landed_cleanup_failed'
            ? 'Merged · cleanup failed'
            : 'Merge needs attention',
        urgent: true,
      };
    }
    if (task.landingState === 'landing_failed') {
      return { color: theme.error, label: 'Merge failed', urgent: true };
    }
    if (task.signalDoneReceived)
      return {
        color: theme.warning,
        label: task.integrationPolicy === 'review' ? 'Awaiting review' : 'Work complete',
        urgent: true,
      };
    return null;
  };

  // Wrapped rows keep every subtask visible in narrow columns; the toggle lets
  // a long list give its height back to the terminal.
  const [expanded, setExpanded] = createSignal(true);
  const listId = createUniqueId();

  return (
    <>
      <Show when={showLogs()}>
        <MCPLogModal onClose={() => setShowLogs(false)} />
      </Show>
      <Show when={subTasks().length > 0 || summary() || store.verboseLogging}>
        <div
          class="subtask-strip"
          style={{ background: theme.bgInput, 'border-bottom': `1px solid ${theme.border}` }}
        >
          <div class="subtask-strip-header">
            <Show when={subTasks().length > 0}>
              <button
                class="subtask-strip-toggle"
                aria-expanded={expanded()}
                aria-controls={listId}
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((v) => !v);
                }}
              >
                <Show when={expanded()} fallback={<ChevronRightIcon size={12} />}>
                  <ChevronDownIcon size={12} />
                </Show>
                Subtasks ({subTasks().length})
              </button>
            </Show>
            <Show when={summary()}>
              {(text) => <span class="subtask-strip-summary">{text()}</span>}
            </Show>
            <Show when={store.verboseLogging}>
              <button
                class="subtask-strip-logs"
                onClick={() => setShowLogs(true)}
                title="View MCP logs"
              >
                MCP logs
              </button>
            </Show>
          </div>
          {/* Stays mounted while collapsed so the toggle's aria-controls resolves. */}
          <Show when={subTasks().length > 0}>
            <ul id={listId} class="subtask-strip-list" hidden={!expanded()}>
              <For each={subTasks()}>
                {(task) => {
                  const tone = () => taskTone(task);
                  return (
                    <li class="subtask-strip-item">
                      <button
                        class="subtask-chip"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (task.collapsed) {
                            uncollapseTask(task.id);
                          }
                          activateTaskFromPointer(task.id);
                        }}
                        title={`${task.collapsed ? 'Resume and open: ' : ''}${task.name} — ${tone()?.label ?? getDotTooltip(getTaskDotStatus(task.id), getTaskAttentionState(task.id), task.id)}`}
                        data-urgent={tone()?.urgent ? '' : undefined}
                        style={{ '--tone': tone()?.color, 'font-size': sf(11) }}
                      >
                        <Show
                          when={tone()}
                          fallback={
                            <StatusDot
                              status={getTaskDotStatus(task.id)}
                              attention={getTaskAttentionState(task.id)}
                              taskId={task.id}
                              size="sm"
                            />
                          }
                        >
                          {(t) => (
                            <span style={{ color: t().color, display: 'inline-flex' }}>
                              <span aria-hidden="true">●</span>
                            </span>
                          )}
                        </Show>
                        <span class="subtask-name">
                          {task.collapsed ? 'Resume: ' : ''}
                          {task.name}
                        </span>
                        <span
                          class="subtask-status"
                          style={{ color: tone()?.color ?? theme.fgSubtle }}
                        >
                          {tone()?.label ??
                            getDotTooltip(
                              getTaskDotStatus(task.id),
                              getTaskAttentionState(task.id),
                              task.id,
                            ).split(' — ')[0]}
                        </span>
                      </button>
                      <Show
                        when={task.agentIds.some((id) => store.agents[id]?.status === 'running')}
                      >
                        <button
                          class="subtask-stop"
                          title={`Stop ${task.name}; keep its worktree`}
                          aria-label={`Stop ${task.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void Promise.all(
                              task.agentIds.map((agentId) => invoke(IPC.KillAgent, { agentId })),
                            ).catch((error: unknown) => showNotification(String(error)));
                          }}
                        >
                          <StopIcon size={12} />
                        </button>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </div>
      </Show>
    </>
  );
}
