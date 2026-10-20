// The workspace panel that also loads these styles is lazy, and this dialog opens before it.
import './documents.css';
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
import { addDocumentProject, addProject } from '../store/projects';
import { showNotification } from '../store/notification';
import type { DocumentFileInfo, DocumentFolderInfo, DocumentProjectSetup } from './types';
import { openDocumentWorkspace, openQuickEdit } from './store';
import { FolderIcon } from '../components/icons';
import {
  folderName,
  guessProjectKind,
  joinFolderPath,
  quickEditRepo,
  type AddProjectKind,
} from './add-project-plan';

interface AddProjectDialogProps {
  open: boolean;
  onClose: () => void;
  /** A code project was added; the caller offers its existing worktrees. */
  onCodeProjectAdded: (projectId: string) => void;
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
 * The one way to add a project. The folder comes first; whether it opens as
 * tasks or as documents is suggested from what it holds and can be switched.
 *
 * As documents, the document is a Markdown file named after the project, or
 * one the folder already holds. Nothing has to exist yet: the folder path is
 * editable, so a new project is a name typed onto a parent directory, and the
 * backend creates the folder, initialises the repository, writes the document
 * and makes the first commit. Documents in a code repository, or in a folder
 * inside any repository, open as quick edits instead, which commit nothing there.
 */
export function AddProjectDialog(props: AddProjectDialogProps) {
  const [folder, setFolder] = createSignal('');
  /** Set once the user overrides the suggestion; a new folder clears it. */
  const [kindChoice, setKindChoice] = createSignal<AddProjectKind | null>(null);
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
    // A folder the app may not read comes back as null: nothing is known about
    // it, so it can be neither guessed nor created.
    (projectRoot) =>
      invoke<DocumentFolderInfo>(IPC.InspectDocumentFolder, { projectRoot }).catch(() => null),
  );
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(folder, (value) => {
      // What was known about the last folder, and a file picked from its
      // list, must not carry over to the next one.
      setChoice('default');
      setKindChoice(null);
      // The last folder's details stay on screen until the next ones arrive, so
      // the dialog does not collapse and regrow on every keystroke.
      if (!value.trim()) setInfo(undefined);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => setSettledFolder(value.trim()), INSPECT_DEBOUNCE_MS);
    }),
  );
  onCleanup(() => clearTimeout(settleTimer));

  const kind = () => kindChoice() ?? guessProjectKind(info());
  /** The repository a document here would sync to as a quick edit, when it would. */
  const quickRepo = () => (kind() === 'document' ? quickEditRepo(folder().trim(), info()) : null);
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
  const isNewDocument = () => !files().some((f) => f.path === documentPath());
  /** What creating the project will do, so nothing about it is a surprise. */
  const plan = createMemo(() => {
    const current = info();
    const file = documentPath();
    if (!current || kind() === 'code' || quickRepo()) return [];
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
    setKindChoice(null);
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

  // Setting up cannot be called back halfway, but Cancel never waits for it
  // (it may hang): the dialog closes now and the result is dropped on arrival,
  // so no project is added and nothing opens. Each try has its own number, so a
  // late result from a cancelled try cannot pass for the one after it.
  let attempt = 0;
  const cancelled = (mine: number) => mine !== attempt;
  function dismiss() {
    attempt++;
    setBusy(false);
    close();
  }

  async function chooseFolder() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (selected) setFolder(selected as string);
  }

  /** A code project needs a folder that is there; documents create theirs. */
  const missingCodeFolder = () => kind() === 'code' && info()?.exists === false;
  /** What is shown describes the folder as typed, not one typed a moment ago. */
  const checked = () => settledFolder() === folder().trim() && !info.loading;
  // Until the folder is read, the guess is not a guess: submitting then could
  // commit into a code repository that should have opened as a quick edit.
  const canCreate = () =>
    checked() &&
    !!info() &&
    folder().trim().startsWith('/') &&
    documentPath().trim() &&
    projectName().trim() &&
    !busy() &&
    !missingCodeFolder();

  async function addCodeProject(mine: number) {
    const path = folder().trim();
    const isGitRepo = await invoke<boolean>(IPC.CheckIsGitRepo, { path });
    if (cancelled(mine)) return;
    const id = addProject(projectName().trim(), path, isGitRepo);
    close();
    props.onCodeProjectAdded(id);
  }

  async function create() {
    if (!canCreate()) return;
    const mine = ++attempt;
    setBusy(true);
    setError('');
    try {
      if (kind() === 'code') return await addCodeProject(mine);
      if (quickRepo()) {
        await openQuickEdit(
          joinFolderPath(folder().trim(), documentPath()),
          isNewDocument(),
          () => !cancelled(mine),
        );
        if (!cancelled(mine)) close();
        return;
      }
      const setup = await invoke<DocumentProjectSetup>(IPC.PrepareDocumentProject, {
        projectRoot: folder().trim(),
        documentPath: documentPath().trim(),
        title: projectName().trim(),
      });
      if (cancelled(mine)) return;
      const id = addDocumentProject(projectName().trim(), folder().trim(), setup.documentPath);
      if (setup.actions.length > 0) showNotification(setup.actions.join(' · '));
      close();
      await openDocumentWorkspace(id);
    } catch (err) {
      if (!cancelled(mine)) setError(errMessage(err));
    } finally {
      if (!cancelled(mine)) setBusy(false);
    }
  }

  /** Enter in a field is the primary button, when it is enabled. */
  function submitOnEnter(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.isComposing) void create();
  }

  /** Says what the button will make, so creating something never looks like opening it. */
  const submitLabel = () => {
    if (kind() === 'code') return 'Add project';
    if (quickRepo()) return isNewDocument() ? 'Create document' : 'Open document';
    const current = info();
    if (current && (!current.exists || !current.isRepo)) return 'Create project';
    return isNewDocument() ? 'Create document' : 'Open workspace';
  };

  /** Only a folder that is there and readable can hold code; documents create theirs. */
  const codeUnavailable = () => info() === null || info()?.exists === false;
  const kindButtons: Partial<Record<AddProjectKind, HTMLButtonElement>> = {};

  /** Arrow keys move the choice, as in any radio group; only the checked one is a tab stop. */
  function onKindKey(e: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next = kind() === 'code' ? 'document' : 'code';
    if (next === 'code' && codeUnavailable()) return;
    setKindChoice(next);
    kindButtons[next]?.focus();
  }

  function kindOption(value: AddProjectKind, label: string) {
    return (
      <button
        type="button"
        class="docws-tab"
        role="radio"
        ref={(el) => (kindButtons[value] = el)}
        aria-checked={kind() === value}
        tabIndex={kind() === value ? 0 : -1}
        disabled={value === 'code' && codeUnavailable()}
        onClick={() => setKindChoice(value)}
        onKeyDown={onKindKey}
      >
        {label}
      </button>
    );
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
    <Dialog open={props.open} onClose={dismiss} width="520px" labelledBy="add-project-title">
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
        <h2 id="add-project-title" style={{ margin: 0, 'font-size': '16px' }}>
          Add project
        </h2>
        <p style={{ margin: 0, 'font-size': '13px', color: theme.fgMuted }}>
          A code repository runs agents in tasks. A folder of writing opens as documents: select a
          passage, choose Proposals, and compare alternatives before accepting changes.
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
              <FolderIcon size={14} />
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
            <span style={sectionLabelStyle}>Open as</span>
            <div class="docws-tabs" role="radiogroup" aria-label="Open as">
              {kindOption('code', 'Code')}
              {kindOption('document', 'Documents')}
            </div>
          </div>
          <Show when={!quickRepo() || isNewDocument()}>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
              <span style={sectionLabelStyle}>{quickRepo() ? 'Document name' : 'Name'}</span>
              <input
                style={inputStyle}
                aria-label={quickRepo() ? 'Document name' : 'Project name'}
                value={projectName()}
                onInput={(e) => {
                  setNameEdited(true);
                  setName(e.currentTarget.value);
                }}
                onKeyDown={submitOnEnter}
              />
            </div>
          </Show>
          <Show when={kind() === 'document' && files().length > 0}>
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
          {/* One reserved line for what the folder means, so answers arriving do not push the buttons. */}
          <div style={{ 'font-size': '12px', color: theme.fgMuted, 'min-height': '4.2em' }}>
            <Show when={checked()} fallback={<span>Checking folder…</span>}>
              <Show when={plan().length > 0}>
                <span>Parallel will {joinSteps(plan())}.</span>
              </Show>
              <Show when={quickRepo()}>
                {(repo) => (
                  <span>
                    {isNewDocument() ? `Creates ${documentPath()} and opens` : 'Opens'} it as a
                    quick edit: agents work on a private copy and every change is written back to
                    the file. Nothing is committed in {repo()}.
                  </span>
                )}
              </Show>
              <Show when={info() === null}>
                <span class="docws-error">Parallel can't read this folder.</span>
              </Show>
              <Show when={missingCodeFolder()}>
                <span class="docws-error">A code project needs a folder that exists.</span>
              </Show>
            </Show>
          </div>
        </Show>
        {/* Holds a line, so an error does not push the buttons down. */}
        <div
          class="docws-error"
          role="alert"
          style={{ 'font-size': '13px', 'min-height': '1.4em' }}
        >
          {error()}
        </div>
        <div style={{ display: 'flex', 'justify-content': 'flex-end', gap: '8px' }}>
          <button type="button" class="docws-btn" onClick={dismiss}>
            Cancel
          </button>
          <button
            type="button"
            class="docws-btn docws-btn-primary"
            disabled={!canCreate()}
            onClick={() => void create()}
          >
            <FolderIcon size={14} />
            {busy() ? 'Setting up…' : submitLabel()}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
