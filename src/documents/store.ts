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
import type { Project } from '../store/types';

export type DocumentView = 'document' | 'compare' | 'history';

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

/** What the composer opens with when a bubble is turned into a task. */
export interface ComposerDraft {
  text: string;
  annotationId?: string;
}

interface DocumentWorkspaceState {
  projectId: string | null;
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

function requireProject(): Project & { documentPath: string } {
  const project = activeProject();
  if (!project || !project.documentPath) throw new Error('No document project is open.');
  return project as Project & { documentPath: string };
}

function watcherKey(projectId: string): string {
  return `doc:${projectId}`;
}

/** True while the workspace still shows the project a request was made for. */
function stillOpen(projectId: string): boolean {
  return docStore.projectId === projectId;
}

export async function refreshDocumentSnapshot(): Promise<void> {
  const project = activeProject();
  if (!project?.documentPath) return;
  try {
    const snapshot = await invoke<DocumentSnapshot>(IPC.ReadDocument, {
      projectRoot: project.path,
      documentPath: project.documentPath,
    });
    if (stillOpen(project.id)) setDocStore({ snapshot, error: null });
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

export async function openDocumentWorkspace(projectId: string): Promise<void> {
  const project = getProject(projectId);
  if (!project?.documentPath) return;
  const previous = docStore.projectId;
  if (previous && previous !== projectId) {
    void invoke(IPC.StopDocumentWatcher, { key: watcherKey(previous) }).catch(() => undefined);
  }
  setDocStore({
    projectId,
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
  void invoke(IPC.StartDocumentWatcher, {
    key: watcherKey(projectId),
    projectRoot: project.path,
    documentPath: project.documentPath,
  }).catch((err) => {
    untrack(() => {
      if (stillOpen(projectId)) setDocStore('error', errMessage(err));
    });
  });
  await Promise.all([refreshDocumentSnapshot(), loadDocumentRuns(), loadDocumentAnnotations()]);
  if (stillOpen(projectId)) setDocStore('loading', false);
}

export function closeDocumentWorkspace(): void {
  const projectId = docStore.projectId;
  if (projectId) {
    void invoke(IPC.StopDocumentWatcher, { key: watcherKey(projectId) }).catch(() => undefined);
  }
  setDocStore({
    projectId: null,
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

export function openDocumentCompare(runId: string): void {
  setDocStore({ compareRunId: runId, view: 'compare' });
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
      specs.push({
        id: `c${index + 1}`,
        label: candidateLabel(index),
        agentId: pick.agent.id,
        agentName: pick.agent.name,
        command: pick.agent.command,
        isMain,
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
): Promise<DocumentRunRecord | null> {
  const project = requireProject();
  const selection = docStore.selection;
  if (!selection) throw new Error('Select a passage first.');
  const candidates = buildCandidateSpecs(project, picks, store.agentEnvFiles);
  if (candidates.length === 0) throw new Error('Pick at least one agent with a headless mode.');
  setDocStore('dispatching', true);
  try {
    const run = await invoke<DocumentRunRecord>(IPC.DispatchDocumentRun, {
      projectRoot: project.path,
      documentPath: project.documentPath,
      instruction,
      scope: buildScope(selection, project.documentPath),
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

export async function acceptDocumentCandidate(runId: string, candidateId: string): Promise<void> {
  const project = requireProject();
  try {
    await invoke<{ sha: string }>(IPC.AcceptDocumentCandidate, {
      projectRoot: project.path,
      runId,
      candidateId,
    });
    showNotification('Proposal accepted');
    setDocStore({ view: 'document', compareRunId: null });
  } catch (err) {
    showNotification(errMessage(err));
  }
  await Promise.all([loadDocumentRuns(), refreshDocumentSnapshot()]);
}

export async function rejectDocumentRun(runId: string): Promise<void> {
  const project = requireProject();
  try {
    const run = await invoke<DocumentRunRecord>(IPC.RejectDocumentRun, {
      projectRoot: project.path,
      runId,
    });
    upsertRun(run);
    if (docStore.compareRunId === runId) setDocStore({ view: 'document', compareRunId: null });
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
  const project = requireProject();
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
  const project = requireProject();
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
  const project = requireProject();
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
  const project = requireProject();
  try {
    const pending = await invoke<DocumentAnnotation>(IPC.AskDocumentAnnotation, {
      projectRoot: project.path,
      documentPath: project.documentPath,
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
  const project = requireProject();
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
      if (!docStore.projectId || p.key !== watcherKey(docStore.projectId)) return;
      const previous = docStore.snapshot;
      setDocStore('snapshot', p.snapshot);
      // The passage under a selection may be gone after an external edit, and a
      // commit or pull may have brought annotations along.
      if (previous && previous.content !== p.snapshot.content) setDocStore('selection', null);
      if (previous && previous.headSha !== p.snapshot.headSha) void loadDocumentAnnotations();
    });
  });
  return () => {
    offRun();
    offAnnotation();
    offChanged();
  };
}
