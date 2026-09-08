import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
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
import type { DocumentFileInfo, DocumentFolderInfo, DocumentProjectSetup } from './types';
import { openDocumentWorkspace } from './store';

interface NewDocumentProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Which file the workspace opens on: one from the folder's list, or a new one named after the project. */
type DocumentChoice = 'default' | 'new' | { existing: string };

/** The file name when the project name has nothing usable in it. */
const FALLBACK_NAME = 'notes';
/** Typing a path should not spawn a `git` process per keystroke. */
const INSPECT_DEBOUNCE_MS = 250;

/** The document a folder most likely wants opened: a committed file, else any file. */
function preferredDocument(files: DocumentFileInfo[]): string | undefined {
  return files.find((f) => f.committed)?.path ?? files[0]?.path;
}

function folderName(folder: string): string {
  return folder.replace(/\/+$/, '').split('/').pop() ?? folder;
}

/** `Onboarding flow` → `onboarding-flow`, the file a new project is named after. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** "a, b and c" */
function joinSteps(steps: string[]): string {
  if (steps.length < 2) return steps.join('');
  return `${steps.slice(0, -1).join(', ')} and ${steps[steps.length - 1]}`;
}

/**
 * Picks a folder and names the project; the document is a Markdown file
 * named after the project, or one the folder already holds. Nothing has to exist
 * yet: the folder path is editable, so a new project is a name typed onto a
 * parent directory, and the backend creates the folder, initialises the
 * repository, writes the document and makes the first commit.
 */
export function NewDocumentProjectDialog(props: NewDocumentProjectDialogProps) {
  const [folder, setFolder] = createSignal('');
  const [name, setName] = createSignal('');
  const [nameEdited, setNameEdited] = createSignal(false);
  const [filter, setFilter] = createSignal('');
  const [choice, setChoice] = createSignal<DocumentChoice>('default');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  let folderInput: HTMLInputElement | undefined;

  // The path is what the dialog is about; typing starts there.
  createEffect(() => {
    if (!props.open) return;
    requestAnimationFrame(() => folderInput?.focus());
  });

  // Re-inspected as the path is edited; a folder that does not exist yet comes
  // back empty rather than as an error.
  const [settledFolder, setSettledFolder] = createSignal('');
  const [info, { mutate: setInfo }] = createResource(
    () => settledFolder() || null,
    // A path that is still half-typed, or one the app may not read, is simply
    // "nothing known about it yet"; creating the project reports the real error.
    (projectRoot) =>
      invoke<DocumentFolderInfo>(IPC.InspectDocumentFolder, { projectRoot }).catch(() => null),
  );
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(folder, (value) => {
      // What was known about the last folder, and a file picked from its
      // list, must not carry over to the next one.
      setChoice('default');
      setInfo(undefined);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => setSettledFolder(value.trim()), INSPECT_DEBOUNCE_MS);
    }),
  );
  onCleanup(() => clearTimeout(settleTimer));

  const files = () => info()?.files ?? [];
  const visibleFiles = createMemo(() => {
    const q = filter().trim().toLowerCase();
    return q ? files().filter((f) => f.path.toLowerCase().includes(q)) : files();
  });
  const projectName = () => (nameEdited() ? name() : folderName(folder().trim()));
  const newDocumentPath = () => `${slugify(projectName()) || FALLBACK_NAME}.md`;
  const documentPath = () => {
    const current = choice();
    if (typeof current === 'object') return current.existing;
    if (current === 'new') return newDocumentPath();
    return preferredDocument(files()) ?? newDocumentPath();
  };
  /** What creating the project will do, so nothing about it is a surprise. */
  const plan = createMemo(() => {
    const current = info();
    const file = documentPath();
    if (!current) return [];
    const steps: string[] = [];
    if (!current.exists) steps.push('create the folder');
    if (!current.isRepo) steps.push('initialise a Git repository');
    const match = files().find((f) => f.path === file);
    if (!match) steps.push(`create and commit ${file}`);
    else if (!match.committed) steps.push(`commit ${file}`);
    return steps;
  });

  function reset() {
    setFolder('');
    setName('');
    setNameEdited(false);
    setFilter('');
    setChoice('default');
    setError('');
    // The resource keeps its last value while its source is empty, so the
    // next open would show the old folder's files and plan until it settles.
    clearTimeout(settleTimer);
    setSettledFolder('');
    setInfo(undefined);
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
        title: projectName().trim(),
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

  /** Enter in a field is the primary button, when it is enabled. */
  function submitOnEnter(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.isComposing) void create();
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
          Write a spec, architecture decision, or design note in Markdown. Select a passage, choose
          Proposals, and compare alternatives before accepting changes.
        </p>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <span style={sectionLabelStyle}>Folder</span>
          <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
            <input
              style={{ ...inputStyle, 'font-family': 'var(--font-mono)', 'font-size': '12px' }}
              ref={folderInput}
              aria-label="Project folder"
              placeholder="/path/to/folder"
              value={folder()}
              onInput={(e) => setFolder(e.currentTarget.value)}
              onKeyDown={submitOnEnter}
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
              aria-label="Project name"
              value={projectName()}
              onInput={(e) => {
                setNameEdited(true);
                setName(e.currentTarget.value);
              }}
              onKeyDown={submitOnEnter}
            />
          </div>
          <Show when={files().length > 0}>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
              <span style={sectionLabelStyle}>Document</span>
              <Show when={files().length > 8}>
                <input
                  style={inputStyle}
                  placeholder="Filter files…"
                  value={filter()}
                  onInput={(e) => setFilter(e.currentTarget.value)}
                />
              </Show>
              <div class="docws-picker-list" role="listbox" aria-label="Documents in the folder">
                <Show when={!files().some((f) => f.path === newDocumentPath())}>
                  <button
                    type="button"
                    role="option"
                    class="docws-picker-item"
                    aria-selected={documentPath() === newDocumentPath()}
                    onClick={() => setChoice('new')}
                  >
                    {newDocumentPath()}
                    <span class="docws-badge">new</span>
                  </button>
                </Show>
                <For each={visibleFiles()}>
                  {(file) => (
                    <button
                      type="button"
                      role="option"
                      class="docws-picker-item"
                      aria-selected={documentPath() === file.path}
                      onClick={() => setChoice({ existing: file.path })}
                    >
                      {file.path}
                      <Show when={!file.committed}>
                        <span class="docws-badge">not committed</span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
          <Show when={plan().length > 0}>
            <span style={{ 'font-size': '12px', color: theme.fgMuted }}>
              Parallel will {joinSteps(plan())}.
            </span>
          </Show>
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
