import { Match, Switch, createEffect, createSignal, untrack, type JSX } from 'solid-js';
import { githubAgentTaskId } from '../documents/task-id';
import { setStore, store } from '../store/core';
import { triggerFocus } from '../store/focused-panel';
import { ensureGitHubAgentTask, githubAgentAvailability } from '../store/github-agent';
import type { Project } from '../store/types';
import { HiddenAgentPane } from './HiddenAgentPane';
import { CloseIcon } from './icons';

export interface AgentPaneState {
  open: () => boolean;
  setOpen: (open: boolean) => void;
}

// Until the user chooses, the pane is open only where the project already has an
// agent task: opening the page must not start a paid session.
export function createAgentPaneState(projectId: string): AgentPaneState {
  const [choice, setOpen] = createSignal<boolean | undefined>(undefined);
  return {
    open: () => choice() ?? store.tasks[githubAgentTaskId(projectId)] !== undefined,
    setOpen,
  };
}

export function agentsLoadingText(): string {
  return githubAgentAvailability() === 'failed'
    ? 'Could not load the agent list.'
    : 'Loading agents…';
}

/** Mounted only while the pane is open, so starting here never happens behind a closed pane. */
export function GitHubAgentPane(props: {
  project: Project;
  agentPane: AgentPaneState;
  /** What to suggest asking; the GitHub page asks for issue lists. */
  hint?: JSX.Element;
  label?: string;
}) {
  const taskId = () => githubAgentTaskId(props.project.id);
  // Starts once the agent list is known; a started task ends the effect's work, so
  // re-runs (availability changes, task appearing) cannot start a second session.
  createEffect(() => {
    if (githubAgentAvailability() !== 'ready' || store.tasks[taskId()]) return;
    if (!untrack(() => ensureGitHubAgentTask(props.project))) return;
    // The prompt registers its focus function once the pane has mounted.
    const promptKey = `${taskId()}:prompt`;
    queueMicrotask(() => triggerFocus(promptKey));
  });
  return (
    <aside class="github-agent" aria-label={props.label ?? 'GitHub agent'}>
      <header>
        <div class="github-agent-title">
          <strong>Agent</strong>
          {/* Shown only where the pane overlays the page and covers the Agent toggle. */}
          <button
            type="button"
            class="github-agent-close"
            aria-label="Close agent panel"
            onClick={() => props.agentPane.setOpen(false)}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <small>
          {props.hint ??
            'Ask for a list, such as “the most important issues this week, by priority, grouped by area”.'}
        </small>
      </header>
      <HiddenAgentPane
        task={store.tasks[taskId()]}
        visible
        fallback={
          <div class="github-issues-empty" role="status">
            <Switch fallback={<p>{agentsLoadingText()}</p>}>
              <Match when={githubAgentAvailability() === 'none'}>
                <p>No agent is installed. Install a coding agent to ask for custom lists here.</p>
              </Match>
              <Match when={githubAgentAvailability() === 'ready'}>
                <p>Starting the agent…</p>
              </Match>
            </Switch>
          </div>
        }
        onSelectAgent={(agentId) => setStore('tasks', taskId(), 'selectedAgentId', agentId)}
      />
    </aside>
  );
}
