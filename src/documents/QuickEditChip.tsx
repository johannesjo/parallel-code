import { createEffect, createSignal } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { openDialog } from '../lib/dialog';
import { errMessage } from '../lib/log';
import { addDocumentProject } from '../store/projects';
import { showNotification } from '../store/notification';
import type { Project } from '../store/types';
import { removeProjectAndHiddenAgents } from '../components/RemoveProjectConfirm';
import { Dialog } from '../components/Dialog';
import { FolderIcon } from '../components/icons';
import { openDocumentWorkspace } from './store';
import { folderName } from './add-project-plan';
import type { DocumentProjectSetup } from './types';

interface QuickEditChipProps {
  project: Project & { quickEditSource: string };
}

/**
 * Says the workspace is a quick edit, and moves it into a document project of
 * its own: the document is copied to a folder the user picks, the original
 * stays where it was, and the quick edit goes away.
 */
export function QuickEditChip(props: QuickEditChipProps) {
  const [open, setOpen] = createSignal(false);
  const [folder, setFolder] = createSignal('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const canMove = () => folder().trim().startsWith('/') && !busy();
  let folderInput: HTMLInputElement | undefined;

  // Picking the folder is the one thing this dialog asks for.
  createEffect(() => {
    if (open()) requestAnimationFrame(() => folderInput?.focus());
  });

  function close() {
    if (busy()) return;
    setOpen(false);
    setFolder('');
    setError('');
  }

  async function chooseFolder() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (selected) setFolder(selected as string);
  }

  async function move() {
    if (!canMove()) return;
    const quick = props.project;
    const target = folder().trim();
    setBusy(true);
    setError('');
    let id: string;
    try {
      const setup = await invoke<DocumentProjectSetup>(IPC.ConvertQuickEdit, {
        projectRoot: quick.path,
        documentPath: quick.documentPath,
        folder: target,
      });
      id = addDocumentProject(folderName(target), target, setup.documentPath);
    } catch (err) {
      setError(errMessage(err));
      return;
    } finally {
      setBusy(false);
    }
    // The new project exists from here on; the quick edit goes even if opening it fails.
    close();
    try {
      await openDocumentWorkspace(id);
    } catch (err) {
      showNotification(`Created the project but could not open it: ${errMessage(err)}`);
    }
    try {
      await removeProjectAndHiddenAgents(quick.id, false);
    } catch (err) {
      showNotification(`Could not remove the quick edit: ${errMessage(err)}`);
    }
  }

  return (
    <>
      <button
        type="button"
        class="docws-head-chip docws-quick-edit"
        aria-haspopup="dialog"
        title={`Quick edit of ${props.project.quickEditSource}. Click to move it to its own project.`}
        onClick={() => setOpen(true)}
      >
        Quick edit
      </button>
      <Dialog open={open()} onClose={close} width="480px" labelledBy="docws-move-title">
        <h2 id="docws-move-title" class="docws-dialog-title">
          Move to its own project
        </h2>
        <p class="docws-dialog-message">
          Creates a document project in the folder below, with its own history, and copies{' '}
          {props.project.documentPath} into it. The folder is created if needed and must be outside
          any Git repository. The original at {props.project.quickEditSource} is left untouched and
          stops receiving changes.
        </p>
        <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
          <input
            class="docws-note"
            style={{ 'font-family': 'var(--font-mono)', 'font-size': '12px' }}
            ref={folderInput}
            aria-label="New project folder"
            placeholder="/path/to/new-folder"
            value={folder()}
            onInput={(e) => setFolder(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void move();
            }}
          />
          <button
            type="button"
            class="docws-btn"
            disabled={busy()}
            onClick={() => void chooseFolder()}
          >
            <FolderIcon size={14} />
            Browse…
          </button>
        </div>
        {/* Kept in the layout while empty, so an error does not push the buttons down. */}
        <span class="docws-error" role="alert" style={{ display: 'block', 'min-height': '1.4em' }}>
          {error()}
        </span>
        <div class="docws-dialog-actions">
          <button type="button" class="docws-btn" disabled={busy()} onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            class="docws-btn docws-btn-primary"
            disabled={!canMove()}
            onClick={() => void move()}
          >
            {busy() ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </Dialog>
    </>
  );
}
