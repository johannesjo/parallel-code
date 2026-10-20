import { createSignal } from 'solid-js';
import type { BlockEditTarget } from './BlockEditor';

interface BlockEdit {
  target: BlockEditTarget;
  /** The edit in progress, or undefined while the block is untouched. */
  draft?: string;
}

// Outside the document pane, which History unmounts, and one per document, so
// an edit left in one never stands in the way of another: each waits there,
// as the old block dialog did, until it is saved or discarded.
const [edits, setEdits] = createSignal<ReadonlyMap<string, BlockEdit>>(new Map());
const keyOf = (root: string, path: string) => JSON.stringify([root, path]);

/** The block being edited in a document, if any. */
export function blockEditIn(root: string, path: string): BlockEdit | null {
  return edits().get(keyOf(root, path)) ?? null;
}

function update(root: string, path: string, edit: BlockEdit | null): void {
  const next = new Map(edits());
  if (edit) next.set(keyOf(root, path), edit);
  else next.delete(keyOf(root, path));
  setEdits(next);
}

/** Starts editing a block in its document, untouched. */
export function startBlockEdit(target: BlockEditTarget): void {
  update(target.projectRoot, target.documentPath, { target });
}

/** Ends the edit of a document's block, dropping its draft. */
export function endBlockEdit(target: BlockEditTarget): void {
  update(target.projectRoot, target.documentPath, null);
}

/** Keeps what has been typed, or forgets it once it matches the block again. */
export function setBlockEditDraft(target: BlockEditTarget, draft: string | undefined): void {
  if (blockEditIn(target.projectRoot, target.documentPath)?.target === target)
    update(target.projectRoot, target.documentPath, { target, draft });
}

/** Forgets the edits in a project's documents, once the project is removed. */
export function forgetBlockEdits(root: string): void {
  const next = new Map(edits());
  for (const [key, edit] of next) if (edit.target.projectRoot === root) next.delete(key);
  if (next.size !== edits().size) setEdits(next);
}

/** Forgets every edit; for tests. */
export function clearBlockEdits(): void {
  setEdits(new Map());
}
