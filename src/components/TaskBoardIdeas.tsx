import { Show } from 'solid-js';
import { boardIdeas, ideasLaneShown, setIdeasLaneShown } from '../store/ideas';
import { IdeaIcon } from './icons';
import { ideaDialogOpen, toggleIdeaDialog } from './IdeaDialog';

export const ideaCount = (count: number) => `${count} ${count === 1 ? 'idea' : 'ideas'}`;

/** A title-bar button beside "+ New task" opening the add-idea dialog. */
function IdeaAddButton() {
  return (
    <button
      type="button"
      class="task-board-new task-board-idea-add"
      title="Add an idea: a task to start later"
      aria-label="Add idea"
      aria-haspopup="dialog"
      aria-expanded={ideaDialogOpen()}
      onClick={(e) => toggleIdeaDialog(e.currentTarget)}
    >
      <IdeaIcon size={14} />
    </button>
  );
}

/** Shows or hides the Ideas lane; only there while the board has ideas to show. */
function IdeasLaneToggle() {
  // Narrowed by the project filter, not the text filter: it counts what the lane holds.
  const count = () => boardIdeas('').length;
  return (
    <Show when={count() > 0}>
      <button
        type="button"
        class="task-board-new task-board-ideas-toggle"
        title={ideasLaneShown() ? 'Hide the Ideas lane' : 'Show the Ideas lane'}
        aria-label={`Ideas lane, ${ideaCount(count())}`}
        aria-pressed={ideasLaneShown()}
        onClick={() => setIdeasLaneShown(!ideasLaneShown())}
      >
        <span class="task-board-count">{count()}</span>
      </button>
    </Show>
  );
}

/**
 * One split button for ideas: the bulb adds one, the count beside it shows or
 * hides their lane. With no ideas only the bulb is there.
 */
export function IdeasControl() {
  return (
    <span class="task-board-ideas-group" role="group" aria-label="Ideas">
      <IdeaAddButton />
      <IdeasLaneToggle />
    </span>
  );
}
