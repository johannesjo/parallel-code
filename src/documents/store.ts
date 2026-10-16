/**
 * Document workspace state: the rendered canonical document, the runs made
 * against it, and the comparison/history views. Kept apart from the task
 * store because none of it is a task: proposals live in Git, not in panels.
 */
import { setActiveTask } from '../store/navigation';
import { documentAgentTaskId } from './task-id';
import { untrack } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { errMessage } from '../lib/log';
import type { AgentDef } from '../ipc/types';
import type {
  DocumentAnchor,
  DocumentAnnotation,
  DocumentAnnotationEvent,
  DocumentAnnotationKind,
  DocumentCandidateRecord,
  DocumentCandidateSpec,
  DocumentRunEvent,
  DocumentRunRecord,
  DocumentScope,
  DocumentSnapshot,
  QuickEditTarget,
} from './types';
import {
  DEFAULT_DOCUMENT_MAIN_AGENT,
  MAX_DOCUMENT_CANDIDATES,
  documentAgentSupport,
} from '../../electron/documents/shared';
import { store, setStore } from '../store/core';
import { addQuickEditProject, getProject, updateProject } from '../store/projects';
import { showNotification } from '../store/notification';
import type { DocumentModelChoice, Project } from '../store/types';
import { afterSavingMarkdown, flushMarkdownEditor } from './markdown-editing';
import { pushRecentPath } from './path-tree';
import { closeProjectPages } from '../store/project-pages';

export type DocumentView = 'document' | 'history';

/** A block-aligned selection in the rendered document. */
export interface DocumentSelection {
  startBlock: number;
  endBlock: number;
  startLine: number;
  endLine: number;
  quote: string;
  heading?: string;
  wholeDocument: boolean;
}

/** What the composer does with the passage. */
export type ComposerMode = 'task' | 'proposals' | 'note' | 'question';

/** What the composer opens with: a bubble turned into a task, or a block's hover action. */
export interface ComposerDraft {
  /** Stable across remounts and edits, also the ID of an automatically saved note. */
  id?: string;
  text: string;
  noteSaveStatus?: 'saving' | 'error';
  annotationId?: string;
  /** Opens the composer on this mode. */
  mode?: ComposerMode;
}

interface DocumentWorkspaceState {
  projectId: string | null;
  /** Repo-relative path of the document on screen; the project's document
   *  until a link or the file tree opens another. */
  documentPath: string | null;
  /** Documents left behind by links and file picks, oldest first; Back walks it. */
  documentTrail: string[];
  annotations: DocumentAnnotation[];
  /** Bubbles deleted while the undo offer is up, newest last; Undo restores them one by one. */
  recentlyDeleted: DocumentAnnotation[];
  showResolved: boolean;
  composerDraft: ComposerDraft | null;
  snapshot: DocumentSnapshot | null;
  loading: boolean;
  error: string | null;
  runs: Record<string, DocumentRunRecord>;
  runOrder: string[];
  /** Streamed log lines per candidate id, bounded. */
  logs: Record<string, string[]>;
  view: DocumentView;
  compareRunId: string | null;
  compareCandidateId: string | null;
  /** Run whose single proposal is under review inline, in the document itself. */
  reviewRunId: string | null;
  selection: DocumentSelection | null;
  dispatching: boolean;
}

const MAX_LOG_LINES = 400;
/** Deeper than anyone follows links; keeps a long session from growing the trail forever. */
const MAX_TRAIL = 20;

const [docStore, setDocStore] = createStore<DocumentWorkspaceState>({
  projectId: null,
  documentPath: null,
  documentTrail: [],
  annotations: [],
  recentlyDeleted: [],
  showResolved: false,
  composerDraft: null,
  snapshot: null,
  loading: false,
  error: null,
  runs: {},
  runOrder: [],
  logs: {},
  view: 'document',
  compareRunId: null,
  compareCandidateId: null,
  reviewRunId: null,
  selection: null,
  dispatching: false,
});

export { docStore as documentStore };

/**
 * Root of the open workspace's project, kept from when it opened: removing the
 * project from the app drops it from the store, yet its edits still need saving.
 */
let openProjectRoot: string | null = null;

function activeProject(): Project | undefined {
  return docStore.projectId ? getProject(docStore.projectId) : undefined;
}

/** The document on screen, or null when no workspace is open. */
export function activeDocumentPath(): string | null {
  return docStore.documentPath;
}

function requireProject(): { project: Project; documentPath: string } {
  const project = activeProject();
  const documentPath = docStore.documentPath;
  if (!project || !documentPath) throw new Error('No document project is open.');
  return { project, documentPath };
}

/** One watcher per document on screen; a stale event from the last document
 *  carries the old key and is dropped. */
function watcherKey(projectId: string, documentPath: string): string {
  return `doc:${projectId}:${documentPath}`;
}

function currentWatcherKey(): string | null {
  return docStore.projectId && docStore.documentPath
    ? watcherKey(docStore.projectId, docStore.documentPath)
    : null;
}

/** True while the workspace still shows the project a request was made for. */
function stillOpen(projectId: string): boolean {
  return docStore.projectId === projectId;
}

export async function refreshDocumentSnapshot(): Promise<void> {
  const project = activeProject();
  const documentPath = docStore.documentPath;
  if (!project || !documentPath) return;
  try {
    const snapshot = await invoke<DocumentSnapshot>(IPC.ReadDocument, {
      projectRoot: project.path,
      documentPath,
    });
    if (stillOpen(project.id) && docStore.documentPath === documentPath) {
      setDocStore({ snapshot, error: null });
      if (!snapshot.missing && project.documentOpenPath !== documentPath)
        updateProject(project.id, {
          documentOpenPath: documentPath,
          documentRecentPaths: pushRecentPath(project.documentRecentPaths ?? [], documentPath),
        });
    }
  } catch (err) {
    if (stillOpen(project.id) && docStore.documentPath === documentPath)
      setDocStore('error', errMessage(err));
  }
}

function sortRunIds(runs: Record<string, DocumentRunRecord>): string[] {
  return Object.values(runs)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => r.id);
}

export async function loadDocumentRuns(): Promise<void> {
  const project = activeProject();
  if (!project) return;
  try {
    const runs = await invoke<DocumentRunRecord[]>(IPC.ListDocumentRuns, {
      projectRoot: project.path,
    });
    const byId: Record<string, DocumentRunRecord> = {};
    for (const run of runs) byId[run.id] = run;
    if (!stillOpen(project.id)) return;
    setDocStore(
      produce((s) => {
        s.runs = byId;
        s.runOrder = sortRunIds(byId);
      }),
    );
  } catch (err) {
    if (stillOpen(project.id)) setDocStore('error', errMessage(err));
  }
}

function stopCurrentWatcher(): void {
  const key = currentWatcherKey();
  if (key) void invoke(IPC.StopDocumentWatcher, { key }).catch(() => undefined);
}

/** Watches the document on screen; replaces whatever was watched before. */
function startWatcher(projectId: string, projectRoot: string, documentPath: string): void {
  void invoke(IPC.StartDocumentWatcher, {
    key: watcherKey(projectId, documentPath),
    projectRoot,
    documentPath,
  }).catch((err) => {
    untrack(() => {
      if (stillOpen(projectId)) setDocStore('error', errMessage(err));
    });
  });
}

/**
 * Brings a quick edit's copy up to date with its original and keeps them in
 * step. Asked on every open: the backend may have stopped the sync, and a
 * running one makes this cheap. A missing original still opens the copy, so
 * nothing written there is lost.
 */
async function syncQuickEdit(project: Project): Promise<void> {
  const sourcePath = project.quickEditSource;
  if (!sourcePath) return;
  try {
    notifyConflict(await invoke<QuickEditTarget>(IPC.OpenQuickEdit, { sourcePath }));
  } catch (err) {
    showNotification(`Showing the last copy of ${sourcePath}: ${errMessage(err)}`);
  }
}

/** Both sides changed while nothing synced; the copy's version is in a file the user has to be told about. */
function notifyConflict(target: QuickEditTarget): void {
  if (target.warning) showNotification(target.warning);
}

/**
 * Opens `sourcePath` as a quick edit, reusing the project it already has.
 * `stillWanted` is asked once the copy is ready; false adds and opens nothing.
 */
export async function openQuickEdit(
  sourcePath: string,
  create = false,
  stillWanted: () => boolean = () => true,
): Promise<void> {
  const target = await invoke<QuickEditTarget>(IPC.OpenQuickEdit, { sourcePath, create });
  notifyConflict(target);
  if (!stillWanted()) return;
  const existing = store.projects.find(
    (p) => p.quickEditSource === target.sourcePath && p.path === target.projectRoot,
  );
  await openDocumentWorkspace(existing?.id ?? addQuickEditProject(target));
}

/** Opens a path a task printed or lists as a quick edit, saying so if that fails. */
export function editAsDocument(filePath: string): void {
  openQuickEdit(filePath).catch((err: unknown) =>
    showNotification(`Could not open ${filePath} as a document: ${errMessage(err)}`),
  );
}

export async function openDocumentWorkspace(projectId: string): Promise<void> {
  const project = getProject(projectId);
  if (!project?.documentPath || !store.documentWorkspacesEnabled) return;
  // Only quick edits wait: an await here would hold back the loading state of every open.
  // An open one is already syncing, so switching back to it does not wait either.
  if (project.quickEditSource && docStore.projectId !== projectId) await syncQuickEdit(project);
  closeProjectPages();
  if (docStore.projectId === projectId) {
    setActiveTask(documentAgentTaskId(projectId));
    return;
  }
  // Replacing an open project leaves its document like closing it does.
  if (docStore.projectId) commitEditsOnLeave();
  stopCurrentWatcher();
  openProjectRoot = project.path;
  const documentPath =
    typeof project.documentOpenPath === 'string' && project.documentOpenPath
      ? project.documentOpenPath
      : project.documentPath;
  setDocStore({
    projectId,
    documentPath,
    documentTrail: [],
    snapshot: null,
    loading: true,
    error: null,
    runs: {},
    runOrder: [],
    logs: {},
    view: 'document',
    compareRunId: null,
    compareCandidateId: null,
    reviewRunId: null,
    selection: null,
    annotations: [],
    recentlyDeleted: [],
    composerDraft: recoveredNoteDraft(project.path, documentPath),
  });
  setStore('activeDocumentProjectId', projectId);
  // Start watching before the first await so a quick close can stop it.
  startWatcher(projectId, project.path, documentPath);
  await Promise.all([refreshDocumentSnapshot(), loadDocumentRuns(), loadDocumentAnnotations()]);
  if (stillOpen(projectId)) setDocStore('loading', false);
}

/**
 * Shows another file of the open project: the target of an internal link or a
 * pick in the file tree. The document left goes on the trail for Back.
 */
export async function openDocumentFile(documentPath: string): Promise<void> {
  const from = docStore.documentPath;
  if (!from || from === documentPath) return;
  await showDocument(documentPath, [...docStore.documentTrail, from].slice(-MAX_TRAIL));
}

/** The document Back returns to, or null at the start of the trail. */
export function previousDocumentPath(): string | null {
  const trail = docStore.documentTrail;
  return trail.length > 0 ? trail[trail.length - 1] : null;
}

/** Returns to the document left last; nothing happens at the start of the trail. */
export async function goBackDocument(): Promise<void> {
  const previous = previousDocumentPath();
  if (previous === null) return;
  await showDocument(previous, docStore.documentTrail.slice(0, -1));
}

/**
 * Switches the workspace to a file of the open project. The selection belongs
 * to the old document and goes; runs and annotations are per project and stay.
 */
async function showDocument(documentPath: string, documentTrail: string[]): Promise<void> {
  const project = activeProject();
  if (!project) return;
  commitEditsOnLeave();
  stopCurrentWatcher();
  setDocStore({
    documentPath,
    documentTrail,
    selection: null,
    reviewRunId: null,
    composerDraft: recoveredNoteDraft(project.path, documentPath),
    snapshot: null,
    error: null,
  });
  startWatcher(project.id, project.path, documentPath);
  await refreshDocumentSnapshot();
}

/**
 * Versions happen on their own: leaving a document records its uncommitted
 * tracked edits. Silent on success and never blocks the caller; the editor is
 * flushed synchronously first because leaving unmounts it.
 */
function commitEditsOnLeave(): void {
  const projectId = docStore.projectId;
  const projectRoot = activeProject()?.path ?? openProjectRoot;
  if (!projectId || !projectRoot || !docStore.documentPath) return;
  const flushed = flushMarkdownEditor();
  void (async () => {
    try {
      if (!(await flushed)) {
        showNotification('Could not save your edits; your draft is kept.');
        return;
      }
      // A no-op when nothing is dirty, so there is no check that could go
      // stale while the next document loads.
      await invoke(IPC.CommitDocumentEdits, { projectRoot });
      if (stillOpen(projectId)) void refreshDocumentSnapshot();
    } catch (err) {
      showNotification(errMessage(err));
    }
  })();
}

export function closeDocumentWorkspace(): void {
  commitEditsOnLeave();
  stopCurrentWatcher();
  setDocStore({
    projectId: null,
    documentPath: null,
    documentTrail: [],
    selection: null,
    view: 'document',
    compareRunId: null,
    compareCandidateId: null,
    reviewRunId: null,
    composerDraft: null,
  });
  setStore('activeDocumentProjectId', null);
}

// Like Markdown drafts, notes survive navigation and failed writes. The memory
// copy also preserves them for this session when browser storage is unavailable.
const noteDraftBackups = new Map<string, ComposerDraft>();
const noteDraftKey = (root: string, path: string) =>
  `document-note-draft:${JSON.stringify([root, path])}`;

function recoveredNoteDraft(root: string, path: string): ComposerDraft | null {
  const key = noteDraftKey(root, path);
  let draft = noteDraftBackups.get(key);
  if (!draft) {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (
        value &&
        typeof value === 'object' &&
        'id' in value &&
        typeof value.id === 'string' &&
        'text' in value &&
        typeof value.text === 'string'
      )
        draft = { id: value.id, text: value.text, mode: 'note' };
    } catch {
      /* The in-memory draft remains available without browser storage. */
    }
  }
  return draft
    ? {
        ...draft,
        noteSaveStatus: draft.id && pendingNoteSaves.has(draft.id) ? 'saving' : undefined,
      }
    : null;
}

function backupNoteDraft(root: string, path: string, draft: ComposerDraft | null): void {
  const key = noteDraftKey(root, path);
  if (draft) noteDraftBackups.set(key, { id: draft.id, text: draft.text, mode: 'note' });
  else noteDraftBackups.delete(key);
  try {
    if (draft) localStorage.setItem(key, JSON.stringify({ id: draft.id, text: draft.text }));
    else localStorage.removeItem(key);
  } catch {
    /* Preserve the in-memory backup for this session. */
  }
}

interface FailedNote {
  draft: ComposerDraft;
  selection: DocumentSelection | null;
}
// Comments whose save failed while another was being written. Each comes back,
// oldest first, in place of a next empty comment.
// shortcut: kept for the session only — persist like noteDraftBackups if a
// restart between the failure and the next comment matters.
const failedNotes = new Map<string, FailedNote[]>();

function takeFailedNote(root: string, path: string): FailedNote | undefined {
  return failedNotes.get(noteDraftKey(root, path))?.shift();
}

export function setDocumentComposerDraft(draft: ComposerDraft | null): void {
  const project = activeProject();
  const path = docStore.documentPath;
  const opensEmpty =
    !!project && !!path && draft?.mode === 'note' && !draft.text && !docStore.composerDraft;
  // A comment still saving has just been put away; it is not a draft to resume.
  const backup = opensEmpty && project && path ? recoveredNoteDraft(project.path, path) : null;
  if (backup && backup.noteSaveStatus !== 'saving') draft = backup;
  else if (opensEmpty && project && path) {
    const failed = takeFailedNote(project.path, path);
    if (failed) {
      draft = { ...failed.draft, noteSaveStatus: 'error' };
      // Back on the passage it was written about, so Retry saves it there.
      if (failed.selection) setDocStore('selection', failed.selection);
    }
  }
  // A save status belongs to the comment; another mode starts without one.
  if (draft)
    draft = {
      ...draft,
      id: draft.id ?? crypto.randomUUID(),
      noteSaveStatus: draft.mode === 'note' ? draft.noteSaveStatus : undefined,
    };
  if (project && path && draft?.mode === 'note')
    backupNoteDraft(project.path, path, draft.text.trim() ? draft : null);
  // An unsaved comment, or one whose save failed, switched to Rewrite or Ask
  // takes its text along; its backup would otherwise return later as a
  // comment on another passage.
  const previous = docStore.composerDraft;
  if (
    project &&
    path &&
    draft &&
    draft.mode !== 'note' &&
    previous?.mode === 'note' &&
    previous.noteSaveStatus !== 'saving'
  )
    backupNoteDraft(project.path, path, null);
  // The store merges an object into the previous draft, so keys a new draft
  // leaves out are set explicitly to clear the old ones.
  setDocStore(
    'composerDraft',
    draft
      ? { ...draft, annotationId: draft.annotationId, noteSaveStatus: draft.noteSaveStatus }
      : null,
  );
}

const pendingNoteSaves = new Map<string, Promise<boolean>>();

/**
 * A comment put away while saving has failed. The empty comment that took its
 * place gives way to it, back on its passage and with Retry. A comment already
 * being written keeps its own text, and the failed one waits for the next.
 */
function keepFailedNote(
  project: { id: string; path: string },
  path: string,
  failed: { draft: ComposerDraft; selection: DocumentSelection | null },
) {
  const open = docStore.composerDraft;
  const here = stillOpen(project.id) && docStore.documentPath === path;
  if (here && open?.mode === 'note' && !open.text.trim()) {
    setDocStore({
      composerDraft: {
        ...open,
        id: failed.draft.id,
        text: failed.draft.text,
        noteSaveStatus: 'error',
      },
      selection: failed.selection,
    });
    backupNoteDraft(project.path, path, failed.draft);
  } else if (recoveredNoteDraft(project.path, path)?.id !== failed.draft.id) {
    // Its own backup, still in place, already brings it back.
    const key = noteDraftKey(project.path, path);
    failedNotes.set(key, [...(failedNotes.get(key) ?? []), failed]);
  }
}

/** Save on leaving a note. Shared by composer instances so remounting cannot duplicate it. */
export function saveDocumentNoteDraft(anchor: DocumentAnchor): Promise<boolean> {
  const draft = docStore.composerDraft;
  if (!draft?.id || draft.mode !== 'note' || !draft.text.trim()) return Promise.resolve(false);
  const pending = pendingNoteSaves.get(draft.id);
  if (pending) return pending;
  const { project, documentPath } = requireProject();
  const id = draft.id;
  const text = draft.text;
  const selection = docStore.selection;
  const isCurrent = () =>
    stillOpen(project.id) &&
    docStore.documentPath === documentPath &&
    docStore.composerDraft?.id === id;
  setDocStore('composerDraft', 'noteSaveStatus', 'saving');
  const save = (async () => {
    try {
      const now = new Date().toISOString();
      const saved = await invoke<DocumentAnnotation>(IPC.SaveDocumentAnnotation, {
        projectRoot: project.path,
        annotation: {
          id,
          kind: 'note',
          anchor,
          text: text.trim(),
          createdAt: now,
          updatedAt: now,
          resolved: false,
        },
      });
      if (stillOpen(project.id)) putAnnotation(saved);
      const backup = recoveredNoteDraft(project.path, documentPath);
      if (backup?.id === id && backup.text === text)
        backupNoteDraft(project.path, documentPath, null);
      if (isCurrent()) {
        if (docStore.composerDraft?.mode === 'note' && docStore.composerDraft.text === text)
          setDocStore({ composerDraft: null, selection: null });
        else setDocStore('composerDraft', 'noteSaveStatus', undefined);
      }
      return true;
    } catch (err) {
      if (isCurrent()) setDocStore('composerDraft', 'noteSaveStatus', 'error');
      else keepFailedNote(project, documentPath, { draft: { id, text, mode: 'note' }, selection });
      showNotification(errMessage(err));
      return false;
    } finally {
      pendingNoteSaves.delete(id);
    }
  })();
  pendingNoteSaves.set(id, save);
  return save;
}

export function setDocumentView(view: DocumentView): void {
  afterSavingMarkdown(() => setDocStore('view', view));
}

export function setDocumentSelection(selection: DocumentSelection | null): void {
  setDocStore('selection', selection);
}

/**
 * Starts a review. One proposal is reviewed in the document itself; several
 * need the compare view, a modal over whatever tab is up.
 */
export function openDocumentCompare(runId: string, candidateId?: string): void {
  const run = reviewableRuns().find((r) => r.id === runId);
  const proposals = run?.candidates.filter((c) => c.commitSha) ?? [];
  const snapshot = docStore.snapshot;
  // The inline view diffs against the run's base; only a clean, current base
  // makes that what the reader sees as their document.
  const inline =
    run?.documentPath === docStore.documentPath &&
    !!snapshot &&
    !snapshot.dirty &&
    snapshot.headSha === run.baseSha &&
    proposals.length === 1 &&
    (!candidateId || candidateId === proposals[0].id);
  if (inline) {
    afterSavingMarkdown(() =>
      setDocStore({
        reviewRunId: runId,
        compareRunId: null,
        compareCandidateId: null,
        view: 'document',
      }),
    );
  } else openDocumentCompareModal(runId, candidateId);
}

/** The compare view itself, whatever the number of proposals. */
export function openDocumentCompareModal(runId: string, candidateId?: string): void {
  afterSavingMarkdown(() =>
    setDocStore({
      compareRunId: runId,
      compareCandidateId: candidateId ?? null,
      reviewRunId: null,
    }),
  );
}

export function closeDocumentCompare(): void {
  setDocStore({ compareRunId: null, compareCandidateId: null });
}

/** The run and proposal under inline review, while that review is open. */
export function inlineReview():
  | { run: DocumentRunRecord; candidate: DocumentCandidateRecord }
  | undefined {
  const run = reviewableRuns().find((r) => r.id === docStore.reviewRunId);
  const proposals = run?.candidates.filter((c) => c.commitSha) ?? [];
  if (!run || run.documentPath !== docStore.documentPath || proposals.length !== 1) return;
  return { run, candidate: proposals[0] };
}

/** Leaves the inline review without deciding; false when none was open. */
export function closeDocumentReview(): boolean {
  const open = inlineReview() !== undefined;
  if (docStore.reviewRunId) setDocStore('reviewRunId', null);
  return open;
}

/** Runs with at least one proposal to look at. */
export function reviewableRuns(): DocumentRunRecord[] {
  return docStore.runOrder
    .map((id) => docStore.runs[id])
    .filter(
      (r) =>
        (r.status === 'finished' || r.status === 'stale') && r.candidates.some((c) => c.commitSha),
    );
}

export function candidateLogKey(runId: string, candidateId: string): string {
  return `${runId}/${candidateId}`;
}

/** Agent that owns the main session; falls back to the first resumable one installed. */
export function documentMainAgentId(project: Project | undefined): string {
  if (project?.documentMainAgentId) return project.documentMainAgentId;
  const installed = store.availableAgents.filter((a) => a.available !== false);
  const preferred = installed.find((a) => a.id === DEFAULT_DOCUMENT_MAIN_AGENT);
  if (preferred) return preferred.id;
  return (
    installed.find((a) => documentAgentSupport(a.id).resume)?.id ?? DEFAULT_DOCUMENT_MAIN_AGENT
  );
}

export function setDocumentMainAgent(agentId: string): void {
  const project = activeProject();
  if (project) updateProject(project.id, { documentMainAgentId: agentId });
}

export interface DispatchSelection {
  agent: AgentDef;
  count: number;
  /** Model and reasoning level per candidate of this agent, in order; the
   *  CLI's defaults where a slot is missing or empty. */
  choices?: readonly DocumentModelChoice[];
}

/** "opus · high": how a candidate's model and reasoning level read in the UI. */
export function modelLabel(choice: DocumentModelChoice): string {
  return [choice.model, choice.effort].filter(Boolean).join(' · ');
}

/** The remembered choices for an agent's candidates, first slot first. */
export function documentModelChoices(
  project: Project | undefined,
  agentId: string,
): DocumentModelChoice[] {
  const stored: unknown = project?.documentModels?.[agentId];
  // State saved while the choice was per agent holds one object here.
  return Array.isArray(stored) ? stored : [];
}

/** `list` with slot `index` set to `choice`: dense, and without trailing empty slots. */
export function withModelChoice(
  list: readonly DocumentModelChoice[],
  index: number,
  choice: DocumentModelChoice,
): DocumentModelChoice[] {
  const next = Array.from({ length: Math.max(list.length, index + 1) }, (_, i) => list[i] ?? {});
  next[index] = choice;
  while (next.length > 0 && !next[next.length - 1].model && !next[next.length - 1].effort) {
    next.pop();
  }
  return next;
}

/** Remember the composer's choice for one candidate slot, so the next run starts from it. */
export function setDocumentModelChoice(
  agentId: string,
  index: number,
  choice: DocumentModelChoice,
): void {
  const project = activeProject();
  if (!project) return;
  const list = withModelChoice(documentModelChoices(project, agentId), index, choice);
  const rest = Object.fromEntries(
    Object.entries(project.documentModels ?? {}).filter(([id]) => id !== agentId),
  );
  updateProject(project.id, {
    documentModels: list.length > 0 ? { ...rest, [agentId]: list } : rest,
  });
}

function buildScope(selection: DocumentSelection, documentPath: string): DocumentScope {
  return {
    path: documentPath,
    wholeDocument: selection.wholeDocument,
    startLine: selection.startLine,
    endLine: selection.endLine,
    quote: selection.quote,
    heading: selection.heading,
  };
}

function candidateLabel(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

/** Turns the composer's choices into candidate specs: one main, the rest alternates. */
export function buildCandidateSpecs(
  project: Project,
  picks: readonly DispatchSelection[],
  envFiles: Record<string, string>,
): DocumentCandidateSpec[] {
  const mainAgentId = documentMainAgentId(project);
  const specs: DocumentCandidateSpec[] = [];
  let index = 0;
  for (const pick of picks) {
    const support = documentAgentSupport(pick.agent.id);
    if (!support.headless) continue;
    for (let i = 0; i < pick.count; i++) {
      if (specs.length >= MAX_DOCUMENT_CANDIDATES) break;
      const isMain = pick.agent.id === mainAgentId && i === 0 && support.resume;
      const session = isMain ? project.documentSessions?.[pick.agent.id] : undefined;
      const choice = pick.choices?.[i];
      specs.push({
        id: `c${index + 1}`,
        label: candidateLabel(index),
        agentId: pick.agent.id,
        agentName: pick.agent.name,
        command: pick.agent.command,
        isMain,
        model: choice?.model,
        effort: choice?.effort,
        sessionId: session?.sessionId,
        sessionLastSha: session?.lastSha,
        envFile: envFiles[pick.agent.id],
      });
      index++;
    }
  }
  return specs;
}

export async function dispatchDocumentRun(
  instruction: string,
  picks: readonly DispatchSelection[],
  selection: DocumentSelection,
): Promise<DocumentRunRecord | null> {
  const { project, documentPath } = requireProject();
  if (
    !(await flushMarkdownEditor()) ||
    !stillOpen(project.id) ||
    docStore.documentPath !== documentPath
  )
    return null;
  const candidates = buildCandidateSpecs(project, picks, store.agentEnvFiles);
  if (candidates.length === 0) throw new Error('Pick at least one agent with a headless mode.');
  setDocStore('dispatching', true);
  try {
    const run = await invoke<DocumentRunRecord>(IPC.DispatchDocumentRun, {
      projectRoot: project.path,
      documentPath,
      instruction,
      scope: buildScope(selection, documentPath),
      candidates,
    });
    upsertRun(run);
    const draft = docStore.composerDraft;
    setDocStore({ selection: null, composerDraft: null });
    if (draft?.annotationId) void linkAnnotationToRun(draft.annotationId, run.id);
    void refreshDocumentSnapshot();
    return run;
  } finally {
    setDocStore('dispatching', false);
  }
}

function upsertRun(run: DocumentRunRecord): void {
  setDocStore(
    produce((s) => {
      s.runs[run.id] = run;
      s.runOrder = sortRunIds(s.runs);
    }),
  );
}

/** Remember the main session so the next dispatch resumes it. The event names
 *  the project root because the run may finish after its workspace was closed
 *  or another project was opened. */
function recordMainSession(
  projectRoot: string,
  run: DocumentRunRecord,
  candidate: DocumentCandidateRecord,
): void {
  if (!candidate.isMain || !candidate.sessionId) return;
  const project = store.projects.find((p) => p.path === projectRoot && p.kind === 'document');
  if (!project) return;
  updateProject(project.id, {
    documentSessions: {
      ...(project.documentSessions ?? {}),
      [candidate.agentId]: { sessionId: candidate.sessionId, lastSha: run.baseSha },
    },
  });
}

export function applyDocumentRunEvent(event: DocumentRunEvent): void {
  const forOpenProject = activeProject()?.path === event.projectRoot;
  switch (event.type) {
    case 'log':
      if (!forOpenProject) return;
      setDocStore(
        produce((s) => {
          const key = candidateLogKey(event.runId, event.candidateId);
          const lines = s.logs[key] ?? [];
          lines.push(event.text);
          if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
          s.logs[key] = lines;
        }),
      );
      return;
    case 'candidate': {
      const run = docStore.runs[event.runId];
      if (run) recordMainSession(event.projectRoot, run, event.candidate);
      if (!forOpenProject || !run) return;
      setDocStore(
        produce((s) => {
          const target = s.runs[event.runId];
          const idx = target.candidates.findIndex((c) => c.id === event.candidate.id);
          if (idx >= 0) target.candidates[idx] = event.candidate;
          else target.candidates.push(event.candidate);
        }),
      );
      return;
    }
    case 'run': {
      if (event.run.status === 'finished') {
        for (const c of event.run.candidates) recordMainSession(event.projectRoot, event.run, c);
      }
      if (!forOpenProject) return;
      upsertRun(event.run);
      if (event.run.status === 'finished') {
        setDocStore(
          produce((s) => {
            s.logs = Object.fromEntries(
              Object.entries(s.logs).filter(([key]) => !key.startsWith(`${event.run.id}/`)),
            );
          }),
        );
        const proposals = event.run.candidates.filter((c) => c.commitSha).length;
        showNotification(
          proposals > 0
            ? `${proposals} proposal${proposals === 1 ? '' : 's'} ready to compare`
            : 'Run finished without changes',
        );
      }
      return;
    }
  }
}

/** `partial` carries the composed document when the reader declined some changes. */
export async function acceptDocumentCandidate(
  runId: string,
  candidateId: string,
  partial?: { content: string; accepted: number; total: number },
): Promise<void> {
  const { project } = requireProject();
  if (!(await flushMarkdownEditor()) || !stillOpen(project.id)) return;
  try {
    await invoke<{ sha: string }>(IPC.AcceptDocumentCandidate, {
      projectRoot: project.path,
      runId,
      candidateId,
      partial,
    });
    showNotification(
      partial ? `Accepted ${partial.accepted} of ${partial.total} changes` : 'Proposal accepted',
    );
    setDocStore({ compareRunId: null, compareCandidateId: null, reviewRunId: null });
  } catch (err) {
    showNotification(errMessage(err));
  }
  await Promise.all([loadDocumentRuns(), refreshDocumentSnapshot()]);
}

/**
 * One throwaway candidate for a run that starts from proposals rather than
 * the canonical document: the warm main session must not be moved onto
 * unaccepted content, so it is never resumed here.
 */
function oneShotSpecs(
  project: Project,
  agent: AgentDef,
  choice: DocumentModelChoice,
): DocumentCandidateSpec[] {
  return buildCandidateSpecs(
    project,
    [{ agent, count: 1, choices: [choice] }],
    store.agentEnvFiles,
  ).map((spec) => ({ ...spec, isMain: false, sessionId: undefined, sessionLastSha: undefined }));
}

export async function refineDocumentCandidate(
  run: DocumentRunRecord,
  candidate: DocumentCandidateRecord,
  instruction: string,
): Promise<void> {
  const { project } = requireProject();
  const agent = store.availableAgents.find(
    (a) => a.id === candidate.agentId && a.available !== false,
  );
  if (!agent) throw new Error('Install or enable this candidate’s agent to refine it.');
  const revision = await invoke<DocumentRunRecord>(IPC.DispatchDocumentRun, {
    projectRoot: project.path,
    documentPath: run.documentPath,
    instruction,
    scope: { wholeDocument: true },
    candidates: oneShotSpecs(project, agent, { model: candidate.model, effort: candidate.effort }),
    refinement: { runId: run.id, candidateId: candidate.id },
  });
  if (stillOpen(project.id)) upsertRun(revision);
  showNotification('Refinement started. The new proposal will appear in Runs.');
}

export interface MergeRequest {
  run: DocumentRunRecord;
  candidateIds: readonly string[];
  /** Guidance for the merging agent, on top of the built-in merge instructions. */
  instruction: string;
  agent: AgentDef;
  choice: DocumentModelChoice;
}

/** Asks one agent to fold several proposals of `run` into a single new proposal. */
export async function mergeDocumentCandidates(request: MergeRequest): Promise<void> {
  const { project } = requireProject();
  const { run, candidateIds, instruction, agent, choice } = request;
  const merged = await invoke<DocumentRunRecord>(IPC.DispatchDocumentRun, {
    projectRoot: project.path,
    documentPath: run.documentPath,
    instruction,
    scope: { wholeDocument: true },
    candidates: oneShotSpecs(project, agent, choice),
    merge: { runId: run.id, candidateIds: [...candidateIds] },
  });
  if (stillOpen(project.id)) upsertRun(merged);
  showNotification('Merge started. The merged proposal will appear in Runs.');
}

export async function rejectDocumentRun(runId: string): Promise<void> {
  const { project } = requireProject();
  try {
    const run = await invoke<DocumentRunRecord>(IPC.RejectDocumentRun, {
      projectRoot: project.path,
      runId,
    });
    upsertRun(run);
    if (docStore.compareRunId === runId)
      setDocStore({ compareRunId: null, compareCandidateId: null });
    if (docStore.reviewRunId === runId) setDocStore('reviewRunId', null);
  } catch (err) {
    showNotification(errMessage(err));
  }
  void refreshDocumentSnapshot();
}

export async function cancelDocumentRun(runId: string): Promise<void> {
  await invoke(IPC.CancelDocumentRun, { runId }).catch((err) => showNotification(errMessage(err)));
}

export async function setDocumentCandidateNote(
  runId: string,
  candidateId: string,
  note: string,
): Promise<void> {
  const { project } = requireProject();
  try {
    const run = await invoke<DocumentRunRecord>(IPC.SetDocumentCandidateNote, {
      projectRoot: project.path,
      runId,
      candidateId,
      note,
    });
    upsertRun(run);
  } catch (err) {
    showNotification(errMessage(err));
  }
}

export async function revertDocumentCommit(sha: string): Promise<boolean> {
  const { project } = requireProject();
  if (!(await flushMarkdownEditor()) || !stillOpen(project.id)) return false;
  try {
    await invoke(IPC.RevertDocumentCommit, { projectRoot: project.path, sha });
    showNotification('Reverted');
    void refreshDocumentSnapshot();
    return true;
  } catch (err) {
    showNotification(errMessage(err));
    return false;
  }
}

/** Drops the uncommitted edits to tracked files; the document goes back to HEAD. */
export async function discardDocumentEdits(): Promise<boolean> {
  const { project } = requireProject();
  if (!(await flushMarkdownEditor()) || !stillOpen(project.id)) return false;
  try {
    await invoke(IPC.DiscardDocumentEdits, { projectRoot: project.path });
    showNotification('Restored the last saved version');
    void refreshDocumentSnapshot();
    return true;
  } catch (err) {
    showNotification(errMessage(err));
    return false;
  }
}

/** Saves tracked content edits immediately instead of waiting for the next run. */
export async function commitDocumentEdits(): Promise<boolean> {
  const { project } = requireProject();
  if (!(await flushMarkdownEditor()) || !stillOpen(project.id)) return false;
  try {
    await invoke(IPC.CommitDocumentEdits, { projectRoot: project.path });
    showNotification('Version saved');
    void refreshDocumentSnapshot();
    return true;
  } catch (err) {
    showNotification(errMessage(err));
    return false;
  }
}

// --- Annotations ----------------------------------------------------------

export async function loadDocumentAnnotations(): Promise<void> {
  const project = activeProject();
  if (!project) return;
  try {
    const annotations = await invoke<DocumentAnnotation[]>(IPC.ListDocumentAnnotations, {
      projectRoot: project.path,
    });
    if (stillOpen(project.id)) setDocStore('annotations', annotations);
  } catch (err) {
    if (stillOpen(project.id)) setDocStore('error', errMessage(err));
  }
}

function putAnnotation(annotation: DocumentAnnotation): void {
  setDocStore(
    produce((s) => {
      const idx = s.annotations.findIndex((a) => a.id === annotation.id);
      if (idx >= 0) s.annotations[idx] = annotation;
      else s.annotations.push(annotation);
    }),
  );
}

async function persistAnnotation(annotation: DocumentAnnotation): Promise<DocumentAnnotation> {
  const { project } = requireProject();
  const saved = await invoke<DocumentAnnotation>(IPC.SaveDocumentAnnotation, {
    projectRoot: project.path,
    annotation,
  });
  putAnnotation(saved);
  return saved;
}

export interface AddAnnotationOptions {
  /** Agent that answers a question right away; a question without one waits. */
  askWith?: AgentDef;
  /** Answered question this one continues; its exchange goes into the prompt. */
  followUpOf?: string;
}

/** Creates a note or a question on the anchored passage. Questions are asked right away. */
export async function addDocumentAnnotation(
  kind: DocumentAnnotationKind,
  text: string,
  anchor: DocumentAnchor,
  options: AddAnnotationOptions = {},
): Promise<DocumentAnnotation | null> {
  const now = new Date().toISOString();
  try {
    const saved = await persistAnnotation({
      id: crypto.randomUUID(),
      kind,
      anchor,
      text,
      createdAt: now,
      updatedAt: now,
      resolved: false,
      followUpOf: options.followUpOf,
    });
    if (kind === 'question' && options.askWith)
      await askDocumentAnnotation(saved.id, options.askWith);
    return saved;
  } catch (err) {
    showNotification(errMessage(err));
    return null;
  }
}

/** Continues an answered question on the same passage; the agent sees the earlier exchange. */
export async function askFollowUpQuestion(
  parent: DocumentAnnotation,
  text: string,
  agent: AgentDef,
): Promise<DocumentAnnotation | null> {
  return addDocumentAnnotation('question', text, parent.anchor, {
    askWith: agent,
    followUpOf: parent.id,
  });
}

export async function askDocumentAnnotation(annotationId: string, agent: AgentDef): Promise<void> {
  const { project } = requireProject();
  const current = docStore.annotations.find((a) => a.id === annotationId);
  try {
    const pending = await invoke<DocumentAnnotation>(IPC.AskDocumentAnnotation, {
      projectRoot: project.path,
      // The question is about the passage's own document, whichever is on screen now.
      documentPath: current?.anchor.path ?? docStore.documentPath,
      annotationId,
      agentId: agent.id,
      agentName: agent.name,
      command: agent.command,
      envFile: store.agentEnvFiles[agent.id],
    });
    putAnnotation(pending);
  } catch (err) {
    showNotification(errMessage(err));
  }
}

export async function setDocumentAnnotationResolved(id: string, resolved: boolean): Promise<void> {
  const current = docStore.annotations.find((a) => a.id === id);
  if (!current) return;
  try {
    await persistAnnotation({ ...current, resolved });
  } catch (err) {
    showNotification(errMessage(err));
  }
}

export async function updateDocumentAnnotationText(id: string, text: string): Promise<boolean> {
  const current = docStore.annotations.find((a) => a.id === id);
  if (!current) return false;
  if (current.text === text) return true;
  try {
    await persistAnnotation({ ...current, text });
    return true;
  } catch (err) {
    showNotification(errMessage(err));
    return false;
  }
}

/** One click removes a bubble; Undo brings back the recent ones, newest first. */
export async function deleteDocumentAnnotation(id: string): Promise<void> {
  const { project } = requireProject();
  const current = docStore.annotations.find((a) => a.id === id);
  if (!current) return;
  setDocStore(
    produce((s) => {
      s.annotations = s.annotations.filter((a) => a.id !== id);
      s.recentlyDeleted = [...s.recentlyDeleted, current];
    }),
  );
  try {
    await invoke(IPC.DeleteDocumentAnnotation, { projectRoot: project.path, id });
  } catch (err) {
    showNotification(errMessage(err));
    putAnnotation(current);
    setDocStore('recentlyDeleted', (list) => list.filter((a) => a.id !== id));
  }
}

export async function undoDeleteDocumentAnnotation(): Promise<void> {
  const last = docStore.recentlyDeleted.at(-1);
  if (!last) return;
  setDocStore('recentlyDeleted', (list) => list.slice(0, -1));
  try {
    await persistAnnotation(last);
  } catch (err) {
    showNotification(errMessage(err));
  }
}

export function dismissUndo(): void {
  setDocStore('recentlyDeleted', []);
}

export function setShowResolvedAnnotations(show: boolean): void {
  setDocStore('showResolved', show);
}

/** Marks a bubble as turned into a run; the bubble collapses but stays. */
export async function linkAnnotationToRun(annotationId: string, runId: string): Promise<void> {
  const current = docStore.annotations.find((a) => a.id === annotationId);
  if (!current) return;
  try {
    await persistAnnotation({ ...current, runId, resolved: true });
  } catch (err) {
    showNotification(errMessage(err));
  }
}

function isAnnotationEvent(v: unknown): v is DocumentAnnotationEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as { projectRoot?: unknown; annotation?: unknown };
  return typeof e.projectRoot === 'string' && !!e.annotation && typeof e.annotation === 'object';
}

interface DocumentChangedPayload {
  key: string;
  snapshot: DocumentSnapshot;
}

function isRunEvent(v: unknown): v is DocumentRunEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as { type?: unknown; projectRoot?: unknown };
  return typeof e.type === 'string' && typeof e.projectRoot === 'string';
}

/** Subscribes to main-process pushes; call once at startup. Returns a disposer. */
export function initDocumentListeners(): () => void {
  const offRun = window.electron.ipcRenderer.on(IPC.DocumentRunEvent, (payload: unknown) => {
    if (isRunEvent(payload)) untrack(() => applyDocumentRunEvent(payload));
  });
  const offAnnotation = window.electron.ipcRenderer.on(
    IPC.DocumentAnnotationEvent,
    (payload: unknown) => {
      if (!isAnnotationEvent(payload)) return;
      untrack(() => {
        if (activeProject()?.path === payload.projectRoot) putAnnotation(payload.annotation);
      });
    },
  );
  const offChanged = window.electron.ipcRenderer.on(IPC.DocumentChanged, (payload: unknown) => {
    const p = payload as DocumentChangedPayload | undefined;
    if (!p) return;
    untrack(() => {
      if (p.key !== currentWatcherKey()) return;
      // Read what is being replaced first: `setStore` merges into the node the
      // old snapshot is a proxy over, so afterwards it reads the new values.
      const previous = docStore.snapshot;
      const hadSnapshot = !!previous;
      const previousContent = previous?.content;
      const previousHeadSha = previous?.headSha;
      setDocStore('snapshot', p.snapshot);
      // The passage under a selection may be gone after an external edit, and a
      // commit or pull may have brought annotations along.
      if (hadSnapshot && previousContent !== p.snapshot.content) setDocStore('selection', null);
      if (hadSnapshot && previousHeadSha !== p.snapshot.headSha) void loadDocumentAnnotations();
    });
  });
  const offWarning = window.electron.ipcRenderer.on(IPC.QuickEditWarning, (payload: unknown) => {
    const message = (payload as { message?: unknown } | undefined)?.message;
    if (typeof message === 'string') showNotification(message);
  });
  return () => {
    offRun();
    offAnnotation();
    offChanged();
    offWarning();
  };
}
