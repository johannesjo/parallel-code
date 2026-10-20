import type { CanvasDraft } from '../components/TaskCanvasEditor';

const draftKey = (root: string, path: string): string =>
  `document-markdown-draft:${JSON.stringify([root, path])}`;

/** A backup survives navigation and app restarts, never replacing the disk baseline. */
export function readMarkdownDraft(root: string, path: string): CanvasDraft | undefined {
  try {
    const raw = localStorage.getItem(draftKey(root, path));
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object') return;
    const draft = value as Partial<CanvasDraft>;
    if (typeof draft.source === 'string' && typeof draft.markdown === 'string')
      return { source: draft.source, markdown: draft.markdown };
  } catch {
    // Unavailable storage must not prevent editing a file.
  }
}

export function writeMarkdownDraft(root: string, path: string, draft: CanvasDraft | null): void {
  const key = draftKey(root, path);
  if (draft) localStorage.setItem(key, JSON.stringify(draft));
  else localStorage.removeItem(key);
}

let saveEditor: (() => Promise<boolean>) | undefined;

// Writes outlive their editor. Reopening the same file waits until recovery state is reconciled.
const pendingWrites = new Map<string, Promise<boolean>>();

export function pendingMarkdownWrite(root: string, path: string): Promise<boolean> | undefined {
  return pendingWrites.get(draftKey(root, path));
}

export function trackMarkdownWrite(
  root: string,
  path: string,
  write: Promise<boolean>,
): Promise<boolean> {
  const key = draftKey(root, path);
  pendingWrites.set(key, write);
  const clear = () => {
    if (pendingWrites.get(key) === write) pendingWrites.delete(key);
  };
  void write.then(clear, clear);
  return write;
}

/** Flush before actions that read or replace the canonical document. */
export function registerMarkdownEditor(save: () => Promise<boolean>): () => void {
  saveEditor = save;
  return () => {
    if (saveEditor === save) saveEditor = undefined;
  };
}

export async function flushMarkdownEditor(): Promise<boolean> {
  return saveEditor ? saveEditor() : true;
}

/** Preserve synchronous navigation when no editor is mounted. */
export function afterSavingMarkdown(action: () => void): void {
  const save = saveEditor;
  if (!save) action();
  else
    void save().then((ok) => {
      if (ok && saveEditor === save) action();
    });
}
