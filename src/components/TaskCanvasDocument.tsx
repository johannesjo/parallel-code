import { Show, createEffect, createSignal, onCleanup, onMount, untrack } from 'solid-js';
import type { JSX } from 'solid-js';
import { sendPrompt, isAgentAskingQuestion } from '../store/store';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { errMessage } from '../lib/log';
import { theme } from '../lib/theme';
import { sf } from '../lib/fontScale';
import { buildCanvasReference, headingAbove } from '../lib/canvas-reference';
import { applyBlockWrite } from '../lib/canvas-blocks';
import type { CanvasSelection } from '../lib/milkdown';
import type { DocumentSnapshot } from '../documents/types';
import type { Task } from '../store/types';
import { TaskCanvasBody } from './TaskCanvasBody';
import type { CanvasEditorApi, CanvasWrite } from './TaskCanvasEditor';

interface TaskCanvasDocumentProps {
  task: Task;
  agentId: string;
  /** Worktree-relative path of the Markdown file this tab shows. */
  path: string;
  /** Hidden tabs stay mounted so their unsaved edits survive switching. */
  active: boolean;
  onDirty: (dirty: boolean) => void;
}

const textBtnStyle = (primary = false): JSX.CSSProperties => ({
  background: primary ? `color-mix(in srgb, ${theme.accent} 14%, ${theme.bgInput})` : 'transparent',
  border: `1px solid ${primary ? `color-mix(in srgb, ${theme.accent} 30%, ${theme.border})` : theme.border}`,
  color: theme.fg,
  cursor: 'pointer',
  'border-radius': 'var(--radius-sm)',
  padding: '3px 8px',
  'font-size': sf(11),
  'font-family': 'var(--font-mono)',
  'line-height': '1',
  'flex-shrink': '0',
});

/**
 * One canvas tab: a Markdown file of the worktree, edited in place with
 * changes written straight back, and a source of passages for the agent.
 */
export function TaskCanvasDocument(props: TaskCanvasDocumentProps) {
  const [snapshot, setSnapshot] = createSignal<DocumentSnapshot | null>(null);
  const [error, setError] = createSignal('');
  // The content the editor shows; disk changes replace it only while there
  // are no unsaved edits, and every save is guarded by it.
  const [base, setBase] = createSignal<string | null>(null);
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  let editorApi: CanvasEditorApi | undefined;

  const watcherKey = () => `task-canvas:${props.task.id}:${props.path}`;
  const changedOnDisk = () => {
    const disk = snapshot()?.content;
    return dirty() && disk !== undefined && disk !== base();
  };
  const canSend = () => !!props.agentId && !isAgentAskingQuestion(props.agentId);

  // Follow the file: read it once, then let the watcher push changes.
  createEffect(() => {
    const documentPath = props.path;
    const projectRoot = props.task.worktreePath;
    const key = watcherKey();
    void invoke<DocumentSnapshot>(IPC.ReadDocument, { projectRoot, documentPath })
      .then(setSnapshot)
      .catch((e) => setError(errMessage(e)));
    void invoke(IPC.StartDocumentWatcher, { key, projectRoot, documentPath }).catch((e) =>
      setError(errMessage(e)),
    );
    onCleanup(() => void invoke(IPC.StopDocumentWatcher, { key }).catch(() => undefined));
  });

  // Disk wins whenever the editor has nothing to lose.
  createEffect(() => {
    const disk = snapshot()?.content;
    if (disk !== undefined && !untrack(dirty)) setBase(disk);
  });

  createEffect(() => props.onDirty(dirty()));
  // A closed tab must not keep the column counted as dirty.
  onCleanup(() => props.onDirty(false));

  onMount(() => {
    const off = window.electron.ipcRenderer.on(IPC.DocumentChanged, (payload: unknown) => {
      const p = payload as { key?: string; snapshot?: DocumentSnapshot } | undefined;
      if (p?.snapshot && p.key === untrack(watcherKey)) setSnapshot(p.snapshot);
    });
    onCleanup(off);
  });

  async function save(write: CanvasWrite): Promise<boolean> {
    setSaving(true);
    setError('');
    try {
      await invoke(IPC.WriteDocumentBlock, {
        projectRoot: props.task.worktreePath,
        documentPath: props.path,
        ...write,
      });
      const saved = applyBlockWrite(write.expectedContent, write);
      setBase(saved);
      setSnapshot((s) => (s ? { ...s, content: saved } : s));
      return true;
    } catch (e) {
      setError(errMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  }

  function reloadFromDisk(): void {
    const disk = snapshot()?.content;
    if (disk !== undefined) setBase(disk);
  }

  async function sendPassage(instruction: string, selection: CanvasSelection): Promise<void> {
    // Flush first so the line numbers point at what the agent will read.
    await editorApi?.save();
    const source = base() ?? '';
    const lines = editorApi?.lineRange(selection.fromBlock, selection.toBlock) ?? null;
    const text = buildCanvasReference({
      documentPath: props.path,
      quote: selection.quote,
      instruction,
      location: lines ? { ...lines, heading: headingAbove(source, lines.startLine) } : null,
    });
    try {
      await sendPrompt(props.task.id, props.agentId, text);
    } catch (e) {
      setError(errMessage(e));
    }
  }

  return (
    <div
      data-testid="canvas-document"
      data-path={props.path}
      style={{
        flex: '1',
        'min-height': '0',
        display: props.active ? 'flex' : 'none',
        'flex-direction': 'column',
      }}
    >
      <Show when={dirty() || saving()}>
        <div
          style={{
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'flex-end',
            gap: '6px',
            padding: '4px 8px',
            'border-bottom': `1px solid ${theme.border}`,
            color: theme.fgMuted,
            'font-size': sf(11),
          }}
        >
          <span>{saving() ? 'Saving…' : 'Unsaved edits'}</span>
          <button
            type="button"
            style={{ ...textBtnStyle(true), opacity: saving() ? '0.5' : '1' }}
            disabled={saving()}
            onClick={() => void editorApi?.save()}
            title="Save to disk now (it saves by itself when you pause)"
          >
            Save
          </button>
        </div>
      </Show>
      <Show when={error()}>
        <div role="alert" style={{ padding: '4px 8px', color: theme.error, 'font-size': sf(11) }}>
          {error()}
        </div>
      </Show>
      <Show when={changedOnDisk()}>
        <div style={{ padding: '4px 8px', color: theme.warning, 'font-size': sf(11) }}>
          The file changed on disk while you were editing.{' '}
          <button type="button" style={textBtnStyle()} onClick={reloadFromDisk}>
            Reload and drop my edits
          </button>
        </div>
      </Show>
      <Show when={base() !== null}>
        <TaskCanvasBody
          documentPath={props.path}
          source={base() ?? ''}
          missing={snapshot()?.missing ?? false}
          onDirty={setDirty}
          onSave={save}
          editorRef={(api) => (editorApi = api)}
          canSend={canSend()}
          onSend={sendPassage}
        />
      </Show>
    </div>
  );
}
