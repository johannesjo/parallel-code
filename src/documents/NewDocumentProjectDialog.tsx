import { For, Show, createMemo, createSignal } from 'solid-js';
import { Dialog } from '../components/Dialog';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { openDialog } from '../lib/dialog';
import { errMessage } from '../lib/log';
import { theme, sectionLabelStyle } from '../lib/theme';
import { addDocumentProject } from '../store/projects';
import { openDocumentWorkspace } from '../store/documents';

interface NewDocumentProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Picks a Git repository and one Markdown document inside it. */
export function NewDocumentProjectDialog(props: NewDocumentProjectDialogProps) {
  const [folder, setFolder] = createSignal('');
  const [name, setName] = createSignal('');
  const [files, setFiles] = createSignal<string[]>([]);
  const [filter, setFilter] = createSignal('');
  const [documentPath, setDocumentPath] = createSignal('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);

  const visibleFiles = createMemo(() => {
    const q = filter().trim().toLowerCase();
    return q ? files().filter((f) => f.toLowerCase().includes(q)) : files();
  });

  function reset() {
    setFolder('');
    setName('');
    setFiles([]);
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
      const isGit = await invoke<boolean>(IPC.CheckIsGitRepo, { path });
      if (!isGit) {
        setError('Document projects need a Git repository. Run `git init` in the folder first.');
        return;
      }
      const list = await invoke<string[]>(IPC.ListDocumentFiles, { projectRoot: path });
      setFolder(path);
      setName(path.split('/').pop() || path);
      setFiles(list);
      setDocumentPath(list.length === 1 ? list[0] : '');
      if (list.length === 0) setError('No tracked Markdown files found. Commit a .md file first.');
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const canCreate = () => folder() && documentPath() && name().trim() && !busy();

  async function create() {
    if (!canCreate()) return;
    const id = addDocumentProject(name().trim(), folder(), documentPath());
    close();
    await openDocumentWorkspace(id);
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
          A Git repository with a Markdown document. Agents propose changes in isolated worktrees;
          you decide what enters the document.
        </p>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <span style={sectionLabelStyle}>Repository</span>
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
            <Show when={files().length > 8}>
              <input
                style={inputStyle}
                placeholder="Filter files…"
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
              />
            </Show>
            <div class="docws-picker-list" role="listbox" aria-label="Markdown files">
              <For each={visibleFiles()}>
                {(file) => (
                  <button
                    type="button"
                    role="option"
                    class="docws-picker-item"
                    aria-selected={documentPath() === file}
                    onClick={() => setDocumentPath(file)}
                  >
                    {file}
                  </button>
                )}
              </For>
            </div>
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
            Open workspace
          </button>
        </div>
      </div>
    </Dialog>
  );
}
