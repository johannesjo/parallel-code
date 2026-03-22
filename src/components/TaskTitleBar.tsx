import { Show } from 'solid-js';
import {
  store,
  reorderTask,
  setActiveTask,
  updateTaskName,
  collapseTask,
  getTaskDotStatus,
} from '../store/store';
import { EditableText, type EditableTextHandle } from './EditableText';
import { IconButton } from './IconButton';
import { StatusDot } from './StatusDot';
import { theme } from '../lib/theme';
import { handleDragReorder } from '../lib/dragReorder';
import type { Task } from '../store/types';

interface TaskTitleBarProps {
  task: Task;
  isActive: boolean;
  onClose: () => void;
  onMerge: () => void;
  onPush: () => void;
  pushing: boolean;
  pushSuccess: boolean;
  onTitleEditRef: (h: EditableTextHandle) => void;
}

export function TaskTitleBar(props: TaskTitleBarProps) {
  function handleTitleMouseDown(e: MouseEvent) {
    handleDragReorder(e, {
      itemId: props.task.id,
      getTaskOrder: () => store.taskOrder,
      onReorder: reorderTask,
      onTap: () => setActiveTask(props.task.id),
    });
  }

  return (
    <div
      class={props.isActive ? 'island-header-active' : ''}
      style={{
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'space-between',
        padding: '0 10px',
        height: '100%',
        background: 'transparent',
        'border-bottom': `1px solid ${theme.border}`,
        'user-select': 'none',
        cursor: 'grab',
      }}
      onMouseDown={handleTitleMouseDown}
    >
      <div
        style={{
          overflow: 'hidden',
          flex: '1',
          'min-width': '0',
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
        }}
      >
        <StatusDot status={getTaskDotStatus(props.task.id)} size="md" />
        <Show when={props.task.directMode}>
          <span
            style={{
              'font-size': '11px',
              'font-weight': '600',
              padding: '2px 8px',
              'border-radius': '4px',
              background: `color-mix(in srgb, ${theme.warning} 15%, transparent)`,
              color: theme.warning,
              border: `1px solid color-mix(in srgb, ${theme.warning} 25%, transparent)`,
              'flex-shrink': '0',
              'white-space': 'nowrap',
            }}
          >
            {props.task.branchName}
          </span>
        </Show>
        <Show when={props.task.dockerMode}>
          <span
            style={{
              'font-size': '11px',
              'font-weight': '600',
              padding: '2px 8px',
              'border-radius': '4px',
              background: `color-mix(in srgb, ${theme.fgMuted} 15%, transparent)`,
              color: theme.fgMuted,
              border: `1px solid color-mix(in srgb, ${theme.fgMuted} 25%, transparent)`,
              'flex-shrink': '0',
              'white-space': 'nowrap',
            }}
          >
            Docker
          </span>
        </Show>
        <EditableText
          value={props.task.name}
          onCommit={(v) => updateTaskName(props.task.id, v)}
          class="editable-text"
          title={props.task.savedInitialPrompt}
          ref={(h) => props.onTitleEditRef(h)}
        />
      </div>
      <div style={{ display: 'flex', gap: '4px', 'margin-left': '8px', 'flex-shrink': '0' }}>
        <Show when={!props.task.directMode}>
          <IconButton
            icon={
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
              </svg>
            }
            onClick={() => props.onMerge()}
            title="Merge into main"
          />
          <div style={{ position: 'relative', display: 'inline-flex' }}>
            <Show
              when={!props.pushing}
              fallback={
                <div
                  style={{
                    display: 'inline-flex',
                    'align-items': 'center',
                    'justify-content': 'center',
                    padding: '4px',
                    border: `1px solid ${theme.border}`,
                    'border-radius': '6px',
                  }}
                >
                  <span class="inline-spinner" style={{ width: '14px', height: '14px' }} />
                </div>
              }
            >
              <IconButton
                icon={
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path
                      d="M4.75 8a.75.75 0 0 1 .75-.75h5.19L8.22 4.78a.75.75 0 0 1 1.06-1.06l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 1 1-1.06-1.06l2.47-2.47H5.5A.75.75 0 0 1 4.75 8Z"
                      transform="rotate(-90 8 8)"
                    />
                  </svg>
                }
                onClick={() => props.onPush()}
                title="Push to remote"
              />
            </Show>
            <Show when={props.pushSuccess}>
              <div
                style={{
                  position: 'absolute',
                  bottom: '-4px',
                  right: '-4px',
                  width: '12px',
                  height: '12px',
                  'border-radius': '50%',
                  background: theme.success,
                  display: 'flex',
                  'align-items': 'center',
                  'justify-content': 'center',
                  'pointer-events': 'none',
                }}
              >
                <svg width="8" height="8" viewBox="0 0 16 16" fill="white">
                  <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
                </svg>
              </div>
            </Show>
          </div>
        </Show>
        <IconButton
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 8a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8Z" />
            </svg>
          }
          onClick={() => collapseTask(props.task.id)}
          title="Collapse task"
        />
        <IconButton
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
            </svg>
          }
          onClick={() => props.onClose()}
          title="Close task"
        />
      </div>
    </div>
  );
}
