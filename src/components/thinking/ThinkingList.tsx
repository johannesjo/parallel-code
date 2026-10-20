import { For, Show, createUniqueId } from 'solid-js';
import { mod } from '../../lib/platform';
import { countNodes } from '../../lib/tour-tree';
import type { TourFile } from '../../lib/tour-file';
import { Dialog } from '../Dialog';
import './thinking.css';

/** A thinking tour saved in the app's own folder, read and parsed. */
export interface SavedThinking {
  path: string;
  text: string;
  file: TourFile;
  modifiedAt: number;
}

function cardCount(file: TourFile): string {
  const count = countNodes(file.roots);
  return count === 1 ? '1 card' : `${count} cards`;
}

/** The thinking tours written so far, newest first, and the way to start one. */
export function ThinkingList(props: {
  open: boolean;
  zIndex: number;
  tours: SavedThinking[];
  error: string;
  onNew: () => void;
  onOpen: (tour: SavedThinking) => void;
  onClose: () => void;
}) {
  const headingId = createUniqueId();
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      zIndex={props.zIndex}
      width="440px"
      labelledBy={headingId}
    >
      <div class="thinking-space">
        <h2 id={headingId} class="thinking-space-title">
          Thinking tours
        </h2>
        <p class="thinking-space-lede">
          Write an idea out one card at a time. Kept in the app, outside any project.
        </p>
        <button
          type="button"
          class="thinking-space-new"
          // The list opens anew each time, also on leaving a tour: keep the keyboard in it.
          ref={(element) => queueMicrotask(() => element.focus())}
          onClick={() => props.onNew()}
        >
          New thinking tour
          <kbd>{mod}+Shift+K</kbd>
        </button>
        <Show when={props.error}>
          <p class="thinking-space-error" role="alert">
            {props.error}
          </p>
        </Show>
        <Show
          when={props.tours.length}
          fallback={<p class="thinking-space-empty">No thinking tours yet.</p>}
        >
          <ul class="thinking-space-list">
            <For each={props.tours}>
              {(entry) => (
                <li>
                  <button type="button" onClick={() => props.onOpen(entry)}>
                    <span class="thinking-space-name">{entry.file.subject || 'Untitled'}</span>
                    <span class="thinking-space-meta">
                      {cardCount(entry.file)} · {new Date(entry.modifiedAt).toLocaleDateString()}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Dialog>
  );
}
