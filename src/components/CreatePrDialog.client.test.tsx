import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreatePrDialog } from './CreatePrDialog';
import { createPullRequestForTask, linkPullRequestToTask } from '../store/github';
import {
  agentDraftBlocker,
  publishAgentPrDraft,
  readPrTemplate,
  requestAgentPrDraft,
  startPrDraft,
} from '../store/pr-draft';
import { setStore } from '../store/core';
import { IPC } from '../../electron/ipc/channels';
import type { BranchPrDetectionResult, CommitInfo } from '../ipc/types';
import type { PushRun } from './push-run';
import type { Task } from '../store/types';

let detection: BranchPrDetectionResult = { url: null };
vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(async (channel: string) =>
    channel === IPC.DetectPrForBranch ? detection : undefined,
  ),
}));
vi.mock('../store/github', () => ({
  createPullRequestForTask: vi.fn(async () => ({
    url: 'https://github.com/o/r/pull/7',
    existed: false,
  })),
  linkPullRequestToTask: vi.fn(),
}));
// The agent's published drafts stay real; only what reaches out of the dialog is mocked.
vi.mock('../store/pr-draft', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/pr-draft')>()),
  readPrTemplate: vi.fn(async () => undefined),
  startPrDraft: vi.fn(),
  requestAgentPrDraft: vi.fn(async () => {}),
  agentDraftBlocker: vi.fn(() => 'Busy'),
}));
vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: (props: {
    message: JSX.Element;
    confirmLabel: string;
    confirmDisabled?: boolean;
    footerNote?: string;
    onConfirm: () => void;
  }) => (
    <div>
      {props.message}
      <span data-testid="footer-note">{props.footerNote}</span>
      <button
        data-testid="confirm"
        disabled={props.confirmDisabled}
        onClick={() => props.onConfirm()}
      >
        {props.confirmLabel}
      </button>
    </div>
  ),
}));

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
  detection = { url: null };
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const confirmButton = () => document.querySelector<HTMLButtonElement>('[data-testid="confirm"]');
const footerNote = () => document.querySelector('[data-testid="footer-note"]')?.textContent;
const titleInput = () => document.querySelector<HTMLInputElement>('input[type="text"]');
const bodyField = () => document.querySelector<HTMLTextAreaElement>('textarea');
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === text);

const task: Task = {
  id: 'parent',
  name: 'Parent',
  projectId: 'project',
  branchName: 'task/parent',
  worktreePath: '/repo/.worktrees/parent',
  gitIsolation: 'worktree',
  agentIds: [],
  shellAgentIds: [],
  notes: '',
  lastPrompt: '',
};
const oneCommit: CommitInfo[] = [{ hash: 'a1', message: 'fix(git): keep the base' } as CommitInfo];

function pushRun(pushed = true): PushRun {
  return {
    start: vi.fn(async () => pushed),
    error: () => 'rejected: non-fast-forward',
  } as unknown as PushRun;
}

async function mount(
  options: {
    remote?: 'unpushed' | 'pushed' | 'none';
    push?: PushRun;
    task?: Task;
    commits?: CommitInfo[];
  } = {},
) {
  const push = options.push ?? pushRun();
  const onCreated = vi.fn();
  dispose = render(
    () => (
      <CreatePrDialog
        open
        task={options.task ?? task}
        base="main"
        remote={options.remote ?? 'pushed'}
        commits={options.commits ?? oneCommit}
        push={push}
        onCreated={onCreated}
        onClose={() => {}}
      />
    ),
    document.body,
  );
  await flush();
  return { push, onCreated };
}

describe('CreatePrDialog', () => {
  it('titles the PR after the only commit and creates it as a draft', async () => {
    const { onCreated } = await mount();
    expect(titleInput()?.value).toBe('fix(git): keep the base');

    confirmButton()?.click();
    await flush();

    expect(createPullRequestForTask).toHaveBeenCalledWith('parent', {
      base: 'main',
      title: 'fix(git): keep the base',
      body: '',
      draft: true,
    });
    expect(onCreated).toHaveBeenCalledWith({
      url: 'https://github.com/o/r/pull/7',
      existed: false,
      draft: true,
    });
  });

  it('pushes an unpushed branch before creating', async () => {
    const { push } = await mount({ remote: 'unpushed' });
    expect(confirmButton()?.textContent).toBe('Push and create PR');
    expect(footerNote()).toContain('is not on GitHub yet');

    confirmButton()?.click();
    await flush();

    expect(push.start).toHaveBeenCalled();
    expect(createPullRequestForTask).toHaveBeenCalled();
  });

  it('stops at a failed push and says why', async () => {
    await mount({ remote: 'unpushed', push: pushRun(false) });
    confirmButton()?.click();
    await flush();

    expect(createPullRequestForTask).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Push failed: rejected: non-fast-forward',
    );
  });

  it('keeps the description when GitHub refuses the PR', async () => {
    vi.mocked(createPullRequestForTask).mockRejectedValueOnce(new Error('base branch not found'));
    await mount();
    const body = bodyField();
    if (!body) throw new Error('no description field');
    body.value = 'Why and what';
    body.dispatchEvent(new Event('input', { bubbles: true }));

    confirmButton()?.click();
    await flush();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'base branch not found',
    );
    expect(bodyField()?.value).toBe('Why and what');
  });

  it("offers to link the branch's existing PR instead of creating one", async () => {
    detection = { url: 'https://github.com/o/r/pull/12' };
    const { onCreated } = await mount();
    expect(confirmButton()?.textContent).toBe('Use PR #12 for this task');

    confirmButton()?.click();

    expect(linkPullRequestToTask).toHaveBeenCalledWith('parent', 'https://github.com/o/r/pull/12');
    expect(createPullRequestForTask).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ existed: true }));
  });

  it('blocks creating while gh is logged out', async () => {
    detection = { url: null, unavailable: 'auth' };
    await mount();

    expect(confirmButton()?.disabled).toBe(true);
    expect(footerNote()).toContain('gh auth login');
    // Reopening after logging in starts over, so a draft now would be lost.
    expect(button('Draft description')?.disabled).toBe(true);
  });

  it('blocks creating on a branch without commits', async () => {
    await mount({ commits: [] });

    expect(confirmButton()?.disabled).toBe(true);
    expect(footerNote()).toContain('no commits beyond main');
  });

  it('blocks creating without an origin remote', async () => {
    await mount({ remote: 'none' });

    expect(confirmButton()?.disabled).toBe(true);
    expect(footerNote()).toContain('no origin remote');
  });

  it("prefills the description with the repo's PR template", async () => {
    vi.mocked(readPrTemplate).mockResolvedValueOnce('## Why\n\n## Testing\n');
    await mount();

    expect(bodyField()?.value).toBe('## Why\n\n## Testing\n');
  });

  it('fills both fields from a draft, but never a title the user typed', async () => {
    vi.mocked(startPrDraft).mockReturnValue({
      result: Promise.resolve({ title: 'Drafted title', body: 'Drafted body' }),
      cancel: vi.fn(),
    });
    await mount();
    const title = titleInput();
    if (!title) throw new Error('no title field');
    title.value = 'My title';
    title.dispatchEvent(new Event('input', { bubbles: true }));

    button('Draft description')?.click();
    await flush();

    expect(title.value).toBe('My title');
    expect(bodyField()?.value).toBe('Drafted body');
    expect(button('Draft again')).toBeDefined();
  });

  it('reports a failed draft without touching the fields', async () => {
    vi.mocked(startPrDraft).mockImplementation(() => ({
      result: Promise.reject(new Error('model timed out')),
      cancel: vi.fn(),
    }));
    await mount();

    button('Draft description')?.click();
    await flush();

    expect(document.body.textContent).toContain('Could not draft: model timed out');
    expect(titleInput()?.value).toBe('fix(git): keep the base');
  });

  describe("with the task's agent", () => {
    const withAgent: Task = { ...task, agentIds: ['agent-1'] };
    afterEach(() => setStore('tasks', 'parent', undefined as unknown as Task));

    it('asks the agent by default and fills the fields from its published draft', async () => {
      vi.mocked(agentDraftBlocker).mockReturnValue(null);
      setStore('tasks', 'parent', withAgent);
      await mount({ task: withAgent });

      button('Draft description')?.click();
      await flush();
      expect(requestAgentPrDraft).toHaveBeenCalledWith('parent', 'main');
      expect(startPrDraft).not.toHaveBeenCalled();
      expect(bodyField()?.placeholder).toContain('is drafting in its session');

      publishAgentPrDraft('parent', { title: 'Agent title', body: 'Agent body' });
      await flush();
      expect(titleInput()?.value).toBe('Agent title');
      expect(bodyField()?.value).toBe('Agent body');
      expect(button('Draft again')).toBeDefined();
    });

    it('drafts with a separate model while the agent is busy, and says why', async () => {
      vi.mocked(agentDraftBlocker).mockReturnValue('Busy with a turn');
      vi.mocked(startPrDraft).mockReturnValue({
        result: Promise.resolve({ title: 'Model title', body: 'Model body' }),
        cancel: vi.fn(),
      });
      await mount({ task: withAgent });

      document.querySelector<HTMLButtonElement>('button[aria-label^="Draft with"]')?.click();
      const agentRow = document.querySelector<HTMLButtonElement>(
        '[role="group"][aria-label="This task\'s agent"] [role="menuitemradio"]',
      );
      expect(agentRow?.disabled).toBe(true);
      expect(agentRow?.textContent).toContain('Busy with a turn');

      button('Draft description')?.click();
      await flush();
      expect(requestAgentPrDraft).not.toHaveBeenCalled();
      expect(bodyField()?.value).toBe('Model body');
    });
  });
});
