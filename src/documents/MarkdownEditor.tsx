import { Show, createEffect, createSignal, on, onCleanup, untrack } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import { TaskCanvasEditor } from '../components/TaskCanvasEditor';
import type { CanvasDraft, CanvasEditorApi, CanvasWrite } from '../components/TaskCanvasEditor';
import { applyBlockWrite, normalizeLineEndings } from '../lib/canvas-blocks';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import {
  pendingMarkdownWrite,
  readMarkdownDraft,
  registerMarkdownEditor,
  trackMarkdownWrite,
  writeMarkdownDraft,
} from './markdown-editing';
import { SyncIcon } from '../components/icons';

interface MarkdownEditorProps {
  projectRoot: string;
  documentPath: string;
  source: string;
  missing: boolean;
  /** Where to put the cursor; a new `seq` repeats the move to the same line. */
  reveal?: { line: number; seq: number };
  /** The move was made; the owner drops it so a remount does not repeat it. */
  onRevealed?: () => void;
  onSaved: () => void | Promise<void>;
}

export function MarkdownEditor(props: MarkdownEditorProps) {
  const pending = untrack(() => pendingMarkdownWrite(props.projectRoot, props.documentPath));
  const refreshSnapshot = untrack(() => props.onSaved);
  const [ready, setReady] = createSignal(!pending);
  const [error, setError] = createSignal('');
  let mounted = true;
  let saveEditor: (() => Promise<boolean>) | undefined;
  const waiting = pending
    ?.then(async () => {
      if (!mounted) return;
      // The snapshot obtained when reopening may predate the outstanding write.
      await refreshSnapshot();
      if (mounted) setReady(true);
    })
    .catch((err: unknown) => {
      if (mounted) setError(errMessage(err));
    });
  const save = () => (mounted && saveEditor ? saveEditor() : Promise.resolve(false));
  onCleanup(registerMarkdownEditor(() => (waiting ? waiting.then(save) : save())));
  onCleanup(() => {
    mounted = false;
  });

  return (
    <Show
      when={ready()}
      fallback={
        <div class="docws-editor-status" role={error() ? 'alert' : 'status'}>
          {error() || 'Finishing the previous save…'}
        </div>
      }
    >
      <MarkdownEditorSession
        {...props}
        onReady={(save) => {
          saveEditor = save;
        }}
      />
    </Show>
  );
}

function MarkdownEditorSession(
  props: MarkdownEditorProps & { onReady: (save: () => Promise<boolean>) => void },
) {
  const root = untrack(() => props.projectRoot);
  const path = untrack(() => props.documentPath);
  const stored = readMarkdownDraft(root, path);
  const initialDraft =
    stored && stored.markdown !== normalizeLineEndings(untrack(() => props.source))
      ? stored
      : undefined;
  const [base, setBase] = createSignal(initialDraft?.source ?? untrack(() => props.source));
  const [dirty, setDirty] = createSignal(!!initialDraft);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');
  const [backupError, setBackupError] = createSignal('');
  let editor: CanvasEditorApi | undefined;
  let mounted = true;
  let latestDraft: CanvasDraft | null = initialDraft ?? null;
  const changedOnDisk = () => dirty() && (props.missing || props.source !== base());
  const notice = () =>
    [
      error() || backupError(),
      changedOnDisk()
        ? 'The file changed on disk. Your draft is kept; copy it before reloading.'
        : '',
    ]
      .filter(Boolean)
      .join(' ');
  // Reloading throws the draft away, so it takes a second click; the offer
  // lapses on its own so a later stray click cannot complete it.
  const [confirmReload, setConfirmReload] = createSignal(false);
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(confirmTimer));
  function reloadFromDisk() {
    clearTimeout(confirmTimer);
    if (!confirmReload()) {
      setConfirmReload(true);
      confirmTimer = setTimeout(() => setConfirmReload(false), 4000);
      return;
    }
    setConfirmReload(false);
    editor?.reload(props.source);
    setBase(props.source);
    setError('');
  }

  function persistDraft(draft: CanvasDraft | null) {
    try {
      writeMarkdownDraft(root, path, draft);
      if (mounted) setBackupError('');
    } catch {
      if (mounted)
        setBackupError('Could not back up your draft. Save before closing or switching documents.');
    }
  }

  function backup(draft: CanvasDraft | null) {
    if (!mounted) return;
    latestDraft = draft;
    persistDraft(draft);
  }

  // The editor mounts after this effect first runs, so `ref` replays the target.
  const revealNow = () => {
    const target = props.reveal;
    if (!target || !editor) return;
    editor.goToLine(target.line);
    props.onRevealed?.();
  };
  createEffect(on(() => props.reveal?.seq, revealNow));

  createEffect(() => {
    const source = props.source;
    // A watcher update deferred while saving must be applied once the draft is clean.
    if (!dirty() && !saving()) setBase(source);
  });

  async function save(write: CanvasWrite): Promise<boolean> {
    setSaving(true);
    setError('');
    let saved: string | undefined;
    try {
      await invoke(IPC.WriteDocumentBlock, { projectRoot: root, documentPath: path, ...write });
      saved = applyBlockWrite(write.expectedContent, write);
      if (mounted) {
        setBase(saved);
        await props.onSaved();
      }
      return true;
    } catch (err) {
      if (mounted) setError(errMessage(err));
      return false;
    } finally {
      if (!mounted && saved !== undefined) {
        // Preserve the last buffer, but compare its next save against the write that just finished.
        persistDraft(
          latestDraft && latestDraft.markdown !== normalizeLineEndings(saved)
            ? { source: saved, markdown: latestDraft.markdown }
            : null,
        );
      }
      if (mounted) setSaving(false);
    }
  }

  onCleanup(() => {
    mounted = false;
  });
  if (stored && !initialDraft) backup(null);

  return (
    <div class="docws-markdown-editor">
      {/* Errors and the changed-on-disk notice share the status row instead of
          banners above the editor, so a notice moves the text down only when it is
          too long for the row and wraps. */}
      <div class="docws-editor-status">
        <span
          class="docws-editor-notice"
          classList={{ 'is-error': !!(error() || backupError()) }}
          role="alert"
        >
          {notice()}
        </span>
        <span role="status">{saving() ? 'Saving…' : dirty() ? 'Unsaved edits' : 'Saved'}</span>
        <Show when={changedOnDisk()}>
          <button
            type="button"
            class="docws-btn docws-btn-sm"
            disabled={saving() || props.missing}
            onClick={reloadFromDisk}
          >
            <SyncIcon size={12} />
            {confirmReload() ? 'Discard my draft?' : 'Reload from disk'}
          </button>
        </Show>
        <button
          type="button"
          class="docws-btn docws-btn-sm"
          disabled={saving() || !dirty()}
          onClick={() => void editor?.save()}
          title="Save now (Cmd/Ctrl+S); autosaves when you pause"
        >
          Save
        </button>
      </div>
      <TaskCanvasEditor
        documentPath={path}
        source={base()}
        initialDraft={initialDraft}
        onDirty={setDirty}
        onDraft={backup}
        onSave={(write) => trackMarkdownWrite(root, path, save(write))}
        onSelect={() => {}}
        ref={(api) => {
          editor = api;
          revealNow();
          props.onReady(api.save);
        }}
      />
    </div>
  );
}
