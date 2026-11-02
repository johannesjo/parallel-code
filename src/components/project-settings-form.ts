import { createSignal } from 'solid-js';
import { sanitizeBranchPrefix } from '../lib/branch-name';
import type { ProjectIconId } from '../lib/project-icon';
import type { GitIsolationMode, Project, TerminalBookmark } from '../store/types';
import { finalizeChecks, type CheckDraft } from './ProjectChecksFields';
import {
  envDraftsFrom,
  envDraftsError,
  finalizeEnvDrafts,
  type EnvDraft,
} from './project-env-drafts';

/** Editable copy of a project's settings, saved only when the dialog saves. */
export function createProjectSettingsForm() {
  const [name, setName] = createSignal('');
  const [color, setColor] = createSignal('');
  const [icon, setIcon] = createSignal<ProjectIconId | undefined>();
  const [allowPeerAccess, setAllowPeerAccess] = createSignal(false);
  const [branchPrefix, setBranchPrefix] = createSignal('task');
  const [deleteBranchOnClose, setDeleteBranchOnClose] = createSignal(true);
  const [defaultGitIsolation, setDefaultGitIsolation] = createSignal<GitIsolationMode>('worktree');
  const [defaultBaseBranch, setDefaultBaseBranch] = createSignal('');
  const [coverageReportPath, setCoverageReportPath] = createSignal('');
  const [verifyCommand, setVerifyCommand] = createSignal('');
  const [evidenceChecks, setEvidenceChecks] = createSignal<CheckDraft[]>([]);
  const [verifyAutoRun, setVerifyAutoRun] = createSignal(true);
  const [bookmarks, setBookmarks] = createSignal<TerminalBookmark[]>([]);
  const [agentEnv, setAgentEnv] = createSignal<EnvDraft[]>([]);

  function load(p: Project) {
    setName(p.name);
    setColor(p.color);
    setIcon(p.icon);
    setAllowPeerAccess(p.allowPeerAccess === true);
    setBranchPrefix(sanitizeBranchPrefix(p.branchPrefix ?? 'task'));
    setDeleteBranchOnClose(p.deleteBranchOnClose ?? true);
    setDefaultGitIsolation(p.defaultGitIsolation ?? 'worktree');
    setDefaultBaseBranch(p.defaultBaseBranch ?? '');
    setCoverageReportPath(p.coverageReportPath ?? '');
    setVerifyCommand(p.verifyCommand ?? '');
    setEvidenceChecks(p.evidenceChecks ? [...p.evidenceChecks] : []);
    setVerifyAutoRun(p.verifyAutoRun !== false);
    setBookmarks(p.terminalBookmarks ? [...p.terminalBookmarks] : []);
    setAgentEnv(envDraftsFrom(p.agentEnv));
  }

  /** The fields `updateProject` stores; peer access saves separately. */
  function updates() {
    return {
      name: name().trim(),
      color: color(),
      icon: icon(),
      branchPrefix: sanitizeBranchPrefix(branchPrefix()),
      deleteBranchOnClose: deleteBranchOnClose(),
      defaultGitIsolation: defaultGitIsolation(),
      defaultBaseBranch: defaultBaseBranch() || undefined,
      coverageReportPath: coverageReportPath().trim() || undefined,
      verifyCommand: verifyCommand().trim() || undefined,
      evidenceChecks: finalizeChecks(evidenceChecks()),
      verifyAutoRun: verifyAutoRun(),
      terminalBookmarks: bookmarks(),
      agentEnv: finalizeEnvDrafts(agentEnv()),
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
    verifyAutoRun,
    setVerifyAutoRun,
    bookmarks,
    setBookmarks,
    agentEnv,
    setAgentEnv,
    /** Why the env rows can't be saved yet, or '' when they can. */
    agentEnvError: () => envDraftsError(agentEnv()),
    load,
    updates,
  };
}

export type ProjectSettingsForm = ReturnType<typeof createProjectSettingsForm>;
