import { For, Show, createMemo, createSignal } from 'solid-js';
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

/** Mirrors the extension the backend appends, so the plan below names the real file. */
function withMarkdownExtension(value: string): string {
  return /\.(md|markdown)$/i.test(value) ? value : `${value}.md`;
}

/** The document a folder most likely wants opened: a committed file, else any file. */
function preferredDocument(info: DocumentFolderInfo): string {
  return info.files.find((f) => f.committed)?.path ?? info.files[0]?.path ?? DEFAULT_DOCUMENT;
}

/**
 * Picks a folder and one Markdown document inside it. Neither has to exist
 * yet: the backend initialises the repository, creates the document and makes
 * the first commit, so the only thing asked of the user is where and what.
 */
export function NewDocumentProjectDialog(props: NewDocumentProjectDialogProps) {
  const [folder, setFolder] = createSignal('');
  const [info, setInfo] = createSignal<DocumentFolderInfo | null>(null);
  const [name, setName] = createSignal('');
  const [filter, setFilter] = createSignal('');
  const [documentPath, setDocumentPath] = createSignal('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const files = () => info()?.files ?? [];
  const visibleFiles = createMemo(() => {
    const q = filter().trim().toLowerCase();
    return q ? files().filter((f) => f.path.toLowerCase().includes(q)) : files();
  });

  /** What creating the project will do to the folder, so nothing is a surprise. */
  const plan = createMemo(() => {
    const current = info();
    const wanted = withMarkdownExtension(documentPath().trim());
    if (!current || !documentPath().trim()) return [];
    const steps: string[] = [];
    if (!current.isRepo) steps.push('run `git init`');
    const match = files().find((f) => f.path === wanted);
    if (!match) steps.push(`create ${wanted}`);
    if (!match?.committed) steps.push('make a commit');
    return steps;
  });

  function reset() {
    setFolder('');
    setInfo(null);
    setName('');
    setFilter('');
    setDocumentPath('');
    setError('');
  }

  function close() {
    reset();
    props.onClose();
  }

  async function chooseFolder() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;
    const path = selected as string;
    setBusy(true);
    setError('');
    try {
      const found = await invoke<DocumentFolderInfo>(IPC.InspectDocumentFolder, {
        projectRoot: path,
      });
      if (found.enclosingRepo) {
        setError(
          `That folder is inside the Git repository at ${found.enclosingRepo}. ` +
            'Pick that repository instead, so proposals and history stay in one place.',
        );
        return;
      }
      setFolder(path);
      setInfo(found);
      setName(path.split('/').pop() || path);
      setDocumentPath(preferredDocument(found));
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const canCreate = () => folder() && documentPath().trim() && name().trim() && !busy();

  async function create() {
    if (!canCreate()) return;
    setBusy(true);
    setError('');
    try {
      const setup = await invoke<DocumentProjectSetup>(IPC.PrepareDocumentProject, {
        projectRoot: folder(),
        documentPath: documentPath().trim(),
      });
      const id = addDocumentProject(name().trim(), folder(), setup.documentPath);
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
            <button
              type="button"
              class="docws-btn"
              onClick={() => void chooseFolder()}
              disabled={busy()}
            >
              {folder() ? 'Change folder…' : 'Choose folder…'}
            </button>
            <span
              style={{
                'font-family': 'var(--font-mono)',
                'font-size': '12px',
                color: theme.fgMuted,
                overflow: 'hidden',
                'text-overflow': 'ellipsis',
                'white-space': 'nowrap',
              }}
            >
              {folder()}
            </span>
          </div>
        </div>
        <Show when={folder()}>
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
            <span style={sectionLabelStyle}>Name</span>
            <input
              style={inputStyle}
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </div>
          <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
            <span style={sectionLabelStyle}>Document</span>
            <input
              style={inputStyle}
              aria-label="Document path"
              placeholder={DEFAULT_DOCUMENT}
              value={documentPath()}
              onInput={(e) => setDocumentPath(e.currentTarget.value)}
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
                      onClick={() => setDocumentPath(file.path)}
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
