import { For, Show, createSignal, onMount } from 'solid-js';
import { formatRelativeAge } from '../lib/relativeAge';
import {
  boardIdeas,
  ideasLaneShown,
  removeTaskIdea,
  startTaskIdea,
  updateTaskIdea,
} from '../store/ideas';
import type { TaskIdea } from '../store/types';
import { BoardLane } from './board/BoardLane';
import { boardNow } from './board/task-state';
import { PlayIcon, TrashIcon } from './icons';
import { BoardProjectLabel } from './TaskBoardCard';
import { ideaCount } from './TaskBoardIdeas';

/** Hands the keyboard to the next idea (else the previous) before this one goes. */
function deleteIdea(id: string, from: HTMLElement): void {
  const card = from.closest('li');
  const neighbour = card?.nextElementSibling ?? card?.previousElementSibling;
  neighbour?.querySelector<HTMLElement>('button.task-board-title')?.focus();
  removeTaskIdea(id);
}

/** A hollow ring where tasks show their state: not started yet. */
function IdeaGlyph() {
  return (
    <span class="task-board-glyph" aria-hidden="true">
      <span class="task-board-idea-ring" />
    </span>
  );
}

/**
 * Edits the idea in place: Enter or leaving the field saves, Shift+Enter adds
 * a line, Escape keeps the old text.
 */
function IdeaEditor(props: { idea: TaskIdea; onDone: (refocus: boolean) => void }) {
  let input: HTMLTextAreaElement | undefined;
  let done = false;
  const finish = (save: boolean, refocus: boolean) => {
    if (done) return;
    done = true;
    if (save && input) updateTaskIdea(props.idea.id, input.value);
    props.onDone(refocus);
  };
  onMount(() => {
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  return (
    <div class="task-board-title task-board-idea-editor">
      <IdeaGlyph />
      <textarea
        ref={input}
        class="task-board-idea-edit"
        aria-label="Edit idea"
        value={props.idea.text}
        onBlur={() => finish(true, false)}
        onKeyDown={(e) => {
          // The board's own keys must not act on what is typed here.
          e.stopPropagation();
          if (e.isComposing) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            finish(false, true);
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            finish(true, true);
          }
        }}
      />
    </div>
  );
}

function IdeaCard(props: { idea: TaskIdea }) {
  const [editing, setEditing] = createSignal(false);
  let title: HTMLButtonElement | undefined;
  // True from a click that opened the editor until a fresh click inside it, so
  // a double-click on the card starts the task, while one in the field still
  // selects a word.
  let openedByClick = false;
  return (
    <li
      class="task-board-card task-board-idea"
      data-board-idea={props.idea.id}
      onMouseDown={(e) => {
        if (editing() && e.detail === 1) openedByClick = false;
      }}
      onDblClick={() => {
        if (!openedByClick) return;
        openedByClick = false;
        setEditing(false);
        startTaskIdea(props.idea.id);
      }}
    >
      <Show
        when={editing()}
        fallback={
          <button
            ref={title}
            type="button"
            class="task-board-title"
            title={`${props.idea.text}\n\nClick to edit, double-click to start a task`}
            aria-label={`Edit idea: ${props.idea.text}`}
            onClick={(e) => {
              openedByClick = e.detail > 0;
              setEditing(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Delete') deleteIdea(props.idea.id, e.currentTarget);
            }}
          >
            <IdeaGlyph />
            <span class="task-board-name">{props.idea.text}</span>
          </button>
        }
      >
        <IdeaEditor
          idea={props.idea}
          onDone={(refocus) => {
            setEditing(false);
            if (refocus) title?.focus();
          }}
        />
      </Show>
      <p class="task-board-meta">
        <BoardProjectLabel projectId={props.idea.projectId} />
        <span class="task-board-age" title="Noted">
          {formatRelativeAge(props.idea.createdAt, boardNow())}
        </span>
      </p>
      <div class="task-board-idea-actions">
        <button
          type="button"
          class="task-board-idea-action"
          title="Start a task from this idea"
          aria-label={`Start task: ${props.idea.text}`}
          onClick={() => startTaskIdea(props.idea.id)}
        >
          <PlayIcon size={12} />
        </button>
        <button
          type="button"
          class="task-board-idea-action"
          title="Delete idea"
          aria-label={`Delete idea: ${props.idea.text}`}
          onClick={(e) => deleteIdea(props.idea.id, e.currentTarget)}
        >
          <TrashIcon size={12} />
        </button>
      </div>
    </li>
  );
}

/**
 * Tasks not yet started, leftmost on the board while its toggle is on. A click
 * edits one; a double-click or its start button opens the new-task form
 * prefilled, and the idea goes once the task exists.
 */
export function IdeasLane(props: { query: string }) {
  const ideas = () => boardIdeas(props.query);
  return (
    <Show when={ideasLaneShown() && boardIdeas('').length > 0}>
      <BoardLane
        class="lane-ideas"
        aria-labelledby="task-board-lane-ideas"
        headingId="task-board-lane-ideas"
        title="Ideas"
        count={ideas().length}
        listLabel={ideaCount(ideas().length)}
      >
        <For each={ideas()}>{(idea) => <IdeaCard idea={idea} />}</For>
      </BoardLane>
    </Show>
  );
}
