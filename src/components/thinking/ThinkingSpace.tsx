import { createEffect, createSignal, on } from 'solid-js';
import { IPC } from '../../../electron/ipc/channels';
import { createUnderstandingTour } from '../../lib/create-understanding-tour';
import { invoke } from '../../lib/ipc';
import { errMessage, warn as logWarn } from '../../lib/log';
import { parseTourFile } from '../../lib/tour-file';
import { openThinkingSpace } from '../../store/store';
import { UnderstandingTourDialog } from '../UnderstandingTourDialog';
import { ThinkingList, type SavedThinking } from './ThinkingList';

/** What the main process lists; see electron/ipc/thinking-tours.ts. */
interface ListedTours {
  dir: string;
  tours: { path: string; content: string; modifiedAt: number }[];
}

const TASK_NAME = 'Thinking';
/** Above a task's own tour (1450): the shortcut opens the space over any dialog. */
const LAYER = 1500;

/** The listed files that are thinking tours; anything else in the folder is skipped. */
function readTours(listed: ListedTours['tours']): SavedThinking[] {
  return listed.flatMap((entry) => {
    try {
      const file = parseTourFile(entry.content);
      if (file.kind !== 'thinking') return [];
      return [{ path: entry.path, text: entry.content, file, modifiedAt: entry.modifiedAt }];
    } catch (error) {
      logWarn('thinking', 'Skipped an unreadable thinking tour', { path: entry.path, error });
      return [];
    }
  });
}

/**
 * Tours the reader writes away from any task: a list of the saved ones to
 * start from, then the tour itself, written in the app's own folder. Closing
 * the tour closes the space; unmounting writes what was typed last.
 */
export function ThinkingSpace(props: { mode: 'list' | 'new'; onClose: () => void }) {
  const tour = createUnderstandingTour();
  const [dir, setDir] = createSignal('');
  const [tours, setTours] = createSignal<SavedThinking[]>([]);
  const [error, setError] = createSignal('');
  const [tourOpen, setTourOpen] = createSignal(false);

  async function list(): Promise<string> {
    const listed = await invoke<ListedTours>(IPC.ListThinkingTours);
    setDir(listed.dir);
    setTours(readTours(listed.tours));
    return listed.dir;
  }

  const ready = list().catch((failure: unknown) => {
    setError(`Could not list thinking tours: ${errMessage(failure)}`);
    return '';
  });

  function startNew(folder: string): void {
    if (!folder) return;
    tour.startThinking({ worktreePath: folder, taskName: TASK_NAME });
    setTourOpen(true);
  }

  // The shortcut asks for a new tour, also while the space is already open.
  createEffect(
    on(
      () => props.mode,
      (mode) => {
        if (mode !== 'new') return;
        openThinkingSpace('list');
        void ready.then(startNew);
      },
    ),
  );

  async function openSaved(saved: SavedThinking): Promise<void> {
    setError('');
    await tour.restore({
      file: saved.file,
      text: saved.text,
      savedPath: saved.path,
      worktreePath: dir(),
      taskName: TASK_NAME,
    });
    setTourOpen(true);
  }

  return (
    <>
      <ThinkingList
        open={!tourOpen()}
        zIndex={LAYER}
        tours={tours()}
        error={error()}
        onNew={() => startNew(dir())}
        onOpen={(saved) =>
          void openSaved(saved).catch((failure: unknown) => setError(errMessage(failure)))
        }
        onClose={() => props.onClose()}
      />
      <UnderstandingTourDialog
        tour={tour}
        open={tourOpen()}
        zIndex={LAYER}
        onClose={() => props.onClose()}
        worktreePath={dir()}
      />
    </>
  );
}
