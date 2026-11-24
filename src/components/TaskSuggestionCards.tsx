import './TaskSuggestionCards.css';
import { createSignal, For, onCleanup, Show } from 'solid-js';
import {
  dismissTaskSuggestion,
  editTaskSuggestion,
  pendingTaskSuggestions,
  startTaskSuggestion,
} from '../store/task-suggestions';
import { setActiveTask } from '../store/navigation';
import { showNotification } from '../store/notification';
import { store } from '../store/core';
import { errMessage } from '../lib/log';
import type { Task } from '../store/types';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from './icons';

/** How long the "Started" receipt stays; the new task is in the sidebar by then. */
const RECEIPT_MS = 6000;

/**
 * Separate tasks this task's agent suggested through `suggest_task`, previewed
 * before anything starts: the user reads the title, summary and full prompt,
 * then starts it, edits it in the New Task form, or dismisses it.
 */
export function TaskSuggestionCards(props: { task: Task }) {
  const pending = () => pendingTaskSuggestions(props.task);
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [starting, setStarting] = createSignal<ReadonlySet<string>>(new Set());
  const [receipts, setReceipts] = createSignal<readonly { title: string; taskId: string }[]>([]);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  onCleanup(() => timers.forEach(clearTimeout));

  const toggle = (
    set: (fn: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void,
    id: string,
    on: boolean,
  ) =>
    set((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const agentName = () => {
    const agentId = props.task.agentIds[0];
    return (agentId && store.agents[agentId]?.def.name) || 'the default agent';
  };

  async function start(id: string, title: string) {
    if (starting().has(id)) return;
    toggle(setStarting, id, true);
    try {
      const taskId = await startTaskSuggestion(props.task.id, id);
      setReceipts((list) => [...list, { title, taskId }]);
      const timer = setTimeout(() => {
        timers.delete(timer);
        setReceipts((list) => list.filter((r) => r.taskId !== taskId));
      }, RECEIPT_MS);
      timers.add(timer);
    } catch (error) {
      showNotification(`Could not start “${title}”: ${errMessage(error)}`);
    } finally {
      toggle(setStarting, id, false);
    }
  }

  function edit(id: string) {
    if (!editTaskSuggestion(props.task.id, id))
      showNotification('Finish or close the open New Task form first.');
  }

  return (
    <Show when={pending().length > 0 || receipts().length > 0}>
      <section class="task-suggestions" aria-label="Suggested tasks">
        <For each={receipts()}>
          {(receipt) => (
            <div class="task-suggestion-receipt" role="status">
              <CheckIcon size={12} />
              <span class="task-suggestion-receipt-text">Started “{receipt.title}”</span>
              <Show when={Object.hasOwn(store.tasks, receipt.taskId)}>
                <button
                  type="button"
                  class="task-suggestion-link"
                  onClick={() => setActiveTask(receipt.taskId)}
                >
                  Open
                </button>
              </Show>
            </div>
          )}
        </For>
        <For each={pending()}>
          {(suggestion) => {
            const open = () => expanded().has(suggestion.id);
            const busy = () => starting().has(suggestion.id);
            return (
              <article class="task-suggestion" aria-label={`Suggested task: ${suggestion.title}`}>
                <div class="task-suggestion-label">Suggested task</div>
                <div class="task-suggestion-title">{suggestion.title}</div>
                <p class="task-suggestion-tldr">{suggestion.tldr}</p>
                <div class="task-suggestion-actions">
                  <button
                    type="button"
                    class="task-suggestion-start"
                    disabled={busy()}
                    title={`Starts a new task with ${agentName()} in the background`}
                    onClick={() => void start(suggestion.id, suggestion.title)}
                  >
                    {busy() ? 'Starting…' : 'Start task'}
                  </button>
                  <button
                    type="button"
                    disabled={busy()}
                    title="Open in the New Task form to change the prompt, agent or branch"
                    onClick={() => edit(suggestion.id)}
                  >
                    Edit first
                  </button>
                  <button
                    type="button"
                    class="task-suggestion-dismiss"
                    disabled={busy()}
                    onClick={() => dismissTaskSuggestion(props.task.id, suggestion.id)}
                  >
                    Dismiss
                  </button>
                  <button
                    type="button"
                    class="task-suggestion-disclosure"
                    aria-expanded={open()}
                    onClick={() => toggle(setExpanded, suggestion.id, !open())}
                  >
                    {open() ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                    {open() ? 'Hide prompt' : 'Show prompt'}
                  </button>
                </div>
                <Show when={open()}>
                  <pre class="task-suggestion-prompt">{suggestion.prompt}</pre>
                </Show>
              </article>
            );
          }}
        </For>
      </section>
    </Show>
  );
}
