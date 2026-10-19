import { For, Show } from 'solid-js';
import {
  getProject,
  getTaskAttentionState,
  getTaskDotStatus,
  activateTaskFromPointer,
  store,
} from '../store/store';
import { openItemName, openPanelOrder } from '../store/navigation';
import { StatusDot } from './StatusDot';

/** Title-bar switcher: one named pill per open item. The active pill is
 *  accent-tinted; task pills carry the same status glyph as the sidebar so
 *  the bar doubles as an at-a-glance overview. Each pill is ringed in its
 *  project's colour so tabs from the same project read as a group. */
export function FocusModeTaskIndicators() {
  const itemProjectId = (id: string): string | undefined => {
    if (
      store.activeDocumentProjectId &&
      id === documentAgentTaskId(store.activeDocumentProjectId)
    ) {
      return store.activeDocumentProjectId;
    }
    return store.tasks[id]?.projectId;
  };

  const projectColor = (id: string): string | undefined => {
    const projectId = itemProjectId(id);
    return projectId ? getProject(projectId)?.color : undefined;
  };

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
                style={{ '--tab-project-color': projectColor(item.id) }}
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
