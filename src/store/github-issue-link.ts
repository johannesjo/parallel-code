/** Links a new task to the GitHub issue its prompt names, such as `#123`. */
import { extractGitHubUrl, extractIssueReference, parseGitHubUrl } from '../lib/github-url';
import { setStore, store } from './core';
import { IPC } from '../../electron/ipc/channels';
import type { GitHubIssueSummary } from '../ipc/types';
import { invoke } from '../lib/ipc';
import { saveState } from './persistence';

// Called from tasks.ts, so it invokes IPC itself: importing ./github's wrappers
// would close an import cycle (github → navigation → tasks).
const readGitHubIssue = (url: string) => invoke<GitHubIssueSummary>(IPC.ReadGitHubIssue, { url });
const resolveGitHubRepository = (projectRoot: string) =>
  invoke<string>(IPC.ResolveGitHubRepository, { projectRoot });

/**
 * Sets the task's GitHub link from the issue its prompt names: an issue URL,
 * or a `#123` / "issue 123" reference resolved against the project's
 * repository; only issues link, not PRs. Runs after creation so the gh
 * lookups never delay task creation; a link the task already has wins.
 */
export async function linkTaskToIssueReference(
  taskId: string,
  projectRoot: string,
  prompt: string,
): Promise<void> {
  if (store.tasks[taskId]?.githubUrl) return;
  const url = await issueUrlInPrompt(projectRoot, prompt);
  // A rejection means gh is unavailable or there is no such number; a
  // reference GitHub can't confirm stays unlinked rather than dead.
  const issue = url ? await readGitHubIssue(url).catch(() => null) : null;
  // A pull request is not linked: the task works on a fresh branch, and a
  // linked PR would read as the task's own (checks, merge), as in kanban.ts.
  const task = store.tasks[taskId];
  if (issue?.kind !== 'issue' || !task || task.githubUrl) return;
  setStore('tasks', taskId, 'githubUrl', issue.url);
  void saveState();
}

/** The issue URL a prompt names, written out or as shorthand in the project's repository. */
async function issueUrlInPrompt(projectRoot: string, prompt: string): Promise<string | null> {
  const written = extractGitHubUrl(prompt);
  if (written) {
    // Rebuilt bare: the issue API rejects comment anchors, queries and subpaths.
    const parsed = parseGitHubUrl(written);
    return parsed?.type === 'issues'
      ? `https://github.com/${parsed.org}/${parsed.repo}/issues/${parsed.number}`
      : null;
  }
  const number = extractIssueReference(prompt);
  if (number === null) return null;
  // A rejection means the project has no github.com repository, so a `#123`
  // there is not a GitHub issue.
  const repository = await resolveGitHubRepository(projectRoot).catch(() => null);
  return repository ? `https://github.com/${repository}/issues/${number}` : null;
}
