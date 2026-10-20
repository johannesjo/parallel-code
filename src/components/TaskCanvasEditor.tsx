import { createEffect, on, onCleanup, onMount } from 'solid-js';
import { createCanvasEditor } from '../lib/live-markdown';
import type { CanvasEditor, CanvasSelection } from '../lib/live-markdown';
import { minimalBlockWrite, normalizeLineEndings } from '../lib/canvas-blocks';
import type { BlockWrite } from '../lib/canvas-blocks';
import { isMac } from '../lib/platform';

/** Quiet time after the last keystroke before edits go to disk by themselves. */
export const CANVAS_AUTOSAVE_IDLE_MS = 1500;

export interface CanvasWrite extends BlockWrite {
  /** The file content the write assumes; the backend refuses anything else. */
  expectedContent: string;
}

export interface CanvasEditorApi {
  /** Flushes unsaved edits; resolves once they are on disk or have failed. */
  save: () => Promise<boolean>;
  /** Replaces the editor state even when it matches an in-flight save. */
  reload: (source: string) => void;
  /** Cursor to the start of a 1-based line, scrolled into view. */
  goToLine: (line: number) => void;
}

export interface CanvasDraft {
  source: string;
  markdown: string;
}

export interface TaskCanvasEditorProps {
  documentPath: string;
  /** What the editor shows. A new value replaces the document wholesale, so
   *  the parent only changes it when there are no unsaved edits. */
  source: string;
  initialDraft?: CanvasDraft;
  onDirty: (dirty: boolean) => void;
  /** Applies the write to disk; resolves true once the file holds it. */
  onSave: (write: CanvasWrite) => Promise<boolean>;
  onSelect: (selection: CanvasSelection | null) => void;
  ref: (api: CanvasEditorApi) => void;
  onDraft?: (draft: CanvasDraft | null) => void;
}

/** The live Markdown surface of the canvas, guarded against stale disk writes. */
export function TaskCanvasEditor(props: TaskCanvasEditorProps) {
  let host: HTMLDivElement | undefined;
  let editor: CanvasEditor | undefined;
  // The source the editor represents on disk.
  let loaded = '';
  let pendingSource: string | undefined;
  let dirty = false;
  let inFlight: Promise<boolean> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;

  function setDirty(next: boolean): void {
    if (next === dirty) return;
    dirty = next;
    props.onDirty(next);
  }

  function rebase(source: string): void {
    if (!editor) return;
    loaded = source;
    setDirty(false);
  }

  function scheduleSave(): void {
    clearTimeout(idle);
    idle = setTimeout(() => void save(), CANVAS_AUTOSAVE_IDLE_MS);
  }

  function onChange(matchesSaved: boolean): void {
    setDirty(!matchesSaved);
    props.onDraft?.(draft());
    if (dirty) scheduleSave();
    else clearTimeout(idle);
  }

  async function save(): Promise<boolean> {
    clearTimeout(idle);
    if (inFlight) {
      if (!(await inFlight)) return false;
      return dirty ? save() : true;
    }
    const activeEditor = editor;
    if (!activeEditor) return false;
    if (!dirty) return true;
    const whole = activeEditor.markdown();
    if (whole === normalizeLineEndings(loaded)) {
      activeEditor.markSaved(whole);
      setDirty(false);
      return true;
    }
    const source = loaded;
    const write = minimalBlockWrite(source, whole);
    const saved =
      source.slice(0, write.startOffset) + write.replacement + source.slice(write.endOffset);
    pendingSource = saved;
    props.onDraft?.(draft());
    const operation = (async (): Promise<boolean> => {
      try {
        const ok = await props.onSave({ ...write, expectedContent: source });
        if (!ok) return false;
        if (editor !== activeEditor) return true;
        loaded = saved;
        setDirty(!activeEditor.markSaved(whole));
        if (dirty) scheduleSave();
        return true;
      } finally {
        pendingSource = undefined;
        if (editor === activeEditor) props.onDraft?.(draft());
      }
    })();
    inFlight = operation;
    let ok: boolean;
    try {
      ok = await operation;
    } finally {
      if (inFlight === operation) inFlight = undefined;
    }
    // Navigation and agent actions must wait for text typed during the write too.
    return ok && dirty && editor ? save() : ok;
  }

  function reload(source: string): void {
    if (!editor) return;
    editor.load(source);
    rebase(source);
    props.onDraft?.(null);
    props.onSelect(null);
  }

  function draft(): CanvasDraft | null {
    // An undo may match the old baseline while an outstanding write is about to replace it.
    return (dirty || pendingSource !== undefined) && editor
      ? { source: loaded, markdown: editor.markdown() }
      : null;
  }

  onMount(() => {
    if (!host) return;
    const root = host;
    const initial = props.initialDraft?.source ?? props.source;
    editor = createCanvasEditor({
      root,
      defaultValue: props.initialDraft?.markdown ?? initial,
      placeholder: 'Write Markdown…',
      ariaLabel: `Editor for ${props.documentPath}`,
      onChange,
      onSelection: (selection) => props.onSelect(selection),
    });
    rebase(initial);
    setDirty(!editor.markSaved(initial));
    if (dirty) scheduleSave();
    props.ref({ save, reload, goToLine: (line) => editor?.goToLine(line) });
    onCleanup(() => {
      clearTimeout(idle);
      editor?.destroy();
      editor = undefined;
    });
  });

  // Disk content the parent decided should win replaces the document.
  createEffect(
    on(
      () => props.source,
      (source) => {
        if (!editor || source === loaded || source === pendingSource) return;
        reload(source);
      },
      { defer: true },
    ),
  );

  return (
    <div
      ref={host}
      class="task-canvas-editor"
      data-testid="canvas-editor"
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
