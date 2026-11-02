import { Show, createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import { Portal } from 'solid-js/web';
import { createAnchorEffect, placeBelow } from '../lib/floating';
import { addTaskIdea, defaultIdeaProject } from '../store/ideas';
import { ProjectSelect } from './ProjectSelect';

const POPOVER_WIDTH = 320;
// The board's add-idea button; without it (board hidden) the dialog sits top centre.
const ANCHOR = '.task-board-idea-add';

// Where the keyboard goes back to on close; null while the dialog is shut.
const [returnFocus, setReturnFocus] = createSignal<HTMLElement | null>(null);
export const ideaDialogOpen = () => returnFocus() !== null;

/** Opens the add-idea dialog, or closes it when already open. */
export function toggleIdeaDialog(from?: HTMLElement): void {
  if (ideaDialogOpen()) {
    closeIdeaDialog();
    return;
  }
  const active = document.activeElement;
  setReturnFocus(from ?? (active instanceof HTMLElement ? active : document.body));
}

function closeIdeaDialog(): void {
  const target = returnFocus();
  setReturnFocus(null);
  target?.focus();
}

const isAltArrow = (e: KeyboardEvent) =>
  (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
  e.altKey &&
  !e.ctrlKey &&
  !e.metaKey &&
  !e.shiftKey;

/** Alt+Up/Down steps between the fields, as in the new-task form, wrapping around. */
function focusNextField(dialog: HTMLElement, step: 1 | -1): void {
  const fields = [...dialog.querySelectorAll<HTMLElement>('textarea, select')];
  const current = fields.indexOf(document.activeElement as HTMLElement);
  fields[(current + step + fields.length) % fields.length]?.focus();
}

function placement() {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const anchor = document.querySelector(ANCHOR)?.getBoundingClientRect();
  if (anchor) return placeBelow(anchor, POPOVER_WIDTH, viewport, 12, 240);
  return { top: 96, right: Math.max(12, (viewport.width - POPOVER_WIDTH) / 2), maxHeight: 240 };
}

/**
 * Jots down ideas without leaving what you are doing: one field plus the
 * project they go to. It stays open for the next idea.
 */
export function IdeaDialog() {
  const [position, setPosition] = createSignal({ top: 0, right: 0, maxHeight: 240 });
  const [projectId, setProjectId] = createSignal<string | null>(null);
  let input: HTMLTextAreaElement | undefined;
  const save = () => {
    if (!input) return;
    addTaskIdea(input.value, projectId());
    input.value = '';
  };

  createAnchorEffect(ideaDialogOpen, () => setPosition(placement()));
  createEffect(() => {
    if (!ideaDialogOpen()) return;
    // Untracked: saving updates the remembered project, which must not undo a pick.
    setProjectId(untrack(defaultIdeaProject));
    const frame = requestAnimationFrame(() => input?.focus());
    onCleanup(() => cancelAnimationFrame(frame));
  });

  return (
    <Show when={ideaDialogOpen()}>
      <Portal>
        <div class="task-board-ideas-backdrop" onClick={closeIdeaDialog}>
          <div
            role="dialog"
            aria-label="Add idea"
            class="task-board-ideas-popover"
            style={{ top: `${position().top}px`, right: `${position().right}px` }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                closeIdeaDialog();
              } else if (isAltArrow(e)) {
                e.preventDefault();
                focusNextField(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1);
              }
            }}
          >
            <textarea
              ref={input}
              class="task-board-idea-input"
              rows={2}
              placeholder="New idea, Enter to save, Shift+Enter for a new line"
              aria-label="New idea"
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
                e.preventDefault();
                save();
              }}
            />
            <ProjectSelect
              class="task-board-idea-project"
              value={projectId()}
              onChange={setProjectId}
              emptyLabel="No project"
            />
          </div>
        </div>
      </Portal>
    </Show>
  );
}
