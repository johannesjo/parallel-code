import { For, Show, createSignal } from 'solid-js';
import type { SetStoreFunction } from 'solid-js/store';
import { githubAgentTaskId } from '../documents/task-id';
import { store } from '../store/core';
import { GITHUB_BATCH_LIMIT, startGitHubTriageTask } from '../store/github';
import { githubAgentAvailability, prefillGitHubAgentPrompt } from '../store/github-agent';
import type { GitHubIssueSummary } from '../ipc/types';
import type { Project } from '../store/types';
import { agentsLoadingText, type AgentPaneState } from './GitHubAgentPane';
import type { BrowserSession } from './github-issues-session';
import { CheckIcon, CloseIcon, KanbanIcon, ListIcon, SparkleIcon } from './icons';
import { addIssuesToBoard } from '../store/kanban';
import { showNotification } from '../store/notification';

export function GitHubBatchBar(props: {
  project: Project;
  agentPane: AgentPaneState;
  view: BrowserSession;
  setView: SetStoreFunction<BrowserSession>;
  loading: boolean;
  error: string;
  toggleSelected: (item: GitHubIssueSummary) => void;
}) {
  const agentReady = () => githubAgentAvailability() === 'ready';
  const [addingToBoard, setAddingToBoard] = createSignal(false);
  async function addSelectedToBoard() {
    setAddingToBoard(true);
    try {
      const added = await addIssuesToBoard(props.project.id, [...props.view.selected]);
      if (added !== null) {
        const skipped = props.view.selected.length - added;
        showNotification(
          `Added ${added} ${added === 1 ? 'card' : 'cards'} to the Kanban board` +
            (skipped ? `; ${skipped} already on it` : ''),
        );
      }
    } finally {
      setAddingToBoard(false);
    }
  }
  function selectPage(items: GitHubIssueSummary[]) {
    props.setView('selected', (selected) => {
      const all = new Map(selected.map((item) => [item.url, item]));
      for (const item of items) all.set(item.url, item);
      return [...all.values()].slice(0, GITHUB_BATCH_LIMIT);
    });
  }
  return (
    <div class="github-triage-batch">
      <button
        disabled={props.loading || !!props.error || !props.view.result?.items.length}
        title={`Adds visible items up to the ${GITHUB_BATCH_LIMIT}-item batch limit`}
        onClick={() => selectPage(props.view.result?.items ?? [])}
      >
        <CheckIcon /> Select page
      </button>
      <span>
        {props.view.selected.length} / {GITHUB_BATCH_LIMIT} selected
      </span>
      <button disabled={!props.view.selected.length} onClick={() => props.setView('selected', [])}>
        <CloseIcon /> Clear selection
      </button>
      <button
        class="github-issue-primary"
        disabled={!props.view.selected.length || store.showNewTaskPanel}
        aria-describedby="github-triage-note"
        onClick={() => startGitHubTriageTask(props.project.id, [...props.view.selected])}
      >
        <SparkleIcon /> Triage with agent
      </button>
      <button
        disabled={!props.view.selected.length || addingToBoard()}
        title="Add the selected items as cards to the project's Kanban board"
        onClick={() => void addSelectedToBoard()}
      >
        <KanbanIcon size={12} /> Add to board
      </button>
      <Show when={store.showNewTaskPanel}>
        <small id="github-triage-note">
          Finish or dismiss your task draft to start batch triage.
        </small>
      </Show>
      <button
        disabled={!props.view.selected.length || !agentReady()}
        aria-describedby="github-list-agent-note"
        title="Ask the agent panel to group and order the selected items"
        onClick={() => {
          const urls = props.view.selected.map((item) => item.url).join('\n');
          // Open only once the prompt landed; a pane with no task shows why instead.
          if (
            prefillGitHubAgentPrompt(
              props.project,
              `Group and order these GitHub items by priority, then publish the list with github_list_publish:\n${urls}`,
            )
          )
            props.agentPane.setOpen(true);
        }}
      >
        <ListIcon /> List with agent
      </button>
      <small id="github-list-agent-note">
        {githubAgentAvailability() === 'none'
          ? 'Install a coding agent to list with an agent.'
          : !agentReady()
            ? agentsLoadingText()
            : !props.view.selected.length
              ? 'Select items to list them.'
              : !store.tasks[githubAgentTaskId(props.project.id)]
                ? 'Starts the agent session and drafts a prompt.'
                : 'Group related work, find duplicates, and prioritize a batch.'}
      </small>
      <Show when={props.view.selected.length}>
        <details>
          <summary>Selected items</summary>
          <For each={props.view.selected}>
            {(item) => (
              <div>
                <button
                  aria-label={`Remove #${item.number} from selection`}
                  onClick={() => props.toggleSelected(item)}
                >
                  <CloseIcon size={10} />
                </button>{' '}
                #{item.number} {item.title}
              </div>
            )}
          </For>
        </details>
      </Show>
    </div>
  );
}
