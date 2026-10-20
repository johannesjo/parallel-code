/**
 * Panel state of the open workspace: the project's files, which rail tab is
 * up and the one-shot output being read. Kept apart from the document store
 * because none of it is about the document.
 */
import { createStore } from 'solid-js/store';
import { store } from '../store/core';
import { updateProject } from '../store/projects';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';

export type RailTab = 'agent' | 'runs' | 'notes';

/** A one-shot candidate whose output is open for reading. */
export interface OutputTarget {
  runId: string;
  candidateId: string;
}

interface WorkspaceUiState {
  files: string[];
  filesError: string | null;
  /** The header's document switcher is dropped; the shortcut opens it too. */
  filesOpen: boolean;
  railTab: RailTab;
  output: OutputTarget | null;
  focusedAnnotationId: string | null;
}

const [ui, setUi] = createStore<WorkspaceUiState>({
  files: [],
  filesError: null,
  filesOpen: false,
  railTab: 'agent',
  output: null,
  focusedAnnotationId: null,
});

export { ui as workspaceUi };

export async function loadDocumentFiles(projectRoot: string): Promise<void> {
  try {
    const files = await invoke<string[]>(IPC.ListDocumentFiles, { projectRoot });
    setUi({ files, filesError: null });
  } catch (err) {
    setUi({ files: [], filesError: errMessage(err) });
  }
}

export function setFilesOpen(open: boolean): void {
  setUi('filesOpen', open);
}

export function setRailTab(tab: RailTab): void {
  setUi('railTab', tab);
  const id = store.activeDocumentProjectId;
  if (id) updateProject(id, { documentPanelCollapsed: false });
}

export function openCandidateOutput(target: OutputTarget | null): void {
  setUi('output', target);
}

export function focusAnnotation(id: string | null): void {
  // A second click should retry revealing the note after a failed editor save.
  if (id !== null && ui.focusedAnnotationId === id) setUi('focusedAnnotationId', null);
  setUi('focusedAnnotationId', id);
}

/** Back to the defaults when a workspace opens; files are per project. */
export function resetWorkspaceUi(): void {
  setUi({
    files: [],
    filesError: null,
    filesOpen: false,
    railTab: 'agent',
    output: null,
    focusedAnnotationId: null,
  });
}

/**
 * The note bubbles pinned open right now, by what closes them. A pinned
 * bubble covers the prose, so Escape shuts it before anything else in the
 * workspace — even with the focus nowhere near it, where the bubble's own
 * key handler cannot see the key.
 */
const pinnedBubbles = new Set<() => void>();

export function registerPinnedBubble(dismiss: () => void): () => void {
  pinnedBubbles.add(dismiss);
  return () => {
    pinnedBubbles.delete(dismiss);
  };
}

/** Closes every pinned bubble; false when there was none to close. */
export function dismissPinnedBubbles(): boolean {
  if (pinnedBubbles.size === 0) return false;
  for (const dismiss of [...pinnedBubbles]) dismiss();
  return true;
}

/**
 * The forms open over the compare view (refine, merge), by what closes them.
 * Escape shuts the one opened last before the dialog itself, even with the
 * focus outside the form, where its own key handler cannot see the key.
 */
const compareForms: (() => void)[] = [];

export function registerCompareForm(close: () => void): () => void {
  compareForms.push(close);
  return () => {
    const at = compareForms.indexOf(close);
    if (at >= 0) compareForms.splice(at, 1);
  };
}

/** Closes the form opened last; false when none is open. */
export function closeTopCompareForm(): boolean {
  const close = compareForms.pop();
  if (!close) return false;
  close();
  return true;
}
