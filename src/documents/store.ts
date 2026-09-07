/**
 * Document workspace state: the rendered canonical document, the runs made
 * against it, and the comparison/history views. Kept apart from the task
 * store because none of it is a task: proposals live in Git, not in panels.
 */
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
} from './types';
import {
  DEFAULT_DOCUMENT_MAIN_AGENT,
  MAX_DOCUMENT_CANDIDATES,
  documentAgentSupport,
} from '../../electron/documents/shared';
import { store, setStore } from '../store/core';
import { getProject, updateProject } from '../store/projects';
import { showNotification } from '../store/notification';
import type { DocumentModelChoice, Project } from '../store/types';

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
  text: string;
  annotationId?: string;
  /** Opens the composer on this mode. */
  mode?: ComposerMode;
}

interface DocumentWorkspaceState {
  projectId: string | null;
  /** Repo-relative path of the document on screen; the project's document
   *  until a link or the file tree opens another. */
  documentPath: string | null;
  annotations: DocumentAnnotation[];
  /** Last deleted bubble, kept for a single-step undo. */
  lastDeleted: DocumentAnnotation | null;
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
  selection: DocumentSelection | null;
  dispatching: boolean;
}

const MAX_LOG_LINES = 400;

const [docStore, setDocStore] = createStore<DocumentWorkspaceState>({
  projectId: null,
  documentPath: null,
  annotations: [],
  lastDeleted: null,
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
  selection: null,
  dispatching: false,
});

export { docStore as documentStore };

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
    if (stillOpen(project.id) && docStore.documentPath === documentPath)
      setDocStore({ snapshot, error: null });
  } catch (err) {
    if (stillOpen(project.id)) setDocStore('error', errMessage(err));
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

export async function openDocumentWorkspace(projectId: string): Promise<void> {
  const project = getProject(projectId);
  if (!project?.documentPath || !store.documentWorkspacesEnabled) return;
  if (docStore.projectId && docStore.projectId !== projectId) stopCurrentWatcher();
  setDocStore({
    projectId,
    documentPath: project.documentPath,
    snapshot: null,
    loading: true,
    error: null,
    runs: {},
    runOrder: [],
    logs: {},
    view: 'document',
    compareRunId: null,
    selection: null,
    annotations: [],
    lastDeleted: null,
    composerDraft: null,
  });
  setStore('activeDocumentProjectId', projectId);
  // Start watching before the first await so a quick close can stop it.
  startWatcher(projectId, project.path, project.documentPath);
  await Promise.all([refreshDocumentSnapshot(), loadDocumentRuns(), loadDocumentAnnotations()]);
  if (stillOpen(projectId)) setDocStore('loading', false);
}

/**
 * Shows another file of the open project: the target of an internal link or a
 * pick in the file tree. The selection belongs to the old document and goes;
 * runs and annotations are per project and stay.
 */
export async function openDocumentFile(documentPath: string): Promise<void> {
  const project = activeProject();
  if (!project || docStore.documentPath === documentPath) return;
  stopCurrentWatcher();
  setDocStore({ documentPath, selection: null, composerDraft: null, snapshot: null, error: null });
  startWatcher(project.id, project.path, documentPath);
  await refreshDocumentSnapshot();
}

export function closeDocumentWorkspace(): void {
  stopCurrentWatcher();
  setDocStore({
    projectId: null,
    documentPath: null,
    selection: null,
    view: 'document',
    compareRunId: null,
    composerDraft: null,
  });
  setStore('activeDocumentProjectId', null);
}

export function setDocumentComposerDraft(draft: ComposerDraft | null): void {
  setDocStore('composerDraft', draft);
}

export function setDocumentView(view: DocumentView): void {
  setDocStore('view', view);
}

export function setDocumentSelection(selection: DocumentSelection | null): void {
  setDocStore('selection', selection);
}

/** Opens the compare view, a modal over whatever tab is up. */
export function openDocumentCompare(runId: string): void {
  setDocStore('compareRunId', runId);
}

export function closeDocumentCompare(): void {
  setDocStore('compareRunId', null);
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
    setDocStore('compareRunId', null);
  } catch (err) {
    showNotification(errMessage(err));
  }
  await Promise.all([loadDocumentRuns(), refreshDocumentSnapshot()]);
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
  const candidates = buildCandidateSpecs(
    project,
    [
      {
        agent,
        count: 1,
        choices: [{ model: candidate.model, effort: candidate.effort }],
      },
    ],
    store.agentEnvFiles,
  ).map((spec) => ({
    ...spec,
    isMain: false,
    sessionId: undefined,
    sessionLastSha: undefined,
  }));
  const revision = await invoke<DocumentRunRecord>(IPC.DispatchDocumentRun, {
    projectRoot: project.path,
    documentPath: run.documentPath,
    instruction,
    scope: { wholeDocument: true },
    candidates,
    refinement: { runId: run.id, candidateId: candidate.id },
  });
  if (stillOpen(project.id)) upsertRun(revision);
  showNotification('Refinement started. The new proposal will appear in Runs.');
}

export async function rejectDocumentRun(runId: string): Promise<void> {
  const { project } = requireProject();
  try {
    const run = await invoke<DocumentRunRecord>(IPC.RejectDocumentRun, {
      projectRoot: project.path,
      runId,
    });
    upsertRun(run);
    if (docStore.compareRunId === runId) setDocStore('compareRunId', null);
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

/** Creates a note or a question on the anchored passage. Questions are asked right away. */
export async function addDocumentAnnotation(
  kind: DocumentAnnotationKind,
  text: string,
  anchor: DocumentAnchor,
  askWith?: AgentDef,
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
    });
    if (kind === 'question' && askWith) await askDocumentAnnotation(saved.id, askWith);
    return saved;
  } catch (err) {
    showNotification(errMessage(err));
    return null;
  }
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

export async function updateDocumentAnnotationText(id: string, text: string): Promise<void> {
  const current = docStore.annotations.find((a) => a.id === id);
  if (!current || current.text === text) return;
  try {
    await persistAnnotation({ ...current, text });
  } catch (err) {
    showNotification(errMessage(err));
  }
}

/** One click removes a bubble; the last one removed can be brought back. */
export async function deleteDocumentAnnotation(id: string): Promise<void> {
  const { project } = requireProject();
  const current = docStore.annotations.find((a) => a.id === id);
  if (!current) return;
  setDocStore(
    produce((s) => {
      s.annotations = s.annotations.filter((a) => a.id !== id);
      s.lastDeleted = current;
    }),
  );
  try {
    await invoke(IPC.DeleteDocumentAnnotation, { projectRoot: project.path, id });
  } catch (err) {
    showNotification(errMessage(err));
    putAnnotation(current);
    setDocStore('lastDeleted', null);
  }
}

export async function undoDeleteDocumentAnnotation(): Promise<void> {
  const last = docStore.lastDeleted;
  if (!last) return;
  setDocStore('lastDeleted', null);
  try {
    await persistAnnotation(last);
  } catch (err) {
    showNotification(errMessage(err));
  }
}

export function dismissUndo(): void {
  setDocStore('lastDeleted', null);
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
  return () => {
    offRun();
    offAnnotation();
    offChanged();
  };
}
