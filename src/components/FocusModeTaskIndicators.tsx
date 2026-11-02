import { For, Show } from 'solid-js';
import {
  getTaskAttentionState,
  getTaskDotStatus,
  activateTaskFromPointer,
  store,
} from '../store/store';
import { openItemName, openPanelOrder } from '../store/navigation';
import { StatusDot } from './StatusDot';

/** Title-bar switcher: one named pill per open item. The active pill is
 *  accent-tinted; task pills carry the same status glyph as the sidebar so
 *  the bar doubles as an at-a-glance overview. */
export function FocusModeTaskIndicators() {
  const items = () =>
    openPanelOrder().map((id) => ({
      id,
      isTask: Boolean(store.tasks[id]),
      name: openItemName(id),
    }));

  // The board's cards carry the same glyphs, so the pills would only repeat them.
  return (
    <Show when={items().length > 0 && !store.boardView}>
      <div class="focus-mode-task-indicators">
        <For each={items()}>
          {(item) => {
            const isActive = () => item.id === store.activeTaskId;
            return (
              <button
                type="button"
                class={`focus-mode-task-indicator${isActive() ? ' active' : ''}`}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => activateTaskFromPointer(item.id)}
                title={isActive() ? `${item.name} (current)` : `Switch to ${item.name}`}
                aria-label={isActive() ? `${item.name}, current item` : `Switch to ${item.name}`}
                aria-current={isActive() ? 'true' : undefined}
              >
                <Show when={item.isTask}>
                  <StatusDot
                    status={getTaskDotStatus(item.id)}
                    taskId={item.id}
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
