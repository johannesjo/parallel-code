import { Show } from 'solid-js';
import { withViewTransition } from '../lib/viewTransition';
import { store } from '../store/core';
import { isGitHubProject, openGitHubIssues } from '../store/github';
import {
  githubIssuesTargetProjectId,
  NO_GITHUB_ISSUES_TARGET,
} from '../store/github-issues-target';
import { openKanban, openPlanView, planViewProjectId } from '../store/kanban';
import { toggleNewTaskPanel } from '../store/navigation';
import { boardShown } from '../store/project-pages';
import { BoardSearch } from './BoardSearch';
import { GitHubIcon, PlanIcon } from './icons';
import { IdeasControl } from './TaskBoardIdeas';
import { TaskProjectFilter } from './TaskProjectFilter';
import { ToggleButton, ToggleGroup } from './ToggleGroup';
import { focusBoardCard } from './task-board-keys';
import './task-board.css';

/** On while the plan shows, off for the running tasks. */
function PlanToggle() {
  const projectName = () => store.projects.find((p) => p.id === planViewProjectId())?.name;
  const open = () => !!store.kanbanProjectId;
  return (
    <ToggleGroup label="Board page">
      <ToggleButton
        pressed={open()}
        title={open() ? 'Back to the running tasks' : `Planned work in ${projectName()}`}
        onClick={() => withViewTransition(() => (open() ? openKanban(null) : openPlanView()))}
      >
        <PlanIcon size={14} />
        Plan
      </ToggleButton>
    </ToggleGroup>
  );
}

/**
 * Opens the GitHub issues of the project in context (see
 * githubIssuesTargetProjectId), which cover the board until closed. Always
 * there, disabled while there is no project, gh is asked or says no: appearing
 * on a project or task pick would shift the row with nothing to cause it.
 */
function GitHubIssuesButton() {
  const project = () => store.projects.find((p) => p.id === githubIssuesTargetProjectId());
  const onGitHub = () => {
    const path = project()?.path;
    return path === undefined ? undefined : isGitHubProject(path);
  };
  const title = () => {
    const name = project()?.name;
    if (name === undefined) return NO_GITHUB_ISSUES_TARGET;
    if (onGitHub() === undefined) return `Checking ${name} for a GitHub repository`;
    if (onGitHub() === false) return `GitHub issues unavailable for ${name}`;
    return `GitHub issues in ${name}`;
  };
  return (
    <button
      type="button"
      class="task-board-new task-board-github"
      disabled={onGitHub() !== true}
      title={title()}
      aria-label="GitHub issues"
      onClick={() => {
        const id = project()?.id;
        if (id) openGitHubIssues(id);
      }}
    >
      <GitHubIcon size={14} />
    </button>
  );
}

/**
 * The board's actions in the title bar's middle slot, which the task pills
 * leave empty while the board shows: a new task, the sidebar's project filter
 * while the sidebar is hidden, the text filter, the plan toggle for that
 * project, and GitHub issues. The plan's own tools sit in its heading row.
 */
export function TaskBoardControls() {
  return (
    <Show when={boardShown()}>
      <div
        class="task-board-controls"
        role="group"
        aria-label="Board"
        onDblClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          class="task-board-new"
          onClick={() => withViewTransition(() => toggleNewTaskPanel(true))}
        >
          + New task
        </button>
        {/* The Ideas lane lives on the running-tasks board, not the plan. */}
        <Show when={!store.kanbanProjectId}>
          <IdeasControl />
        </Show>
        {/* The plan follows the selected project, so it needs a picker in reach. */}
        <Show when={!store.sidebarVisible}>
          {/* Board keys only work from a card, so hand the keyboard back after a pick. */}
          <TaskProjectFilter hideLabel onPick={() => focusBoardCard(store.activeTaskId)} />
        </Show>
        <BoardSearch what={store.kanbanProjectId ? 'plan' : 'running tasks'} />
        {/* Both are about one project, so with all projects they are not there;
            an open plan keeps its way back even if the filter is cleared under it. */}
        <Show when={planViewProjectId() || store.kanbanProjectId}>
          <PlanToggle />
        </Show>
        <GitHubIssuesButton />
      </div>
    </Show>
  );
}
