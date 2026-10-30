import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInvoke, mockOn, mockDiff } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockOn: vi.fn(),
  mockDiff: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));
vi.mock('../lib/load-task-diff', () => ({
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
  loadTaskDiff: mockDiff,
}));
vi.mock('./notification', () => ({ showNotification: vi.fn(), NOTIFICATION_ERROR_MS: 10_000 }));
vi.mock('./task-review', () => ({ openTaskReview: vi.fn() }));

import { IPC } from '../../electron/ipc/channels';
import { ScreensFollowUp } from '../components/ScreensSection';
import { setStore } from './core';
import { showNotification } from './notification';
import type { AgentDef } from '../ipc/types';
import type { Task } from './types';
import {
  canCaptureScreens,
  cancelTaskScreens,
  captureTaskScreens,
  takeUnseenScreens,
  taskScreens,
} from './task-screens';

const disposers: (() => void)[] = [];
const mount = (view: () => JSX.Element) => {
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(render(view, host));
  return host;
};
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.innerHTML = '';
});

const image = (name: string) => ({
  path: `/out/${name}`,
  dataUrl: `data:image/png;base64,${name}`,
});

const button = (view: HTMLElement, text: string) =>
  [...view.querySelectorAll('button')].find((b) => b.textContent === text);

/** Ends a run that never returns: one capture per task runs at a time. */
const endRun = () => setStore('tasks', 't1', 'closingStatus', 'closing');

/** The progress listener the latest run registered. */
const progressListener = () =>
  mockOn.mock.calls.findLast(([channel]) => channel === IPC.TaskScreensProgress)?.[1] as
    | ((data: unknown) => void)
    | undefined;

beforeEach(() => {
  mockInvoke.mockReset();
  mockDiff.mockReset().mockResolvedValue({ rawDiff: 'diff-1' });
  mockOn.mockReset().mockImplementation(() => vi.fn());
  Object.assign(window, { electron: { ipcRenderer: { on: mockOn } } });
  vi.mocked(showNotification).mockClear();
  setStore('tasks', {
    t1: {
      id: 't1',
      name: 'Fix login',
      projectId: 'p1',
      branchName: 'task/fix',
      worktreePath: '/wt',
      gitIsolation: 'worktree',
      baseBranch: 'main',
      agentIds: ['agent-1'],
    } as unknown as Task,
  });
});

describe('canCaptureScreens', () => {
  it('is offered only when Claude Code is installed', () => {
    setStore('availableAgents', [{ id: 'codex', command: 'codex', available: true } as AgentDef]);
    expect(canCaptureScreens()).toBe(false);
    setStore('availableAgents', [
      { id: 'claude-code', command: 'claude', available: false } as AgentDef,
    ]);
    expect(canCaptureScreens()).toBe(false);
    setStore('availableAgents', [{ id: 'claude-code', command: 'claude' } as AgentDef]);
    expect(canCaptureScreens()).toBe(true);
  });
});

describe('captureTaskScreens', () => {
  it('shows the shots side by side once the run returns', async () => {
    mockInvoke.mockResolvedValue({
      shots: [{ label: 'Login page', before: image('a.png'), after: image('b.png') }],
    });
    const view = mount(() => <ScreensFollowUp taskId="t1" />);
    await captureTaskScreens('t1');
    expect(mockInvoke).toHaveBeenCalledWith(
      IPC.CaptureTaskScreens,
      expect.objectContaining({
        taskId: 't1',
        worktreePath: '/wt',
        baseBranch: 'main',
        projectId: 'p1',
      }),
    );
    expect(view.querySelector('img[alt="Login page, before"]')).not.toBeNull();
    expect(view.querySelector('img[alt="Login page, after"]')).not.toBeNull();
    expect(showNotification).toHaveBeenCalled();
  });

  it('reports a failed run in the gallery', async () => {
    mockInvoke.mockRejectedValue(new Error('no browser'));
    const view = mount(() => <ScreensFollowUp taskId="t1" />);
    await captureTaskScreens('t1');
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('no browser');
  });

  it('forgets a run the user cancelled instead of calling it failed', async () => {
    let reject: (error: Error) => void = () => {};
    mockInvoke.mockImplementation((channel: string) =>
      channel === IPC.CaptureTaskScreens
        ? new Promise((_, rej) => (reject = rej))
        : Promise.resolve(),
    );
    const view = mount(() => <ScreensFollowUp taskId="t1" />);
    const run = captureTaskScreens('t1');
    // The action shows the run; only the × beside it stops it.
    view.querySelector<HTMLButtonElement>('.change-tour-action')?.click();
    expect(mockInvoke).not.toHaveBeenCalledWith(IPC.CancelTaskScreens, expect.anything());
    view.querySelector<HTMLButtonElement>('button[aria-label="Cancel the capture"]')?.click();
    expect(mockInvoke).toHaveBeenCalledWith(IPC.CancelTaskScreens, { taskId: 't1' });
    // The × goes away with the run; focus stays on the step instead of falling to the page.
    expect(document.activeElement).toBe(view.querySelector('.change-tour-action'));
    reject(new Error('cancelled'));
    await run;
    expect(taskScreens('t1')).toBeUndefined();
  });

  it("shows the run's latest step and how long it has taken", async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      let resolve: (value: unknown) => void = () => {};
      mockInvoke.mockImplementation((channel: string) =>
        channel === IPC.CaptureTaskScreens
          ? new Promise((res) => (resolve = res))
          : Promise.resolve(),
      );
      const view = mount(() => <ScreensFollowUp taskId="t1" />);
      const run = captureTaskScreens('t1');
      const progress = () => view.querySelector('.screens-progress')?.textContent;
      expect(progress()).toBe('Starting · 0s');
      expect(view.querySelector('button .inline-spinner')).not.toBeNull();
      expect(view.querySelector('.change-tour-action')?.textContent).toContain(
        'Capturing before & after',
      );
      progressListener()?.({ taskId: 'other', step: 'Not this task' });
      progressListener()?.({ taskId: 't1', step: 'Start the dev server' });
      vi.advanceTimersByTime(125_000);
      expect(progress()).toBe('Start the dev server · 2m 05s');
      resolve({ shots: [], headSha: 'h1' });
      await run;
      expect(progress()).toBe('Matches the current code');
      expect(view.querySelector('button .inline-spinner')).toBeNull();
      // This run's own listener is gone once it ended.
      const index = mockOn.mock.calls.findLastIndex(([ch]) => ch === IPC.TaskScreensProgress);
      expect(mockOn.mock.results[index]?.value).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks before starting the app, and starts it once allowed', async () => {
    mockInvoke.mockImplementation((channel: string) =>
      channel === IPC.CaptureTaskScreens ? new Promise(() => {}) : Promise.resolve(),
    );
    const view = mount(() => <ScreensFollowUp taskId="t1" />);
    void captureTaskScreens('t1');
    const commands = { after: 'npm run dev -- --port 8101', before: 'npm run dev -- --port 8102' };
    progressListener()?.({ taskId: 't1', commands });
    const codes = [...view.querySelectorAll('pre code')].map((code) => code.textContent);
    expect(codes).toEqual([commands.after, commands.before]);
    expect(view.querySelector('.screens-progress')?.textContent).toContain(
      'Waiting for you to start the app',
    );
    // Nothing is working while the run waits on the user.
    expect(view.querySelector('button .inline-spinner')).toBeNull();
    expect(vi.mocked(showNotification).mock.calls[0][0]).toBe(
      'Screenshots of “Fix login” wait for you to start the app.',
    );
    // A step the CLI still reports does not take the question away.
    progressListener()?.({ taskId: 't1', step: 'Late step' });
    expect(view.querySelector('pre code')).not.toBeNull();
    button(view, 'Start')?.click();
    // The commands go back with the approval, so only what the user saw runs.
    expect(mockInvoke).toHaveBeenCalledWith(IPC.ApproveTaskScreens, { taskId: 't1', ...commands });
    expect(view.querySelector('pre code')).toBeNull();
    endRun();
  });

  it('asks again when the approval does not reach the run', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.CaptureTaskScreens) return new Promise(() => {});
      return channel === IPC.ApproveTaskScreens
        ? Promise.reject(new Error('gone'))
        : Promise.resolve();
    });
    const view = mount(() => <ScreensFollowUp taskId="t1" />);
    void captureTaskScreens('t1');
    progressListener()?.({ taskId: 't1', commands: { after: 'npm start' } });
    button(view, 'Start')?.click();
    await vi.waitFor(() => expect(view.querySelector('pre code')?.textContent).toBe('npm start'));
    endRun();
  });

  it('declines the commands by stopping the capture', async () => {
    mockInvoke.mockImplementation((channel: string) =>
      channel === IPC.CaptureTaskScreens ? new Promise(() => {}) : Promise.resolve(),
    );
    const view = mount(() => <ScreensFollowUp taskId="t1" />);
    void captureTaskScreens('t1');
    progressListener()?.({ taskId: 't1', commands: { after: 'npm start' } });
    button(view, 'Don’t start')?.click();
    expect(mockInvoke).toHaveBeenCalledWith(IPC.CancelTaskScreens, { taskId: 't1' });
    expect(mockInvoke).not.toHaveBeenCalledWith(IPC.ApproveTaskScreens, expect.anything());
    endRun();
  });

  it('stops the run when the task closes', async () => {
    mockInvoke.mockImplementation((channel: string) =>
      channel === IPC.CaptureTaskScreens ? new Promise(() => {}) : Promise.resolve(),
    );
    void captureTaskScreens('t1');
    setStore('tasks', 't1', 'closingStatus', 'closing');
    await vi.waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(IPC.CancelTaskScreens, { taskId: 't1' }),
    );
  });

  it('drops the screenshots of a task that closes after they were taken', async () => {
    mockInvoke.mockResolvedValue({
      shots: [{ label: 'Login', after: image('b.png') }],
      headSha: 'h1',
    });
    await captureTaskScreens('t1');
    expect(taskScreens('t1')?.state).toBe('done');
    setStore('tasks', 't1', 'closingStatus', 'closing');
    expect(taskScreens('t1')).toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledWith(IPC.CancelTaskScreens, { taskId: 't1' });
  });

  it('drops a result that arrives after the user cancelled', async () => {
    let resolve: (value: unknown) => void = () => {};
    mockInvoke.mockImplementation((channel: string) =>
      channel === IPC.CaptureTaskScreens
        ? new Promise((res) => (resolve = res))
        : Promise.resolve(),
    );
    const run = captureTaskScreens('t1');
    cancelTaskScreens('t1');
    resolve({ shots: [{ label: 'Login', after: image('b.png') }], headSha: 'h1' });
    await run;
    expect(taskScreens('t1')).toBeUndefined();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('says nothing was captured instead of announcing ready screenshots', async () => {
    mockInvoke.mockResolvedValue({ shots: [], headSha: 'h1', note: 'No visible change.' });
    await captureTaskScreens('t1');
    expect(vi.mocked(showNotification).mock.calls[0][0]).toBe(
      'No screenshots of “Fix login”: No visible change.',
    );
  });

  it('keeps all of a long CLI error', async () => {
    mockInvoke.mockRejectedValue(new Error('x'.repeat(2000)));
    await captureTaskScreens('t1');
    const status = taskScreens('t1');
    expect(status?.state === 'failed' && status.message.length).toBe(2000);
  });
});

describe('ScreensFollowUp', () => {
  const captured = async () => {
    mockInvoke.mockResolvedValue({
      shots: [{ label: 'Login', after: image('b.png') }],
      headSha: 'h1',
    });
    await captureTaskScreens('t1');
  };
  /** Screens the user has looked at before, so they start folded. */
  const seen = async () => {
    await captured();
    takeUnseenScreens('t1');
  };
  const toggle = (view: HTMLElement) =>
    view.querySelector<HTMLButtonElement>('.change-tour-action');

  it('shortens a long failure until the user asks for all of it', async () => {
    mockInvoke.mockRejectedValue(new Error(`${'x'.repeat(400)}END`));
    await captureTaskScreens('t1');
    const view = mount(() => <ScreensFollowUp taskId="t1" headSha="h1" />);
    const alert = () => view.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert()).not.toContain('END');
    button(view, 'Show full error')?.click();
    expect(alert()).toContain('END');
    button(view, 'Show less')?.click();
    expect(alert()).not.toContain('END');
  });

  it('opens screens that finished while Finish was closed, once', async () => {
    await captured();
    const first = mount(() => <ScreensFollowUp taskId="t1" headSha="h1" />);
    expect(toggle(first)?.getAttribute('aria-expanded')).toBe('true');
    const again = mount(() => <ScreensFollowUp taskId="t1" headSha="h1" />);
    expect(toggle(again)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('folds earlier screens under their button, which shows and hides them', async () => {
    await seen();
    const view = mount(() => <ScreensFollowUp taskId="t1" headSha="h1" />);
    expect(toggle(view)?.textContent).toContain('Screens · 1 captured');
    expect(toggle(view)?.getAttribute('aria-expanded')).toBe('false');
    expect(view.querySelector('img')).toBeNull();
    toggle(view)?.click();
    expect(toggle(view)?.getAttribute('aria-expanded')).toBe('true');
    expect(view.querySelector('img[alt="Login, after"]')).not.toBeNull();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('captures again from beside the screens', async () => {
    await seen();
    const view = mount(() => <ScreensFollowUp taskId="t1" headSha="h1" />);
    toggle(view)?.click();
    const again = [...view.querySelectorAll('button')].find(
      (button) => button.textContent === 'Capture again',
    );
    again?.click();
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('notes screenshots taken before the latest commit', async () => {
    await seen();
    const current = mount(() => <ScreensFollowUp taskId="t1" headSha="h1" />);
    toggle(current)?.click();
    expect(current.textContent).not.toContain('Captured before the latest changes');
    const older = mount(() => <ScreensFollowUp taskId="t1" headSha="h2" />);
    toggle(older)?.click();
    expect(older.textContent).toContain('Captured before the latest changes');
  });

  it('notes screenshots of code that changed since, without a new commit', async () => {
    await seen();
    const view = mount(() => <ScreensFollowUp taskId="t1" headSha="h1" />);
    toggle(view)?.click();
    const progress = () => view.querySelector('.screens-progress')?.textContent;
    expect(view.textContent).not.toContain('Captured before the latest changes');
    expect(progress()).toBe('Matches the current code');
    setStore('tasks', 't1', 'codeFingerprint', { fingerprint: 'changed', at: Date.now() + 1000 });
    expect(view.textContent).toContain('Captured before the latest changes');
    expect(progress()).toBe('Out of date: the code changed since');
  });
});
