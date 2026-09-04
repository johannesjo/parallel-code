/**
 * Every IPC handler the document workspace owns, in one place. Handlers take
 * the project root from the renderer and validate it; document paths are
 * repo-relative and checked against traversal.
 */
import { ipcMain, type BrowserWindow } from 'electron';
import { IPC } from '../ipc/channels.js';
import {
  assertOptionalBoolean,
  assertOptionalString,
  assertString,
  validatePath,
} from '../ipc/validate.js';
import {
  acceptDocumentCandidate,
  cancelDocumentRun,
  dispatchDocumentRun,
  getDocumentAtCommit,
  getDocumentDiff,
  getDocumentHistory,
  listDocumentRuns,
  readDocumentSnapshot,
  rejectDocumentRun,
  revertDocumentCommit,
  setDocumentCandidateNote,
  startDocumentWatcher,
  stopAllDocumentRuns,
  stopAllDocumentWatchers,
  stopDocumentWatcher,
  validateDocumentPath,
  validateSha,
} from './runs.js';
import { inspectDocumentFolder, prepareDocumentProject } from './setup.js';
import {
  askAnnotation,
  deleteAnnotation,
  readAnnotations,
  saveAnnotation,
  stopAllAsks,
} from './annotations.js';

type IpcArgs = Record<string, unknown>;

function projectRootArg(args: IpcArgs): string {
  validatePath(args.projectRoot, 'projectRoot');
  return args.projectRoot as string;
}

export function registerDocumentHandlers(win: BrowserWindow): void {
  ipcMain.handle(IPC.ReadDocument, (_e, args) => {
    return readDocumentSnapshot(projectRootArg(args), validateDocumentPath(args.documentPath));
  });

  ipcMain.handle(IPC.StartDocumentWatcher, (_e, args) => {
    assertString(args.key, 'key');
    const projectRoot = projectRootArg(args);
    startDocumentWatcher(win, args.key, projectRoot, validateDocumentPath(args.documentPath));
  });

  ipcMain.handle(IPC.StopDocumentWatcher, (_e, args) => {
    assertString(args.key, 'key');
    stopDocumentWatcher(args.key);
  });

  ipcMain.handle(IPC.InspectDocumentFolder, (_e, args) => {
    return inspectDocumentFolder(projectRootArg(args));
  });

  ipcMain.handle(IPC.PrepareDocumentProject, (_e, args) => {
    return prepareDocumentProject(projectRootArg(args), args.documentPath);
  });

  ipcMain.handle(IPC.ListDocumentRuns, (_e, args) => {
    return listDocumentRuns(projectRootArg(args));
  });

  ipcMain.handle(IPC.DispatchDocumentRun, (_e, args) => {
    return dispatchDocumentRun(win, {
      projectRoot: projectRootArg(args),
      documentPath: args.documentPath,
      instruction: args.instruction,
      scope: args.scope,
      candidates: args.candidates,
    });
  });

  ipcMain.handle(IPC.CancelDocumentRun, (_e, args) => {
    cancelDocumentRun(args.runId);
  });

  ipcMain.handle(IPC.AcceptDocumentCandidate, (_e, args) => {
    return acceptDocumentCandidate(projectRootArg(args), args.runId, args.candidateId);
  });

  ipcMain.handle(IPC.RejectDocumentRun, (_e, args) => {
    return rejectDocumentRun(projectRootArg(args), args.runId);
  });

  ipcMain.handle(IPC.SetDocumentCandidateNote, (_e, args) => {
    return setDocumentCandidateNote(projectRootArg(args), args.runId, args.candidateId, args.note);
  });

  ipcMain.handle(IPC.GetDocumentHistory, (_e, args) => {
    const projectRoot = projectRootArg(args);
    assertOptionalBoolean(args.wholeProject, 'wholeProject');
    return getDocumentHistory(
      projectRoot,
      validateDocumentPath(args.documentPath),
      args.wholeProject === true,
    );
  });

  ipcMain.handle(IPC.GetDocumentAtCommit, (_e, args) => {
    return getDocumentAtCommit(
      projectRootArg(args),
      validateSha(args.sha),
      validateDocumentPath(args.documentPath),
    );
  });

  ipcMain.handle(IPC.GetDocumentDiff, (_e, args) => {
    const projectRoot = projectRootArg(args);
    const to = validateSha(args.to, 'to');
    // `from` is a commit hash, or that hash's parent for history entries.
    assertString(args.from, 'from');
    const from = args.from.endsWith('^')
      ? `${validateSha(args.from.slice(0, -1), 'from')}^`
      : validateSha(args.from, 'from');
    return getDocumentDiff(projectRoot, from, to, validateDocumentPath(args.documentPath));
  });

  ipcMain.handle(IPC.RevertDocumentCommit, (_e, args) => {
    return revertDocumentCommit(projectRootArg(args), validateSha(args.sha));
  });

  // --- Annotations ---
  ipcMain.handle(IPC.ListDocumentAnnotations, (_e, args) => {
    return readAnnotations(projectRootArg(args));
  });

  ipcMain.handle(IPC.SaveDocumentAnnotation, (_e, args) => {
    return saveAnnotation(projectRootArg(args), args.annotation);
  });

  ipcMain.handle(IPC.DeleteDocumentAnnotation, (_e, args) => {
    return deleteAnnotation(projectRootArg(args), args.id);
  });

  ipcMain.handle(IPC.AskDocumentAnnotation, (_e, args) => {
    const projectRoot = projectRootArg(args);
    assertOptionalString(args.envFile, 'envFile');
    return askAnnotation(win, {
      projectRoot,
      documentPath: args.documentPath,
      annotationId: args.annotationId,
      agentId: args.agentId,
      agentName: args.agentName,
      command: args.command,
      envFile: args.envFile,
    });
  });
}

/** Everything the feature keeps alive; called on app quit. */
export function stopAllDocumentWork(): void {
  stopAllDocumentWatchers();
  stopAllDocumentRuns();
  stopAllAsks();
}
