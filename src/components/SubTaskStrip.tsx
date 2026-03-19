import { For, Show, createMemo } from 'solid-js';
import { store, setActiveTask, getTaskDotStatus } from '../store/store';
import { StatusDot } from './StatusDot';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';

interface SubTaskStripProps {
  coordinatorTaskId: string;
}

export function SubTaskStrip(props: SubTaskStripProps) {
  const subTasks = createMemo(() =>
    store.taskOrder
      .map((id) => store.tasks[id])
      .filter((t) => t && t.coordinatedBy === props.coordinatorTaskId),
  );

  return (
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
            'font-size': sf(10),
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
                setActiveTask(task.id);
              }}
              title={task.name}
              style={{
                display: 'inline-flex',
                'align-items': 'center',
                gap: '4px',
                padding: '2px 8px',
                'border-radius': '10px',
                background: `color-mix(in srgb, ${theme.fgSubtle} 8%, transparent)`,
                border: `1px solid ${theme.border}`,
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
              <StatusDot status={getTaskDotStatus(task.id)} size="sm" />
              <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>{task.name}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
