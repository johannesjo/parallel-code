import { mapArray, Show } from 'solid-js';
import { withViewTransition } from '../lib/viewTransition';
import { store } from '../store/core';
import { isGitHubProject, openGitHubIssues } from '../store/github';
import { selectedGitHubProjectId } from '../store/github-issues-target';
import { openKanban, openPlanView, planViewProjectId } from '../store/kanban';
import { toggleNewTaskPanel } from '../store/navigation';
import { boardShown } from '../store/project-pages';
import { isPlannableProject } from '../store/projects';
import type { Project } from '../store/types';
import { BoardSearch } from './BoardSearch';
import { type MenuAction, MoreMenu } from './chat/MoreMenu';
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

/** Why a project's issues can or cannot open yet. */
function githubTitle(project: Project): string {
  const onGitHub = isGitHubProject(project.path);
  if (onGitHub === undefined) return `Checking ${project.name} for a GitHub repository`;
  if (onGitHub === false) return `GitHub issues unavailable for ${project.name}`;
  return `GitHub issues in ${project.name}`;
}

/**
 * Opens the GitHub issues of the selected project (see
 * selectedGitHubProjectId), which cover the board until closed. With all
 * projects it offers a menu of them instead, so the target is never guessed.
 * Always there: appearing on a project pick would shift the row.
 */
function GitHubIssuesButton() {
  const project = () => store.projects.find((p) => p.id === selectedGitHubProjectId());
  // Read only while the menu is open, so gh is asked about projects on demand.
  // One entry per project, kept while gh answers: the menu keys its buttons by
  // entry, so new ones would drop keyboard focus. The getters update in place.
  const projectItems = mapArray(
    () => store.projects.filter((p) => isPlannableProject(p.id)),
    (p): MenuAction => ({
      label: p.name,
      get title() {
        return githubTitle(p);
      },
      get disabled() {
        return isGitHubProject(p.path) !== true;
      },
      run: () => openGitHubIssues(p.id),
    }),
  );
  const menuItems = (): MenuAction[] => {
    const items = projectItems();
    return items.length > 0
      ? items
      : [{ label: 'No code projects', disabled: true, run: () => undefined }];
  };
  return (
    <Show
      when={project()}
      fallback={
        <MoreMenu
          class="task-board-new task-board-github"
          label="GitHub issues"
          icon={<GitHubIcon size={14} />}
          iconOnly
          items={menuItems()}
        />
      }
    >
      {(selected) => (
        <button
          type="button"
          class="task-board-new task-board-github"
          disabled={isGitHubProject(selected().path) !== true}
          title={githubTitle(selected())}
          aria-label="GitHub issues"
          onClick={() => openGitHubIssues(selected().id)}
        >
          <GitHubIcon size={14} />
        </button>
      )}
    </Show>
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
