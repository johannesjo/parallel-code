import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from 'solid-js';
import { Dialog } from '../components/Dialog';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { openDialog } from '../lib/dialog';
import { errMessage } from '../lib/log';
import { theme, sectionLabelStyle } from '../lib/theme';
import { addDocumentProject } from '../store/projects';
import { showNotification } from '../store/notification';
import type { DocumentFolderInfo, DocumentProjectSetup } from './types';
import { openDocumentWorkspace } from './store';

interface NewDocumentProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

const DEFAULT_DOCUMENT = 'notes.md';
/** Typing a path should not spawn a `git` process per keystroke. */
const INSPECT_DEBOUNCE_MS = 250;

/** Mirrors the extension the backend appends, so the plan below names the real file. */
function withMarkdownExtension(value: string): string {
  return /\.(md|markdown)$/i.test(value) ? value : `${value}.md`;
}

/** The document a folder most likely wants opened: a committed file, else any file. */
function preferredDocument(info: DocumentFolderInfo): string {
  return info.files.find((f) => f.committed)?.path ?? info.files[0]?.path ?? DEFAULT_DOCUMENT;
}

function folderName(folder: string): string {
  return folder.replace(/\/+$/, '').split('/').pop() ?? folder;
}

/**
 * Picks a folder and one Markdown document inside it. Neither has to exist
 * yet: the folder path is editable, so a new project is a name typed onto a
 * parent directory, and the backend creates the folder, initialises the
 * repository, writes the document and makes the first commit.
 */
export function NewDocumentProjectDialog(props: NewDocumentProjectDialogProps) {
  const [folder, setFolder] = createSignal('');
  const [name, setName] = createSignal('');
  const [nameEdited, setNameEdited] = createSignal(false);
  const [filter, setFilter] = createSignal('');
  const [documentInput, setDocumentInput] = createSignal('');
  const [documentEdited, setDocumentEdited] = createSignal(false);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  // Re-inspected as the path is edited; a folder that does not exist yet comes
  // back empty rather than as an error.
  const [settledFolder, setSettledFolder] = createSignal('');
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const value = folder().trim();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => setSettledFolder(value), INSPECT_DEBOUNCE_MS);
  });
  onCleanup(() => clearTimeout(settleTimer));

  const [info] = createResource(
    () => settledFolder() || null,
    // A path that is still half-typed, or one the app may not read, is simply
    // "nothing known about it yet"; creating the project reports the real error.
    (projectRoot) =>
      invoke<DocumentFolderInfo>(IPC.InspectDocumentFolder, { projectRoot }).catch(() => null),
  );

  const files = () => info()?.files ?? [];
  const visibleFiles = createMemo(() => {
    const q = filter().trim().toLowerCase();
    return q ? files().filter((f) => f.path.toLowerCase().includes(q)) : files();
  });
  const documentPath = () => {
    if (documentEdited()) return documentInput();
    const found = info();
    return found ? preferredDocument(found) : '';
  };
  const projectName = () => (nameEdited() ? name() : folderName(folder().trim()));

  /** What creating the project will do, so nothing about it is a surprise. */
  const plan = createMemo(() => {
    const current = info();
    const wanted = documentPath().trim();
    if (!current || !wanted) return [];
    const steps: string[] = [];
    if (!current.exists) steps.push('create the folder');
    if (!current.isRepo) steps.push('run `git init`');
    const match = files().find((f) => f.path === withMarkdownExtension(wanted));
    if (!match) steps.push(`create ${withMarkdownExtension(wanted)}`);
    if (!match?.committed) steps.push('make a commit');
    return steps;
  });

  function reset() {
    setFolder('');
    setName('');
    setNameEdited(false);
    setFilter('');
    setDocumentInput('');
    setDocumentEdited(false);
    setError('');
  }

  function close() {
    reset();
    props.onClose();
  }

  async function chooseFolder() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (selected) setFolder(selected as string);
  }

  const enclosingRepo = () => info()?.enclosingRepo ?? null;
  const canCreate = () =>
    folder().trim().startsWith('/') &&
    documentPath().trim() &&
    projectName().trim() &&
    !busy() &&
    !enclosingRepo();

  async function create() {
    if (!canCreate()) return;
    setBusy(true);
    setError('');
    try {
      const setup = await invoke<DocumentProjectSetup>(IPC.PrepareDocumentProject, {
        projectRoot: folder().trim(),
        documentPath: documentPath().trim(),
      });
      const id = addDocumentProject(projectName().trim(), folder().trim(), setup.documentPath);
      if (setup.actions.length > 0) showNotification(setup.actions.join(' · '));
      close();
      await openDocumentWorkspace(id);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const inputStyle = {
    background: theme.bgInput,
    border: `1px solid ${theme.border}`,
    'border-radius': 'var(--radius-md)',
    padding: '7px 10px',
    color: theme.fg,
    'font-size': '13px',
    outline: 'none',
    width: '100%',
    'box-sizing': 'border-box' as const,
  };

  return (
    <Dialog open={props.open} onClose={close} width="520px">
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
        <h2 style={{ margin: 0, 'font-size': '16px' }}>New document project</h2>
        <p style={{ margin: 0, 'font-size': '13px', color: theme.fgMuted }}>
          A folder with a Markdown document. Agents propose changes in isolated worktrees; you
          decide what enters the document.
        </p>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <span style={sectionLabelStyle}>Folder</span>
          <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
            <input
              style={{ ...inputStyle, 'font-family': 'var(--font-mono)', 'font-size': '12px' }}
              aria-label="Project folder"
              placeholder="/path/to/folder"
              value={folder()}
              onInput={(e) => setFolder(e.currentTarget.value)}
            />
            <button
              type="button"
              class="docws-btn"
              onClick={() => void chooseFolder()}
              disabled={busy()}
            >
              Browse…
            </button>
          </div>
          <Show
            when={!folder().trim() || folder().trim().startsWith('/')}
            fallback={<span class="docws-error">The folder path has to be absolute.</span>}
          >
            <span style={{ 'font-size': '12px', color: theme.fgMuted }}>
              Add a name to the end of the path to start a new project folder there.
            </span>
          </Show>
        </div>
        <Show when={folder().trim()}>
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
            <span style={sectionLabelStyle}>Name</span>
            <input
              style={inputStyle}
              value={projectName()}
              onInput={(e) => {
                setNameEdited(true);
                setName(e.currentTarget.value);
              }}
            />
          </div>
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
            <span style={sectionLabelStyle}>Document</span>
            <input
              style={inputStyle}
              aria-label="Document path"
              placeholder={DEFAULT_DOCUMENT}
              value={documentPath()}
              onInput={(e) => {
                setDocumentEdited(true);
                setDocumentInput(e.currentTarget.value);
              }}
            />
            <Show when={files().length > 8}>
              <input
                style={inputStyle}
                placeholder="Filter files…"
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
              />
            </Show>
            <Show when={files().length > 0}>
              <div class="docws-picker-list" role="listbox" aria-label="Markdown files">
                <For each={visibleFiles()}>
                  {(file) => (
                    <button
                      type="button"
                      role="option"
                      class="docws-picker-item"
                      aria-selected={documentPath() === file.path}
                      onClick={() => {
                        setDocumentEdited(true);
                        setDocumentInput(file.path);
                      }}
                    >
                      {file.path}
                      <Show when={!file.committed}>
                        <span class="docws-badge">not committed</span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={plan().length > 0}>
              <span style={{ 'font-size': '12px', color: theme.fgMuted }}>
                Parallel will {plan().join(', ')}.
              </span>
            </Show>
          </div>
        </Show>
        <Show when={enclosingRepo()}>
          {(repo) => (
            <div
              class="docws-error"
              style={{
                'font-size': '13px',
                display: 'flex',
                'align-items': 'center',
                gap: '10px',
                'flex-wrap': 'wrap',
              }}
            >
              <span style={{ flex: '1', 'min-width': '0' }}>
                That folder is inside the Git repository at {repo()}. Proposals and history belong
                to the repository, so the project has to be the repository itself.
              </span>
              <button
                type="button"
                class="docws-btn docws-btn-sm"
                onClick={() => setFolder(repo())}
              >
                Use the repository
              </button>
            </div>
          )}
        </Show>
        <Show when={error()}>
          <div class="docws-error" style={{ 'font-size': '13px' }}>
            {error()}
          </div>
        </Show>
        <div style={{ display: 'flex', 'justify-content': 'flex-end', gap: '8px' }}>
          <button type="button" class="docws-btn" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            class="docws-btn docws-btn-primary"
            disabled={!canCreate()}
            onClick={() => void create()}
          >
            {busy() ? 'Setting up…' : 'Open workspace'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
