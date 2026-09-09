import { createEffect, on, onCleanup, onMount } from 'solid-js';
import '@milkdown/crepe/theme/common/style.css';
import { createCanvasEditor } from '../lib/milkdown';
import type { CanvasEditor, CanvasSelection } from '../lib/milkdown';
import { applyBlockWrite, blockLineRange, planBlockWrite } from '../lib/canvas-blocks';
import type { BlockWrite, EditorBlock } from '../lib/canvas-blocks';
import { isMac } from '../lib/platform';

/** Quiet time after the last keystroke before edits go to disk by themselves. */
export const CANVAS_AUTOSAVE_IDLE_MS = 1500;

export interface CanvasWrite extends BlockWrite {
  /** The file content the write assumes; the backend refuses anything else. */
  expectedContent: string;
}

export interface CanvasEditorApi {
  /** Flushes unsaved edits; resolves once they are on disk or have failed. */
  save: () => Promise<void>;
  /** 1-based source lines of the blocks, or null while edits are unsaved. */
  lineRange: (fromBlock: number, toBlock: number) => { startLine: number; endLine: number } | null;
}

export interface TaskCanvasEditorProps {
  documentPath: string;
  /** What the editor shows. A new value replaces the document wholesale, so
   *  the parent only changes it when there are no unsaved edits. */
  source: string;
  onDirty: (dirty: boolean) => void;
  /** Applies the write to disk; resolves true once the file holds it. */
  onSave: (write: CanvasWrite) => Promise<boolean>;
  onSelect: (selection: CanvasSelection | null) => void;
  ref: (api: CanvasEditorApi) => void;
}

/** The WYSIWYG surface of the canvas: edits are tracked against the source
 *  they started from and written back block by block. */
export function TaskCanvasEditor(props: TaskCanvasEditorProps) {
  let host: HTMLDivElement | undefined;
  let editor: CanvasEditor | undefined;
  // The source the editor represents on disk, and how it serialised at that point.
  let loaded = '';
  let baseBlocks: EditorBlock[] = [];
  let baseMarkdown = '';
  let current = '';
  let dirty = false;
  let loading = false;
  let saving = false;
  let idle: ReturnType<typeof setTimeout> | undefined;

  function setDirty(next: boolean): void {
    if (next === dirty) return;
    dirty = next;
    props.onDirty(next);
  }

  function rebase(source: string): void {
    if (!editor) return;
    loaded = source;
    baseBlocks = editor.blocks();
    baseMarkdown = editor.markdown();
    current = baseMarkdown;
    setDirty(false);
  }

  function scheduleSave(): void {
    clearTimeout(idle);
    idle = setTimeout(() => void save(), CANVAS_AUTOSAVE_IDLE_MS);
  }

  function onMarkdown(markdown: string): void {
    if (loading) return;
    current = markdown;
    setDirty(markdown !== baseMarkdown);
    if (dirty) scheduleSave();
    else clearTimeout(idle);
  }

  async function save(): Promise<void> {
    clearTimeout(idle);
    if (!editor || saving || !dirty) return;
    const editedBlocks = editor.blocks();
    const whole = editor.markdown();
    const write = planBlockWrite({
      source: loaded,
      sourceBlocks: editor.sourceBlocks(loaded),
      baseBlocks,
      editedBlocks,
      whole,
    });
    if (!write) {
      setDirty(false);
      return;
    }
    saving = true;
    try {
      const ok = await props.onSave({ ...write, expectedContent: loaded });
      if (!ok) return;
      loaded = applyBlockWrite(loaded, write);
      baseBlocks = editedBlocks;
      baseMarkdown = whole;
      setDirty(current !== baseMarkdown);
      if (dirty) scheduleSave();
    } finally {
      saving = false;
    }
  }

  function lineRange(fromBlock: number, toBlock: number) {
    if (!editor || dirty) return null;
    return blockLineRange(loaded, editor.sourceBlocks(loaded), fromBlock, toBlock);
  }

  onMount(() => {
    if (!host) return;
    const root = host;
    const initial = props.source;
    let disposed = false;
    const ready = createCanvasEditor({
      root,
      defaultValue: initial,
      placeholder: 'Write, or type / for blocks…',
      onMarkdown,
      onSelection: (selection) => props.onSelect(selection),
    });
    // eslint-disable-next-line solid/reactivity -- props.ref is a stable callback, handed the API once
    void ready.then((created) => {
      if (disposed) {
        void created.destroy();
        return;
      }
      editor = created;
      rebase(initial);
      props.ref({ save, lineRange });
    });
    onCleanup(() => {
      disposed = true;
      clearTimeout(idle);
      void editor?.destroy();
      editor = undefined;
    });
  });

  // Disk content the parent decided should win replaces the document.
  createEffect(
    on(
      () => props.source,
      (source) => {
        if (!editor || source === loaded) return;
        loading = true;
        try {
          editor.load(source);
        } finally {
          loading = false;
        }
        rebase(source);
        props.onSelect(null);
      },
      { defer: true },
    ),
  );

  return (
    <div
      ref={host}
      class="task-canvas-editor"
      data-testid="canvas-editor"
      aria-label={`Editor for ${props.documentPath}`}
      style={{ flex: '1', 'min-height': '0', overflow: 'auto' }}
      onKeyDown={(e) => {
        if (e.key === 's' && (isMac ? e.metaKey : e.ctrlKey)) {
          e.preventDefault();
          void save();
        }
      }}
    />
  );
}
