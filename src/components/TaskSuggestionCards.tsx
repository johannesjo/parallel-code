import './TaskSuggestionCards.css';
import { createSignal, For, Show } from 'solid-js';
import {
  dismissTaskSuggestion,
  editTaskSuggestion,
  isTaskSuggestionInHand,
  isTaskSuggestionStarting,
  pendingTaskSuggestions,
  startTaskSuggestion,
} from '../store/task-suggestions';
import { setActiveTask } from '../store/navigation';
import { NOTIFICATION_ERROR_MS, showNotification } from '../store/notification';
import { store } from '../store/core';
import { errMessage } from '../lib/log';
import type { Task } from '../store/types';
import { ChevronDownIcon, ChevronRightIcon } from './icons';

/**
 * Separate tasks this task's agent suggested through `suggest_task`, previewed
 * before anything starts: the user reads the title, summary and full prompt,
 * then starts it, edits it in the New Task form, or dismisses it.
 */
export function TaskSuggestionCards(props: { task: Task }) {
  const pending = () => pendingTaskSuggestions(props.task);
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  const agentName = () => {
    const agentId = props.task.agentIds[0];
    return (agentId && store.agents[agentId]?.def.name) || 'its agent';
  };

  async function start(id: string, title: string) {
    try {
      const taskId = await startTaskSuggestion(props.task.id, id);
      // A notice, not a line here: removing a line later would resize the terminal.
      showNotification(`Started “${title}”`, {
        tone: 'success',
        action: {
          label: 'Open',
          run: () => {
            if (taskId in store.tasks) setActiveTask(taskId);
          },
        },
      });
    } catch (error) {
      showNotification(`Could not start “${title}”: ${errMessage(error)}`, {
        durationMs: NOTIFICATION_ERROR_MS,
      });
    }
  }

  function edit(id: string) {
    if (!editTaskSuggestion(props.task.id, id))
      showNotification('Finish or close the open New Task form first.');
  }

  return (
    <Show when={pending().length > 0}>
      <section class="task-suggestions" aria-label="Suggested tasks">
        <For each={pending()}>
          {(suggestion) => {
            const open = () => expanded().has(suggestion.id);
            const busy = () => isTaskSuggestionInHand(suggestion.id);
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
                    {isTaskSuggestionStarting(suggestion.id) ? 'Starting…' : 'Start task'}
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
                    onClick={() => toggleExpanded(suggestion.id)}
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
