import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on } from 'solid-js';
import { documentAgentTaskId } from '../documents/task-id';
import { loadRecentActions, orderByRecency, rememberAction } from '../lib/switcher-actions';
import { filterSwitcherItems, parseSwitcherQuery, type SwitcherItem } from '../lib/task-switcher';
import {
  activateTaskFromPointer,
  getTaskAttentionState,
  getTaskDotStatus,
  store,
} from '../store/store';
import { openItemName } from '../store/navigation';
import { sortByProjectGroup } from '../store/sidebar-order';
import { Dialog } from './Dialog';
import { StatusDot } from './StatusDot';

/** Every open item across projects, in tile order; collapsed tasks stay out
 *  because reopening one restarts its agents. */
function switcherItems(): SwitcherItem[] {
  const documentProjectId = store.activeDocumentProjectId;
  const taskOrder = sortByProjectGroup(store.taskOrder);
  const ids = documentProjectId
    ? [...taskOrder, documentAgentTaskId(documentProjectId)]
    : taskOrder;
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

interface Match {
  item: SwitcherItem;
  kind: 'task' | 'action';
}

/**
 * Keyboard-first jump to any open task by typing part of its name, project or
 * branch, or run a shortcut action by name. Tasks list first, as the common
 * case; a leading ">" leaves only actions.
 */
export function TaskSwitcher(props: {
  open: boolean;
  onClose: () => void;
  actions?: SwitcherItem[];
  onAction?: (id: string) => void;
}) {
  const listId = createUniqueId();
  const [query, setQuery] = createSignal('');
  const [selected, setSelected] = createSignal(0);
  const parsed = () => parseSwitcherQuery(query());
  const taskMatches = createMemo(() =>
    parsed().actionsOnly ? [] : filterSwitcherItems(switcherItems(), parsed().text),
  );
  const [recent, setRecent] = createSignal(loadRecentActions());
  // Recency first, so among equally good matches the last-used action wins.
  const actionMatches = createMemo(() =>
    filterSwitcherItems(orderByRecency(props.actions ?? [], recent()), parsed().text, {
      searchDetail: false,
    }),
  );
  const matches = createMemo((): Match[] => [
    ...taskMatches().map((item) => ({ item, kind: 'task' as const })),
    ...actionMatches().map((item) => ({ item, kind: 'action' as const })),
  ]);
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

  function choose(match: Match): void {
    // Close first so the dialog's focus restore finds focus already moved,
    // and so an action that opens its own dialog lands on top of nothing.
    props.onClose();
    if (match.kind === 'task') {
      activateTaskFromPointer(match.item.id);
      return;
    }
    setRecent(rememberAction(match.item.id, recent()));
    // A frame later, after the dialog's focus restore (queued by onClose)
    // puts focus back where the shortcut would have been pressed: a dialog
    // the action opens then saves that spot, not <body>, to return to.
    const id = match.item.id;
    requestAnimationFrame(() => props.onAction?.(id));
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
      const match = matches()[active()];
      if (match) choose(match);
    }
  }

  const optionId = (index: number) => `${listId}-${index}`;

  createEffect(() => {
    if (!props.open) return;
    document.getElementById(optionId(active()))?.scrollIntoView({ block: 'nearest' });
  });

  // A component, so index stays reactive: the action rows' positions shift as
  // the task matches change.
  const Option = (option: { match: Match; index: number }) => (
    <li
      id={optionId(option.index)}
      role="option"
      aria-selected={option.index === active()}
      class="task-switcher-option"
      onMouseMove={() => setSelected(option.index)}
      onClick={() => choose(option.match)}
    >
      <span class="task-switcher-dot">
        <Show when={option.match.kind === 'task' && store.tasks[option.match.item.id]}>
          <StatusDot
            status={getTaskDotStatus(option.match.item.id)}
            taskId={option.match.item.id}
            size="sm"
            attention={getTaskAttentionState(option.match.item.id)}
          />
        </Show>
      </span>
      <span class="task-switcher-name">{option.match.item.name}</span>
      <span class="task-switcher-detail">{option.match.item.detail}</span>
      <Show when={option.match.item.shortcut}>
        <kbd class="task-switcher-shortcut">{option.match.item.shortcut}</kbd>
      </Show>
    </li>
  );

  const emptyText = () => {
    if (switcherItems().length === 0 && (props.actions ?? []).length === 0) return 'No open tasks.';
    if (parsed().actionsOnly) return 'No action matches.';
    return props.actions?.length ? 'No task or action matches.' : 'No open task matches.';
  };

  return (
    <Dialog
      open={props.open}
      onClose={() => props.onClose()}
      ariaLabel="Switch task or run action"
      width="520px"
      panelStyle={{ padding: '10px', gap: '6px' }}
      overlayStyle={{ 'align-items': 'flex-start', 'padding-top': '14vh' }}
    >
      <input
        ref={inputRef}
        class="task-switcher-input"
        type="text"
        role="combobox"
        aria-label="Switch to task or run action"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={matches().length > 0 ? optionId(active()) : undefined}
        placeholder={
          props.actions?.length
            ? 'Switch to task or run action… (> for actions)'
            : 'Switch to task…'
        }
        value={query()}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setSelected(0);
        }}
        onKeyDown={handleKeyDown}
      />
      <div id={listId} role="listbox" aria-label="Tasks and actions" class="task-switcher-list">
        <Show when={taskMatches().length > 0}>
          <ul role="group" aria-label="Open tasks" class="task-switcher-group">
            <For each={taskMatches()}>
              {(item, index) => <Option match={{ item, kind: 'task' }} index={index()} />}
            </For>
          </ul>
        </Show>
        <Show when={actionMatches().length > 0}>
          <ul role="group" aria-label="Actions" class="task-switcher-group">
            <li role="presentation" class="task-switcher-heading">
              Actions
            </li>
            <For each={actionMatches()}>
              {(item, index) => (
                <Option match={{ item, kind: 'action' }} index={taskMatches().length + index()} />
              )}
            </For>
          </ul>
        </Show>
      </div>
      <Show when={matches().length === 0}>
        <p class="task-switcher-empty">{emptyText()}</p>
      </Show>
    </Dialog>
  );
}
