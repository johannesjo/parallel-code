import { createSignal } from 'solid-js';
import {
  DEFAULT_EVIDENCE_MODEL,
  parseEvidenceModelSettings,
} from '../../electron/shared/evidence-settings';
import { sanitizeBranchPrefix } from '../lib/branch-name';
import type { ProjectIconId } from '../lib/project-icon';
import type { GitIsolationMode, Project, TerminalBookmark } from '../store/types';
import { finalizeChecks, type CheckDraft } from './EvidenceSettingsFields';

/** Why a worktree folder can't be used, for paths the main process would
 *  reject anyway; blank is fine. The main process checks the rest. */
export function worktreeFolderError(value: string): string | undefined {
  const folder = value.trim();
  if (!folder || folder === '~' || folder.startsWith('~/') || folder.startsWith('/'))
    return undefined;
  return 'Use an absolute path or one starting with ~/';
}

/** Editable copy of a project's settings, saved only when the dialog saves. */
export function createProjectSettingsForm() {
  const [name, setName] = createSignal('');
  const [color, setColor] = createSignal('');
  const [icon, setIcon] = createSignal<ProjectIconId | undefined>();
  const [allowPeerAccess, setAllowPeerAccess] = createSignal(false);
  const [branchPrefix, setBranchPrefix] = createSignal('task');
  const [worktreeFolder, setWorktreeFolder] = createSignal('');
  const [deleteBranchOnClose, setDeleteBranchOnClose] = createSignal(true);
  const [defaultGitIsolation, setDefaultGitIsolation] = createSignal<GitIsolationMode>('worktree');
  const [defaultBaseBranch, setDefaultBaseBranch] = createSignal('');
  const [coverageReportPath, setCoverageReportPath] = createSignal('');
  const [verifyCommand, setVerifyCommand] = createSignal('');
  const [evidenceChecks, setEvidenceChecks] = createSignal<CheckDraft[]>([]);
  const [evidenceModel, setEvidenceModel] = createSignal(DEFAULT_EVIDENCE_MODEL);
  const [evidenceAutoBuild, setEvidenceAutoBuild] = createSignal(false);
  const [verifyAutoRun, setVerifyAutoRun] = createSignal(true);
  const [bookmarks, setBookmarks] = createSignal<TerminalBookmark[]>([]);

  function load(p: Project) {
    setName(p.name);
    setColor(p.color);
    setIcon(p.icon);
    setAllowPeerAccess(p.allowPeerAccess === true);
    setBranchPrefix(sanitizeBranchPrefix(p.branchPrefix ?? 'task'));
    setWorktreeFolder(p.worktreeFolder ?? '');
    setDeleteBranchOnClose(p.deleteBranchOnClose ?? true);
    setDefaultGitIsolation(p.defaultGitIsolation ?? 'worktree');
    setDefaultBaseBranch(p.defaultBaseBranch ?? '');
    setCoverageReportPath(p.coverageReportPath ?? '');
    setVerifyCommand(p.verifyCommand ?? '');
    setEvidenceChecks(p.evidenceChecks ? [...p.evidenceChecks] : []);
    setEvidenceModel(p.evidenceModel ?? DEFAULT_EVIDENCE_MODEL);
    setEvidenceAutoBuild(p.evidenceAutoBuild === true);
    setVerifyAutoRun(p.verifyAutoRun !== false);
    setBookmarks(p.terminalBookmarks ? [...p.terminalBookmarks] : []);
  }

  /** The fields `updateProject` stores; peer access saves separately. */
  function updates() {
    return {
      name: name().trim(),
      color: color(),
      icon: icon(),
      branchPrefix: sanitizeBranchPrefix(branchPrefix()),
      worktreeFolder: worktreeFolder().trim() || undefined,
      deleteBranchOnClose: deleteBranchOnClose(),
      defaultGitIsolation: defaultGitIsolation(),
      defaultBaseBranch: defaultBaseBranch() || undefined,
      coverageReportPath: coverageReportPath().trim() || undefined,
      verifyCommand: verifyCommand().trim() || undefined,
      evidenceChecks: finalizeChecks(evidenceChecks()),
      evidenceModel: parseEvidenceModelSettings(evidenceModel()),
      evidenceAutoBuild: evidenceAutoBuild(),
      verifyAutoRun: verifyAutoRun(),
      terminalBookmarks: bookmarks(),
    };
  }

  return {
    name,
    setName,
    color,
    setColor,
    icon,
    setIcon,
    allowPeerAccess,
    setAllowPeerAccess,
    branchPrefix,
    setBranchPrefix,
    worktreeFolder,
    setWorktreeFolder,
    worktreeFolderError: () => worktreeFolderError(worktreeFolder()),
    deleteBranchOnClose,
    setDeleteBranchOnClose,
    defaultGitIsolation,
    setDefaultGitIsolation,
    defaultBaseBranch,
    setDefaultBaseBranch,
    coverageReportPath,
    setCoverageReportPath,
    verifyCommand,
    setVerifyCommand,
    evidenceChecks,
    setEvidenceChecks,
    evidenceModel,
    setEvidenceModel,
    evidenceAutoBuild,
    setEvidenceAutoBuild,
    verifyAutoRun,
    setVerifyAutoRun,
    bookmarks,
    setBookmarks,
    load,
    updates,
  };
}

export type ProjectSettingsForm = ReturnType<typeof createProjectSettingsForm>;
