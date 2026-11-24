import { For, Show, createEffect } from 'solid-js';
import { getTaskAttentionState, getTaskDotStatus, store } from '../store/store';
import { StatusDot } from './StatusDot';
import { cancelCycle, commitCycle, cycle, selectCycled } from './task-cycle';
import { switcherItem } from './TaskSwitcher';

/**
 * The list shown while Ctrl stays down after Ctrl+Tab. It never takes focus:
 * the keys keep going to the shortcut handlers, and the keyboard is still in
 * the pane it was in when the switch lands. role="dialog" also hides native
 * browser views, which would otherwise paint over it.
 */
export function TaskCycleList() {
  const shown = () => {
    const c = cycle();
    return c?.visible ? c : null;
  };
  let listRef: HTMLUListElement | undefined;
  const pick = (index: number): void => {
    selectCycled(index);
    commitCycle();
  };

  createEffect(() => {
    const index = shown()?.index ?? -1;
    if (index >= 0) listRef?.children[index]?.scrollIntoView({ block: 'nearest' });
  });

  return (
    <Show when={shown()}>
      {(c) => (
        <div
          class="task-cycle-backdrop"
          // Not .dialog-overlay: that would stop the Ctrl+Tab presses that move
          // the selection. Closing on click, not press, keeps the rest of the
          // gesture off the app underneath; the press keeps the keyboard where it is.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            if (e.target === e.currentTarget) cancelCycle();
          }}
          // A macOS click with Ctrl down arrives only as a context menu.
          onContextMenu={(e) => {
            e.preventDefault();
            if (e.target === e.currentTarget) cancelCycle();
          }}
        >
          <div class="task-cycle" role="dialog" aria-label="Switch task">
            <ul ref={listRef} role="listbox" aria-label="Open tasks" class="task-switcher-list">
              <For each={c().ids}>
                {(id, index) => (
                  <li
                    role="option"
                    aria-selected={index() === c().index}
                    aria-current={id === store.activeTaskId ? 'true' : undefined}
                    class="task-switcher-option"
                    onMouseMove={() => selectCycled(index())}
                    onClick={() => pick(index())}
                    onContextMenu={() => pick(index())}
                  >
                    <span class="task-switcher-dot">
                      <Show when={store.tasks[id]}>
                        <StatusDot
                          status={getTaskDotStatus(id)}
                          taskId={id}
                          size="sm"
                          attention={getTaskAttentionState(id)}
                        />
                      </Show>
                    </span>
                    <span class="task-switcher-name">{switcherItem(id).name}</span>
                    <span class="task-switcher-detail">{switcherItem(id).detail}</span>
                    <Show when={id === store.activeTaskId}>
                      <span class="task-switcher-shortcut">current</span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </div>
      )}
    </Show>
  );
}
