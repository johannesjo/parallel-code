import { For, Show } from 'solid-js';
import { getTaskAttentionState, getTaskDotStatus, setActiveTask, store } from '../store/store';
import { StatusDot } from './StatusDot';

/** Title-bar switcher: one named pill per open item. The active pill is
 *  accent-tinted; task pills carry the same status glyph as the sidebar so
 *  the bar doubles as an at-a-glance overview. */
export function FocusModeTaskIndicators() {
  const items = () =>
    store.taskOrder.map((id) => ({
      id,
      isTask: Boolean(store.tasks[id]),
      name: store.tasks[id]?.name ?? store.terminals[id]?.name ?? 'Open item',
    }));

  return (
    <Show when={items().length > 0}>
      <div class="focus-mode-task-indicators">
        <For each={items()}>
          {(item) => {
            const isActive = () => item.id === store.activeTaskId;
            return (
              <button
                type="button"
                class={`focus-mode-task-indicator${isActive() ? ' active' : ''}`}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => setActiveTask(item.id)}
                title={isActive() ? `${item.name} (current)` : `Switch to ${item.name}`}
                aria-label={isActive() ? `${item.name}, current item` : `Switch to ${item.name}`}
                aria-current={isActive() ? 'true' : undefined}
              >
                <Show when={item.isTask}>
                  <StatusDot
                    status={getTaskDotStatus(item.id)}
                    size="sm"
                    attention={getTaskAttentionState(item.id)}
                  />
                </Show>
                <span class="focus-mode-task-indicator-name">{item.name}</span>
              </button>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
