/** Renderer side of the GitHub integration: issue/PR lookups and PR actions for tasks. */
import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import { warn as logWarn } from '../lib/log';
import {
  buildFailedChecksPrompt,
  buildReviewFeedbackPrompt,
  hasReviewFeedback,
  buildIssuePrompt,
  buildPrTaskPrompt,
  buildIssueTriagePrompt,
  workItemTaskName,
} from '../lib/github-prompts';
import { setStore, store } from './core';
import { setPrefillPrompt, setTaskPromptDraftActive } from './tasks';
import { toggleNewTaskPanel } from './navigation';
import { setTaskFocusedPanel } from './focused-panel';
import type {
  GitHubIssueDetails,
  GitHubIssueSummary,
  GitHubIssueQuery,
  GitHubIssuePage,
  GitHubIssueActivityPage,
  GitHubIssueChange,
  GitHubWorkItem,
  PrFailedCheck,
  PrMergeMethod,
  PrReviewFeedback,
  PullRequestDetails,
} from '../ipc/types';

export function listGitHubWorkItems(
  projectRoot: string,
  search?: string,
): Promise<GitHubWorkItem[]> {
  return invoke<GitHubWorkItem[]>(IPC.ListGitHubWorkItems, { projectRoot, search });
}

export function getGitHubIssue(projectRoot: string, number: number): Promise<GitHubIssueDetails> {
  return invoke<GitHubIssueDetails>(IPC.GetGitHubIssue, { projectRoot, number });
}

export function getPullRequestDetails(prUrl: string): Promise<PullRequestDetails> {
  return invoke<PullRequestDetails>(IPC.GetPullRequestDetails, { prUrl });
}

/** Resolves true when GitHub confirms the merge; false when it is still pending. */
export async function mergePullRequestForTask(
  taskId: string,
  merge: { prUrl: string; method: PrMergeMethod; headSha: string; admin?: boolean },
): Promise<boolean> {
  const merged = await invoke<boolean>(IPC.MergePullRequest, merge);
  // Re-poll soon so the watcher sees the merge and drops the PR status.
  void invoke(IPC.RefreshPrChecksWatcher, { taskId }).catch((err: unknown) =>
    logWarn('github', 'Failed to refresh PR checks after merge', { err: String(err) }),
  );
  return merged;
}

/** The "fix CI" prompt for a PR's failed checks, or null when nothing failed. */
export async function loadFailedChecksPrompt(pr: {
  number: number;
  url: string;
}): Promise<string | null> {
  const checks = await invoke<PrFailedCheck[]>(IPC.GetPrFailedChecks, { prUrl: pr.url });
  return checks.length === 0 ? null : buildFailedChecksPrompt(pr, checks);
}

/** Stages a "fix CI" prompt in the task's prompt input. Returns false when nothing failed. */
export async function stageFailedChecksPrompt(
  taskId: string,
  pr: { number: number; url: string },
): Promise<boolean> {
  const prompt = await loadFailedChecksPrompt(pr);
  if (prompt === null) return false;
  stagePrompt(taskId, prompt);
  return true;
}

/** Stages an "address review" prompt. Returns false when there is no open feedback. */
export async function stageReviewFeedbackPrompt(
  taskId: string,
  pr: { number: number; url: string },
): Promise<boolean> {
  const feedback = await invoke<PrReviewFeedback>(IPC.GetPrReviewFeedback, { prUrl: pr.url });
  if (!hasReviewFeedback(feedback)) return false;
  stagePrompt(taskId, buildReviewFeedbackPrompt(pr, feedback));
  return true;
}

// Prefilled rather than sent: GitHub content is untrusted, so the user reads
// and edits it before the agent sees it. Appended so an unsent draft survives.
function stagePrompt(taskId: string, text: string): void {
  const task = store.tasks[taskId];
  if (!task) return;
  const draft = task.prefillPrompt ?? task.promptDraft ?? '';
  setTaskPromptDraftActive(taskId, true);
  setStore('showPromptInput', true);
  setPrefillPrompt(taskId, [draft, text].filter(Boolean).join('\n\n'));
  queueMicrotask(() => {
    if (store.tasks[taskId]) setTaskFocusedPanel(taskId, 'prompt');
  });
}

/** Browser state is separate from the task composer and survives task handoff. */
export function openGitHubIssues(projectId: string | null): void {
  setStore('githubIssuesProjectId', projectId);
}

/** The project's github.com repository (`owner/name`) as the GitHub CLI resolves it. */
export function resolveGitHubRepository(projectRoot: string): Promise<string> {
  return invoke<string>(IPC.ResolveGitHubRepository, { projectRoot });
}

export function browseGitHubIssues(
  projectRoot: string,
  query: GitHubIssueQuery,
): Promise<GitHubIssuePage> {
  return invoke(IPC.BrowseGitHubIssues, { projectRoot, ...query });
}

export function readGitHubIssue(url: string): Promise<GitHubIssueSummary> {
  return invoke(IPC.ReadGitHubIssue, { url });
}

export function readGitHubIssueActivity(
  url: string,
  page: number,
): Promise<GitHubIssueActivityPage> {
  return invoke(IPC.ReadGitHubIssueActivity, { url, page });
}

export function updateGitHubIssue(
  url: string,
  change: GitHubIssueChange,
): Promise<GitHubIssueSummary> {
  return invoke(IPC.UpdateGitHubIssue, { url, ...change });
}

/** Never replace an already open composer or its unsent draft. */
export function startGitHubIssueTask(projectId: string, issue: GitHubIssueSummary): boolean {
  if (store.showNewTaskPanel) return false;
  setStore('newTaskPrefillPrompt', {
    projectId,
    name: workItemTaskName(issue),
    prompt: issue.kind === 'pr' ? buildPrTaskPrompt(issue) : buildIssuePrompt(issue),
    githubPr: issue.kind === 'pr' ? { ...issue, kind: 'pr' } : undefined,
    githubUrl: issue.url,
  });
  openGitHubIssues(null);
  toggleNewTaskPanel(true);
  return true;
}

/** Most items one triage or agent-list batch may hold. */
export const GITHUB_BATCH_LIMIT = 25;

export function startGitHubTriageTask(projectId: string, issues: GitHubIssueSummary[]): boolean {
  if (store.showNewTaskPanel || !issues.length || issues.length > GITHUB_BATCH_LIMIT) return false;
  setStore('newTaskPrefillPrompt', {
    projectId,
    name: `Triage ${issues.length} GitHub items`,
    prompt: buildIssueTriagePrompt(issues),
    githubUrl: null,
  });
  openGitHubIssues(null);
  toggleNewTaskPanel(true);
  return true;
}
