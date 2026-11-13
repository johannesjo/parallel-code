/**
 * Create PR in one click: push, draft the title and description with the
 * brief model, and open a draft PR, with no dialog. The Create pull request
 * form in Finish remains for writing the description first.
 */
import { createSignal } from 'solid-js';
import { IPC } from '../../electron/ipc/channels';
import type { PrDraft } from '../../electron/shared/pr-draft';
import type { BranchPrDetectionResult, CommitInfo, MergeStatus } from '../ipc/types';
import { Channel, invoke } from '../lib/ipc';
import { parseGitHubUrl } from '../lib/github-url';
import { errMessage, warn as logWarn } from '../lib/log';
import { store } from '../store/core';
import { createPullRequestForTask, linkPullRequestToTask } from '../store/github';
import { NOTIFICATION_ERROR_MS, showNotification } from '../store/notification';
import { agentPrDraft, readPrTemplate, startPrDraft, takeAgentPrDraft } from '../store/pr-draft';
import { getProjectPath, pushTask } from '../store/store';
import type { Task } from '../store/types';
import { buildSquashMessage } from './squash-message';

export type OneClickPrStep = 'checking' | 'pushing' | 'creating';

const [steps, setSteps] = createSignal<Record<string, OneClickPrStep>>({});

/** The step a one-click create of the task's PR is on, or undefined when none is running. */
export function oneClickPrStep(taskId: string): OneClickPrStep | undefined {
  return steps()[taskId];
}

function setStep(taskId: string, step: OneClickPrStep | null): void {
  setSteps((prev) => {
    const { [taskId]: _done, ...rest } = prev;
    return step ? { ...rest, [taskId]: step } : rest;
  });
}

const UNAVAILABLE = {
  missing: 'GitHub CLI (gh) was not found. Install it to create pull requests from here.',
  auth: 'GitHub CLI is not logged in. Run "gh auth login" in a terminal, then try again.',
} as const;

/**
 * Creates the task's PR as a draft and reports the outcome in a notice. A
 * PR the branch already has is linked instead. A second click while one runs
 * does nothing.
 */
export async function createPrInOneClick(taskId: string): Promise<void> {
  const task = store.tasks[taskId];
  if (!task || oneClickPrStep(taskId)) return;
  setStep(taskId, 'checking');
  try {
    await run(task);
  } catch (err) {
    showNotification(`Could not create the pull request: ${errMessage(err)}`, {
      durationMs: NOTIFICATION_ERROR_MS,
    });
  } finally {
    setStep(taskId, null);
  }
}

async function run(task: Task): Promise<void> {
  const existing = await preflight(task);
  if (existing) return notifyCreated(existing, 'Linked');
  const { base, needsPush } = await branchState(task);
  const commits = await invoke<CommitInfo[]>(IPC.GetBranchCommits, {
    worktreePath: task.worktreePath,
    baseBranch: base,
    withBody: true,
  });
  if (commits.length === 0) throw new Error(`The branch has no commits beyond ${base} yet.`);
  // The draft does not need the branch on GitHub, so it runs during the push.
  const drafting = await startDraft(task, commits);
  try {
    setStep(task.id, 'pushing');
    if (needsPush) await push(task.id);
  } catch (err) {
    drafting.cancel(); // A paid model run whose draft could no longer be used.
    throw err;
  }
  const { draft, fellBack } = await drafting.result;
  setStep(task.id, 'creating');
  const pr = await createPullRequestForTask(task.id, { base, ...draft, draft: true });
  takeAgentPrDraft(task.id); // Spent on this PR, so the form never offers it again.
  if (pr.existed) return notifyCreated(pr.url, 'Linked');
  notifyCreated(pr.url, 'Created draft', fellBack ? ' (described from its commits)' : '');
}

/** Pushes without a log to show; a failure throws git's reason. */
async function push(taskId: string): Promise<void> {
  const output = new Channel<string>();
  try {
    await pushTask(taskId, output);
  } finally {
    output.dispose();
  }
}

/** Fails before anything is pushed when gh cannot be used; returns the branch's PR if it has one. */
async function preflight(task: Task): Promise<string | null> {
  const result = await invoke<BranchPrDetectionResult>(IPC.DetectPrForBranch, {
    worktreePath: task.worktreePath,
    branchName: task.branchName,
  });
  if (result.unavailable) throw new Error(UNAVAILABLE[result.unavailable]);
  if (result.url) linkPullRequestToTask(task.id, result.url);
  return result.url;
}

/** The base Finish would use, and whether origin lacks the latest commits; fails without an origin. */
async function branchState(task: Task): Promise<{ base: string; needsPush: boolean }> {
  const projectRoot = getProjectPath(task.projectId);
  if (!projectRoot)
    throw new Error('Project folder not found — use Relink in the project settings');
  const status = await invoke<MergeStatus>(IPC.CheckMergeStatus, {
    worktreePath: task.worktreePath,
    baseBranch: task.baseBranch,
    projectRoot,
  });
  if (!status.remote)
    throw new Error('This branch has no origin remote to open a pull request on.');
  return { base: task.baseBranch ?? status.base_branch, needsPush: status.remote !== 'pushed' };
}

interface Drafting {
  result: Promise<{ draft: PrDraft; fellBack: boolean }>;
  cancel: () => void;
}

/**
 * A draft the task's agent already published, else the brief model's; when
 * drafting fails, the commits' squash message, so the click still opens a PR.
 */
async function startDraft(task: Task, commits: CommitInfo[]): Promise<Drafting> {
  // Peeked, not taken: a failed push leaves it for the Create pull request form.
  const published = agentPrDraft(task.id);
  if (published)
    return { result: Promise.resolve({ draft: published, fellBack: false }), cancel: () => {} };
  const template = await readPrTemplate(task.worktreePath);
  const request = startPrDraft(task, { commits, template, model: store.briefModel });
  const result = request.result.then(
    (draft) => ({ draft, fellBack: false }),
    (err: unknown) => {
      logWarn('github', 'PR draft failed; using the commit messages', { error: errMessage(err) });
      // The commits, not an unfilled template, so the notice's "described from its commits" holds.
      return { draft: buildSquashMessage(commits, task.name), fellBack: true };
    },
  );
  return { result, cancel: request.cancel };
}

function notifyCreated(url: string, what: string, note = ''): void {
  showNotification(`${what} pull request #${parseGitHubUrl(url)?.number ?? ''}${note}`, {
    tone: 'success',
    action: {
      label: 'Open on GitHub',
      run: () => void invoke(IPC.ShellOpenExternal, { url }),
    },
  });
}
