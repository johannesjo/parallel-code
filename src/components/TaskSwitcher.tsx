import { For, Show, createEffect, createSignal, createUniqueId, on } from 'solid-js';
import { documentAgentTaskId } from '../documents/task-id';
import { filterSwitcherItems, type SwitcherItem } from '../lib/task-switcher';
import {
  activateTaskFromPointer,
  getTaskAttentionState,
  getTaskDotStatus,
  store,
} from '../store/store';
import { openItemName } from '../store/navigation';
import { Dialog } from './Dialog';
import { StatusDot } from './StatusDot';

/** Every open item across projects, in tile order; collapsed tasks stay out
 *  because reopening one restarts its agents. */
function switcherItems(): SwitcherItem[] {
  const documentProjectId = store.activeDocumentProjectId;
  const ids = documentProjectId
    ? [...store.taskOrder, documentAgentTaskId(documentProjectId)]
    : store.taskOrder;
  return ids.map((id) => {
    const task = store.tasks[id];
    const project = task && store.projects.find((p) => p.id === task.projectId);
    const detail = task
      ? [project?.name, task.branchName].filter(Boolean).join(' · ')
      : store.terminals[id]
        ? 'Terminal'
        : 'Document workspace';
    return { id, name: openItemName(id), detail };
  });
}

/** Keyboard-first jump to any open task by typing part of its name, project or branch. */
export function TaskSwitcher(props: { open: boolean; onClose: () => void }) {
  const listId = createUniqueId();
  const [query, setQuery] = createSignal('');
  const [selected, setSelected] = createSignal(0);
  const matches = () => filterSwitcherItems(switcherItems(), query());
  // Clamped, so a task closing while the switcher is open can't strand the highlight.
  const active = () => Math.max(0, Math.min(selected(), matches().length - 1));
  let inputRef: HTMLInputElement | undefined;

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setQuery('');
        setSelected(0);
        requestAnimationFrame(() => inputRef?.focus());
      },
    ),
  );

  function choose(id: string): void {
    // Close first so the dialog's focus restore finds focus already moved.
    props.onClose();
    activateTaskFromPointer(id);
  }

  function handleKeyDown(e: KeyboardEvent): void {
    const count = matches().length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (count === 0) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setSelected((active() + step + count) % count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = matches()[active()];
      if (item) choose(item.id);
    }
  }

  const optionId = (index: number) => `${listId}-${index}`;

  createEffect(() => {
    if (!props.open) return;
    document.getElementById(optionId(active()))?.scrollIntoView({ block: 'nearest' });
  });

  return (
    <Dialog
      open={props.open}
      onClose={() => props.onClose()}
      ariaLabel="Switch task"
      width="520px"
      panelStyle={{ padding: '10px', gap: '6px' }}
      overlayStyle={{ 'align-items': 'flex-start', 'padding-top': '14vh' }}
    >
      <input
        ref={inputRef}
        class="task-switcher-input"
        type="text"
        role="combobox"
        aria-label="Switch to task"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={matches().length > 0 ? optionId(active()) : undefined}
        placeholder="Switch to task…"
        value={query()}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setSelected(0);
        }}
        onKeyDown={handleKeyDown}
      />
      <ul id={listId} role="listbox" aria-label="Open tasks" class="task-switcher-list">
        <For each={matches()}>
          {(item, index) => (
            <li
              id={optionId(index())}
              role="option"
              aria-selected={index() === active()}
              class="task-switcher-option"
              onMouseMove={() => setSelected(index())}
              onClick={() => choose(item.id)}
            >
              <span class="task-switcher-dot">
                <Show when={store.tasks[item.id]}>
                  <StatusDot
                    status={getTaskDotStatus(item.id)}
                    taskId={item.id}
                    size="sm"
                    attention={getTaskAttentionState(item.id)}
                  />
                </Show>
              </span>
              <span class="task-switcher-name">{item.name}</span>
              <span class="task-switcher-detail">{item.detail}</span>
            </li>
          )}
        </For>
      </ul>
      <Show when={matches().length === 0}>
        <p class="task-switcher-empty">
          {switcherItems().length === 0 ? 'No open tasks.' : 'No open task matches.'}
        </p>
      </Show>
    </Dialog>
  );
}
