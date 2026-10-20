/**
 * IPC for GitHub issues and pull requests. Every channel validates its
 * arguments; PR URLs must be HTTPS pull request URLs before reaching `gh`.
 */
import { ipcMain } from 'electron';
import { IPC } from '../ipc/channels.js';
import { assertInt, assertOptionalString, assertString, validatePath } from '../ipc/validate.js';
import type { GitHubIssueChange, PrMergeMethod } from '../ipc/shared-types.js';
import { TRIAGE_KINDS, TRIAGE_SORTS } from '../shared/github-triage.js';
import type { TriageKind, TriageSort } from '../shared/github-triage.js';
import { parsePrRef } from './gh.js';
import {
  browseGitHubIssues,
  readGitHubIssue,
  readGitHubIssueActivity,
  resolveGitHubRepository,
  updateGitHubIssue,
} from './issues.js';
import { getGitHubIssue, listGitHubWorkItems } from './work-items.js';
import {
  getFailedChecks,
  getPullRequestDetails,
  getReviewFeedback,
  markPullRequestReady,
  mergePullRequest,
} from './pull-requests.js';

const MAX_SEARCH_LENGTH = 200;
const MERGE_METHODS: readonly PrMergeMethod[] = ['squash', 'merge', 'rebase'];

type IpcArgs = Record<string, unknown>;

function prUrlArg(args: IpcArgs): string {
  assertString(args.prUrl, 'prUrl');
  if (!parsePrRef(args.prUrl)) throw new Error('prUrl must be a GitHub pull request URL');
  return args.prUrl;
}

function positiveIntArg(value: unknown, label: string): number {
  assertInt(value, label);
  if (value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

export function registerGitHubHandlers(): void {
  ipcMain.handle(IPC.ResolveGitHubRepository, (_e, args: IpcArgs) => {
    validatePath(args.projectRoot, 'projectRoot');
    return resolveGitHubRepository(args.projectRoot as string);
  });
  ipcMain.handle(IPC.BrowseGitHubIssues, (_e, args: IpcArgs) => {
    validatePath(args.projectRoot, 'projectRoot');
    for (const key of ['search', 'label', 'assignee', 'author'] as const) {
      assertString(args[key], key);
      if ((args[key] as string).length > MAX_SEARCH_LENGTH) throw new Error(`${key} is too long`);
    }
    if (
      typeof args.kind !== 'string' ||
      !Object.prototype.hasOwnProperty.call(TRIAGE_KINDS, args.kind)
    )
      throw new Error('Invalid work item type');
    if (
      typeof args.sort !== 'string' ||
      !Object.prototype.hasOwnProperty.call(TRIAGE_SORTS, args.sort)
    )
      throw new Error('Invalid work item sort');
    const state = args.state;
    if (state !== 'open' && state !== 'closed' && state !== 'all')
      throw new Error('Invalid issue state');
    const page = positiveIntArg(args.page, 'page');
    if (page > 40) throw new Error('Narrow the search to see more issues');
    return browseGitHubIssues(args.projectRoot as string, {
      kind: args.kind as TriageKind,
      sort: args.sort as TriageSort,
      author: args.author as string,
      search: args.search as string,
      label: args.label as string,
      assignee: args.assignee as string,
      state,
      page,
    });
  });
  ipcMain.handle(IPC.ReadGitHubIssue, (_e, args: IpcArgs) => {
    assertString(args.url, 'url');
    return readGitHubIssue(args.url);
  });
  ipcMain.handle(IPC.ReadGitHubIssueActivity, (_e, args: IpcArgs) => {
    assertString(args.url, 'url');
    return readGitHubIssueActivity(args.url, positiveIntArg(args.page, 'page'));
  });
  ipcMain.handle(IPC.UpdateGitHubIssue, (_e, args: IpcArgs) => {
    assertString(args.url, 'url');
    let change: GitHubIssueChange;
    if (args.field === 'state') {
      if (args.value !== 'open' && args.value !== 'closed') throw new Error('Invalid issue state');
      if (args.value === 'closed' && args.reason !== 'completed' && args.reason !== 'not_planned') {
        throw new Error('Choose a close reason');
      }
      change = {
        field: 'state',
        value: args.value,
        reason: args.reason === 'not_planned' ? 'not_planned' : 'completed',
      };
    } else if (args.field === 'labels' || args.field === 'assignees') {
      if (
        !Array.isArray(args.values) ||
        args.values.length > 100 ||
        !args.values.every(
          (v): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 100,
        )
      ) {
        throw new Error('Invalid issue metadata');
      }
      change = { field: args.field, values: [...new Set(args.values)] };
    } else throw new Error('Invalid issue change');
    return updateGitHubIssue(args.url, change);
  });

  ipcMain.handle(IPC.ListGitHubWorkItems, (_e, args: IpcArgs) => {
    validatePath(args.projectRoot, 'projectRoot');
    assertOptionalString(args.search, 'search');
    const search = args.search?.trim();
    if (search && search.length > MAX_SEARCH_LENGTH) throw new Error('search is too long');
    return listGitHubWorkItems(args.projectRoot as string, search || undefined);
  });

  ipcMain.handle(IPC.GetGitHubIssue, (_e, args: IpcArgs) => {
    validatePath(args.projectRoot, 'projectRoot');
    return getGitHubIssue(args.projectRoot as string, positiveIntArg(args.number, 'number'));
  });

  ipcMain.handle(IPC.GetPullRequestDetails, (_e, args: IpcArgs) =>
    getPullRequestDetails(prUrlArg(args)),
  );

  ipcMain.handle(IPC.GetPrFailedChecks, (_e, args: IpcArgs) => getFailedChecks(prUrlArg(args)));

  ipcMain.handle(IPC.GetPrReviewFeedback, (_e, args: IpcArgs) => getReviewFeedback(prUrlArg(args)));

  ipcMain.handle(IPC.MarkPullRequestReady, (_e, args: IpcArgs) =>
    markPullRequestReady(prUrlArg(args)),
  );

  ipcMain.handle(IPC.MergePullRequest, (_e, args: IpcArgs) => {
    const prUrl = prUrlArg(args);
    const method = MERGE_METHODS.find((m) => m === args.method);
    if (!method) throw new Error('method must be squash, merge or rebase');
    assertString(args.headSha, 'headSha');
    if (!/^[0-9a-f]{40}$/.test(args.headSha)) throw new Error('headSha must be a commit SHA');
    if (args.admin !== undefined && typeof args.admin !== 'boolean') {
      throw new Error('admin must be a boolean');
    }
    return mergePullRequest(prUrl, { method, headSha: args.headSha, admin: args.admin === true });
  });
}
