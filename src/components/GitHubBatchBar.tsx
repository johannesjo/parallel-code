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
import { CheckIcon, CloseIcon, PlanIcon, ListIcon, SparkleIcon } from './icons';
import { addIssuesToBoard } from '../store/kanban';

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
  const draftNote = 'Finish or dismiss your task draft to start batch triage.';
  // What keeps a batch action from working, as opposed to routine guidance.
  const blocker = () =>
    store.showNewTaskPanel
      ? draftNote
      : agentReady()
        ? ''
        : githubAgentAvailability() === 'none'
          ? 'Install a coding agent to list with an agent.'
          : agentsLoadingText();
  const listNote = () =>
    githubAgentAvailability() === 'none'
      ? 'Install a coding agent to list with an agent.'
      : !agentReady()
        ? agentsLoadingText()
        : !props.view.selected.length
          ? 'Select items to list them.'
          : !store.tasks[githubAgentTaskId(props.project.id)]
            ? 'Starts the agent session and drafts a prompt.'
            : 'Group related work, find duplicates, and prioritize a batch.';
  const [addingToBoard, setAddingToBoard] = createSignal(false);
  async function addSelectedToBoard() {
    setAddingToBoard(true);
    try {
      await addIssuesToBoard(props.project.id, [...props.view.selected]);
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
        disabled={!props.view.selected.length || addingToBoard()}
        title="Add the selected items as cards to the project's plan (KANBAN.md)"
        onClick={() => void addSelectedToBoard()}
      >
        <PlanIcon /> Add to plan
      </button>
      <button
        class="github-issue-primary"
        disabled={!props.view.selected.length || store.showNewTaskPanel}
        aria-describedby="github-triage-note"
        title={store.showNewTaskPanel ? draftNote : 'Start a task where an agent triages the batch'}
        onClick={() => startGitHubTriageTask(props.project.id, [...props.view.selected])}
      >
        <SparkleIcon /> Triage with agent
      </button>
      {/* Notes live in tooltips; these hidden copies keep them for screen readers. */}
      <span id="github-triage-note" class="dialog-sr-only">
        {store.showNewTaskPanel ? draftNote : ''}
      </span>
      <button
        disabled={!props.view.selected.length || !agentReady()}
        aria-describedby="github-list-agent-note"
        title={listNote()}
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
      <span id="github-list-agent-note" class="dialog-sr-only">
        {listNote()}
      </span>
      {/* Blockers stay visible, since disabled buttons rarely show their tooltip. */}
      <Show when={blocker()}>
        <small aria-hidden="true">{blocker()}</small>
      </Show>
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
