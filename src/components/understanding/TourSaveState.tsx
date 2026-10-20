import { Match, Switch } from 'solid-js';
import { SaveIcon } from '../icons';
import { TourIconButton } from './TourIconButton';

/** The file's name without its folders, short enough for the tour's top row. */
function fileName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

/**
 * Whether the tour is kept, said in quiet words rather than an icon's state:
 * a Save button before the first save, then Saving…, Not saved (press to
 * retry) or Saved with the file's name, which opens it on the canvas.
 */
export function TourSaveState(props: {
  savedPath: string;
  saving: boolean;
  unsaved: boolean;
  onSave: () => void;
  /** Shows the saved file on the canvas; absent where there is no canvas. */
  onOpen?: (path: string) => void;
}) {
  return (
    <Switch
      fallback={
        <TourIconButton
          label="Save tour"
          tooltip="Save to the worktree as Markdown, to reopen or share"
          disabled={props.saving}
          onClick={() => props.onSave()}
        >
          <SaveIcon size={14} />
        </TourIconButton>
      }
    >
      <Match when={props.savedPath && props.saving}>
        <span class="tour-save-state" role="status">
          Saving…
        </span>
      </Match>
      <Match when={props.savedPath && props.unsaved}>
        <button
          type="button"
          class="tour-save-state"
          title={`New answers are not in ${props.savedPath} yet · save them now`}
          onClick={() => props.onSave()}
        >
          Not saved · Retry
        </button>
      </Match>
      <Match when={props.savedPath}>
        {(path) => (
          <button
            type="button"
            class="tour-save-state"
            title={`Saved as ${path()} · new answers update it${props.onOpen ? ' · open it on the canvas' : ''}`}
            disabled={!props.onOpen}
            onClick={() => props.onOpen?.(path())}
          >
            Saved · {fileName(path())}
          </button>
        )}
      </Match>
    </Switch>
  );
}
