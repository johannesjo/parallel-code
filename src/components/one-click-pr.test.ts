import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { BranchPrDetectionResult, CommitInfo } from '../ipc/types';
import { setStore } from '../store/core';
import { createPullRequestForTask, linkPullRequestToTask } from '../store/github';
import { showNotification } from '../store/notification';
import { agentPrDraft, startPrDraft, takeAgentPrDraft } from '../store/pr-draft';
import { pushTask } from '../store/store';
import type { Task } from '../store/types';
import { createPrInOneClick, oneClickPrStep } from './one-click-pr';

let detection: BranchPrDetectionResult = { url: null };
let commits: CommitInfo[] = [];
let mergeStatus: { base_branch: string; remote?: string } = { base_branch: 'main' };
vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(async (channel: string) => {
    if (channel === IPC.DetectPrForBranch) return detection;
    if (channel === IPC.GetBranchCommits) return commits;
    if (channel === IPC.CheckMergeStatus) return mergeStatus;
    return undefined;
  }),
  Channel: class {
    dispose() {}
  },
}));
vi.mock('../store/github', () => ({
  createPullRequestForTask: vi.fn(async () => ({
    url: 'https://github.com/o/r/pull/7',
    existed: false,
  })),
  linkPullRequestToTask: vi.fn(),
}));
vi.mock('../store/notification', () => ({
  NOTIFICATION_ERROR_MS: 10_000,
  showNotification: vi.fn(),
}));
vi.mock('../store/pr-draft', () => ({
  readPrTemplate: vi.fn(async () => undefined),
  startPrDraft: vi.fn(),
  agentPrDraft: vi.fn(() => undefined),
  takeAgentPrDraft: vi.fn(),
}));
vi.mock('../store/store', () => ({
  getProjectPath: vi.fn(() => '/repo'),
  pushTask: vi.fn(async () => {}),
}));

const commit: CommitInfo = { hash: 'a1', message: 'Add the widget', body: '' };

const cancelDraft = vi.fn();
function drafts(result: Promise<{ title: string; body: string }>) {
  vi.mocked(startPrDraft).mockReturnValue({ result, cancel: cancelDraft });
}
const lastNotice = () => vi.mocked(showNotification).mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  detection = { url: null };
  commits = [commit];
  mergeStatus = { base_branch: 'main', remote: 'unpushed' };
  drafts(Promise.resolve({ title: 'Add a widget', body: 'Adds the widget.' }));
  setStore('tasks', 't1', {
    id: 't1',
    name: 'Widget task',
    branchName: 'task/widget',
    baseBranch: 'main',
    worktreePath: '/wt',
    projectId: 'p1',
  } as Task);
});

describe('createPrInOneClick', () => {
  it('pushes, then opens a draft PR with the drafted title and description', async () => {
    await createPrInOneClick('t1');
    expect(pushTask).toHaveBeenCalledWith('t1', expect.anything());
    expect(createPullRequestForTask).toHaveBeenCalledWith('t1', {
      base: 'main',
      title: 'Add a widget',
      body: 'Adds the widget.',
      draft: true,
    });
    expect(lastNotice()).toBe('Created draft pull request #7');
    expect(oneClickPrStep('t1')).toBeUndefined();
  });

  it('links the PR the branch already has, without pushing or creating', async () => {
    detection = { url: 'https://github.com/o/r/pull/3' };
    await createPrInOneClick('t1');
    expect(linkPullRequestToTask).toHaveBeenCalledWith('t1', 'https://github.com/o/r/pull/3');
    expect(pushTask).not.toHaveBeenCalled();
    expect(createPullRequestForTask).not.toHaveBeenCalled();
    expect(lastNotice()).toBe('Linked pull request #3');
  });

  it('stops before pushing when gh is not logged in', async () => {
    detection = { url: null, unavailable: 'auth' };
    await createPrInOneClick('t1');
    expect(pushTask).not.toHaveBeenCalled();
    expect(lastNotice()).toMatch(/^Could not create the pull request: GitHub CLI is not logged in/);
  });

  it('does not push a branch without commits beyond its base', async () => {
    commits = [];
    await createPrInOneClick('t1');
    expect(pushTask).not.toHaveBeenCalled();
    expect(lastNotice()).toBe(
      'Could not create the pull request: The branch has no commits beyond main yet.',
    );
  });

  it('describes the PR from its commit when drafting fails', async () => {
    drafts(Promise.reject(new Error('model down')));
    await createPrInOneClick('t1');
    expect(createPullRequestForTask).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ title: 'Add the widget', draft: true }),
    );
    expect(lastNotice()).toBe('Created draft pull request #7 (described from its commits)');
  });

  it('reports a failed push and creates nothing', async () => {
    vi.mocked(pushTask).mockRejectedValueOnce(new Error('rejected: non-fast-forward'));
    await createPrInOneClick('t1');
    expect(createPullRequestForTask).not.toHaveBeenCalled();
    expect(lastNotice()).toBe('Could not create the pull request: rejected: non-fast-forward');
    expect(oneClickPrStep('t1')).toBeUndefined();
  });

  it('stops before drafting when the branch has no origin', async () => {
    mergeStatus = { base_branch: 'main' };
    await createPrInOneClick('t1');
    expect(startPrDraft).not.toHaveBeenCalled();
    expect(pushTask).not.toHaveBeenCalled();
    expect(lastNotice()).toBe(
      'Could not create the pull request: This branch has no origin remote to open a pull request on.',
    );
  });

  it('skips the push when origin has the latest commits already', async () => {
    mergeStatus = { base_branch: 'main', remote: 'pushed' };
    await createPrInOneClick('t1');
    expect(pushTask).not.toHaveBeenCalled();
    expect(createPullRequestForTask).toHaveBeenCalledOnce();
  });

  it('uses the base Finish detects when the task names none', async () => {
    setStore('tasks', 't1', 'baseBranch', undefined);
    mergeStatus = { base_branch: 'develop', remote: 'unpushed' };
    await createPrInOneClick('t1');
    expect(createPullRequestForTask).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ base: 'develop' }),
    );
  });

  it("uses the draft the task's agent already published instead of a model run", async () => {
    vi.mocked(agentPrDraft).mockReturnValueOnce({ title: 'Agent title', body: 'Agent body' });
    await createPrInOneClick('t1');
    expect(startPrDraft).not.toHaveBeenCalled();
    expect(createPullRequestForTask).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ title: 'Agent title', body: 'Agent body' }),
    );
    expect(takeAgentPrDraft).toHaveBeenCalledWith('t1');
  });

  it("leaves the agent's draft for the form when the push fails", async () => {
    vi.mocked(agentPrDraft).mockReturnValueOnce({ title: 'Agent title', body: 'Agent body' });
    vi.mocked(pushTask).mockRejectedValueOnce(new Error('rejected'));
    await createPrInOneClick('t1');
    expect(takeAgentPrDraft).not.toHaveBeenCalled();
  });

  it('cancels the model draft when the push fails', async () => {
    let finish: (draft: { title: string; body: string }) => void = () => {};
    drafts(new Promise((resolve) => (finish = resolve)));
    vi.mocked(pushTask).mockImplementationOnce(async () => {
      await vi.waitFor(() => expect(startPrDraft).toHaveBeenCalled());
      throw new Error('rejected');
    });
    await createPrInOneClick('t1');
    expect(cancelDraft).toHaveBeenCalledOnce();
    finish({ title: 'late', body: '' });
  });

  it('ignores a second click while one runs', async () => {
    const first = createPrInOneClick('t1');
    expect(oneClickPrStep('t1')).toBe('checking');
    await createPrInOneClick('t1');
    await first;
    expect(createPullRequestForTask).toHaveBeenCalledOnce();
  });
});
