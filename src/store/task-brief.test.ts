import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStartRequest, mockLoadTaskDiff, mockIsTaskWorking, mockUpdateTaskName, hook } =
  vi.hoisted(() => ({
    mockStartRequest: vi.fn(),
    mockUpdateTaskName: vi.fn(),
    mockLoadTaskDiff: vi.fn(),
    mockIsTaskWorking: vi.fn(),
    hook: { status: null as null | { lastAssistantMessage?: string; updatedAt: number } },
  }));

vi.mock('../lib/model-request', () => ({ startModelRequest: mockStartRequest }));
vi.mock('./tasks', () => ({ updateTaskName: mockUpdateTaskName }));
vi.mock('../lib/load-task-diff', () => ({
  loadTaskDiff: mockLoadTaskDiff,
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
}));
vi.mock('./projects', () => ({ getProjectPath: () => '/repo' }));
vi.mock('./agentHookStatus', () => ({ getAgentHookStatus: () => hook.status }));
vi.mock('./agent-chat', () => ({
  isAgentChat: (task: { mainAgentView?: string; agentIds: string[] }, agentId: string) =>
    task.mainAgentView === 'chat' && task.agentIds[0] === agentId,
}));
vi.mock('./taskStatus', () => ({
  isTaskWorking: mockIsTaskWorking,
  getAgentOutputTail: () => 'screen text',
  normalizeCurrentFrame: (text: string) => text,
}));

import { store, setStore } from './core';
import type { Task } from './types';
import {
  dropAnsweredQuestion,
  publishTaskConfidence,
  refreshCodeFingerprint,
  refreshTaskBrief,
} from './task-brief';

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+change';

function reply(value: unknown) {
  mockStartRequest.mockReturnValue({
    result: Promise.resolve(JSON.stringify(value)),
    cancel: vi.fn(),
  });
}

function task(): Task {
  return store.tasks.t1;
}

beforeEach(() => {
  vi.clearAllMocks();
  hook.status = null;
  setStore('taskBriefs', true);
  setStore('briefModel', 'sonnet');
  setStore('modelTaskNames', true);
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
      lastPrompt: 'Fix the redirect',
      promptHistory: [{ text: 'Fix the redirect', sentAt: 50 }],
    } as unknown as Task,
  });
  mockLoadTaskDiff.mockResolvedValue({ rawDiff: DIFF, cwd: '/wt' });
});

describe('refreshTaskBrief', () => {
  it('writes the brief from the diff, the prompts and the agent message', async () => {
    hook.status = { lastAssistantMessage: 'I fixed it; tests not run.', updatedAt: 1 };
    reply({
      goal: 'Return people to their page.',
      now: 'Redirect fixed; tests not run yet.',
      needsYou: '',
    });
    await refreshTaskBrief('t1');
    const request = mockStartRequest.mock.calls[0][0];
    expect(request).toMatchObject({ purpose: 'brief', cwd: '/wt' });
    expect(request.prompt).toContain('I fixed it; tests not run.');
    expect(request.prompt).toContain('Fix the redirect');
    expect(request.prompt).toContain('+change');
    expect(task().briefStatus).toBeUndefined();
    expect(task().brief?.brief).toEqual({
      goal: 'Return people to their page.',
      now: 'Redirect fixed; tests not run yet.',
    });
    expect(task().brief?.fingerprint).toBeTruthy();
  });

  it('runs on the chosen brief model', async () => {
    reply({ now: 'h' });
    await refreshTaskBrief('t1');
    expect(mockStartRequest.mock.calls[0][0].settings).toMatchObject({
      provider: 'claude',
      model: 'sonnet',
    });
    setStore('briefModel', 'terra');
    await refreshTaskBrief('t1', { force: true });
    expect(mockStartRequest.mock.calls[1][0].settings).toMatchObject({
      provider: 'codex',
      model: 'gpt-6.1-terra',
    });
  });

  it('keeps the last brief when a rewrite fails', async () => {
    reply({ now: 'h' });
    await refreshTaskBrief('t1');
    mockStartRequest.mockReturnValue({
      result: Promise.reject(new Error('provider down')),
      cancel: vi.fn(),
    });
    await refreshTaskBrief('t1', { force: true });
    expect(task().briefStatus).toEqual({ state: 'failed', message: 'provider down' });
    expect(task().brief?.brief.now).toBe('h');
  });

  it('skips the model when no prompt went out and the code did not change', async () => {
    reply({ now: 'first' });
    await refreshTaskBrief('t1');
    await refreshTaskBrief('t1');
    expect(mockStartRequest).toHaveBeenCalledTimes(1);
    expect(task().briefStatus).toBeUndefined();

    reply({ now: 'forced' });
    await refreshTaskBrief('t1', { force: true });
    expect(task().brief?.brief.now).toBe('forced');

    setStore('tasks', 't1', 'promptHistory', [
      { text: 'Fix the redirect', sentAt: 50 },
      { text: 'Now add a test', sentAt: Date.now() + 1_000 },
    ]);
    reply({ now: 'after prompt' });
    await refreshTaskBrief('t1');
    expect(mockStartRequest).toHaveBeenCalledTimes(3);
    expect(mockStartRequest.mock.calls[2][0].prompt).toContain('Now add a test');
  });

  it('does not mistake an unreadable diff for no changes', async () => {
    mockLoadTaskDiff.mockRejectedValue(new Error('git failed'));
    reply({ now: 'h' });
    await refreshTaskBrief('t1');
    expect(mockStartRequest.mock.calls[0][0].prompt).toContain('the diff could not be read');
    expect(task().brief?.fingerprint).toBe('');
  });

  it('leaves a prompt sent while the diff is read for the next brief', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000);
      reply({ now: 'first' });
      await refreshTaskBrief('t1');
      const sent = (text: string, sentAt: number) =>
        setStore('tasks', 't1', 'promptHistory', (history) => [
          ...(history ?? []),
          { text, sentAt },
        ]);
      sent('Second prompt', 1_500);
      let resolveDiff: (value: { rawDiff: string; cwd: string }) => void = () => {};
      mockLoadTaskDiff.mockReturnValueOnce(new Promise((resolve) => (resolveDiff = resolve)));
      vi.setSystemTime(2_000);
      reply({ now: 'second' });
      const run = refreshTaskBrief('t1');
      sent('Sent during the diff read', 2_500);
      resolveDiff({ rawDiff: DIFF, cwd: '/wt' });
      await run;
      const second = mockStartRequest.mock.calls[1][0].prompt as string;
      expect(second).toContain('Second prompt');
      expect(second).not.toContain('Sent during the diff read');
      vi.setSystemTime(3_000);
      reply({ now: 'third' });
      await refreshTaskBrief('t1');
      const third = mockStartRequest.mock.calls[2][0].prompt as string;
      expect(third).toContain('Sent during the diff read');
      expect(third).not.toContain('Second prompt');
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a new agent reply as news even without a prompt or code change', async () => {
    hook.status = { lastAssistantMessage: 'Here is what I found.', updatedAt: 1 };
    reply({ now: 'first' });
    await refreshTaskBrief('t1');
    await refreshTaskBrief('t1');
    expect(mockStartRequest).toHaveBeenCalledTimes(1);
    hook.status = { lastAssistantMessage: 'A different answer.', updatedAt: 2 };
    reply({ now: 'second' });
    await refreshTaskBrief('t1');
    expect(task().brief?.brief.now).toBe('second');
  });

  it('clears the spinner when the task starts closing mid-brief', async () => {
    let finish: (text: string) => void = () => {};
    mockStartRequest.mockReturnValueOnce({
      result: new Promise<string>((resolve) => (finish = resolve)),
      cancel: vi.fn(),
    });
    const run = refreshTaskBrief('t1');
    await vi.waitFor(() => expect(mockStartRequest).toHaveBeenCalled());
    setStore('tasks', 't1', 'closingStatus', 'closing');
    finish(JSON.stringify({ now: 'late' }));
    await run;
    expect(task().briefStatus).toBeUndefined();
    expect(task().brief).toBeUndefined();
  });

  it('records the code it read so ratings can be compared without a new brief', async () => {
    await refreshCodeFingerprint('t1');
    expect(task().codeFingerprint?.fingerprint).toBeTruthy();
  });

  it('uses the last chat reply for chat agents', async () => {
    setStore('tasks', 't1', 'mainAgentView', 'chat');
    setStore('agents', 'agent-1', {
      chatState: { items: [{ kind: 'assistant', text: 'Chat reply: done.' }] },
    } as never);
    reply({ now: 'h' });
    await refreshTaskBrief('t1');
    expect(mockStartRequest.mock.calls[0][0].prompt).toContain('Chat reply: done.');
  });

  it('does nothing when briefs are off', async () => {
    setStore('taskBriefs', false);
    await refreshTaskBrief('t1');
    expect(mockStartRequest).not.toHaveBeenCalled();
  });

  it('runs once more when a turn ends while a brief is being written', async () => {
    let resolveFirst: (text: string) => void = () => {};
    mockStartRequest.mockReturnValueOnce({
      result: new Promise<string>((resolve) => (resolveFirst = resolve)),
      cancel: vi.fn(),
    });
    const first = refreshTaskBrief('t1');
    await vi.waitFor(() => expect(mockStartRequest).toHaveBeenCalledTimes(1));
    reply({ now: 'second' });
    mockLoadTaskDiff.mockResolvedValue({ rawDiff: `${DIFF}\n+more`, cwd: '/wt' });
    void refreshTaskBrief('t1');
    resolveFirst(JSON.stringify({ now: 'first' }));
    await first;
    await vi.waitFor(() => expect(task().brief?.brief.now).toBe('second'));
    expect(mockStartRequest).toHaveBeenCalledTimes(2);
  });
});

describe('title from the first brief', () => {
  const titled = { title: 'Pick the next marketing step', goal: 'Decide the next step.', now: 'n' };

  it('renames a task the user has not named, once, from the first brief', async () => {
    setStore('tasks', 't1', { name: 'what should we do next?', nameIsAutoGenerated: true });
    reply(titled);
    await refreshTaskBrief('t1');
    expect(mockStartRequest.mock.calls[0][0].prompt).toContain('"title":string');
    expect(mockUpdateTaskName).toHaveBeenCalledWith('t1', 'Pick the next marketing step');
    // Later briefs leave the title alone, even when one comes back.
    mockStartRequest.mockClear();
    await refreshTaskBrief('t1', { force: true });
    expect(mockStartRequest.mock.calls[0][0].prompt).not.toContain('"title":string');
    expect(mockUpdateTaskName).toHaveBeenCalledTimes(1);
  });

  it('replaces a title the naming model gave', async () => {
    setStore('tasks', 't1', { nameIsAutoGenerated: false, nameFromModel: true });
    reply(titled);
    await refreshTaskBrief('t1');
    expect(mockUpdateTaskName).toHaveBeenCalledWith('t1', 'Pick the next marketing step');
  });

  it('keeps a name the user gave, or one renamed while the brief was written', async () => {
    setStore('tasks', 't1', { nameIsAutoGenerated: false, nameFromModel: undefined });
    reply(titled);
    await refreshTaskBrief('t1');
    expect(mockStartRequest.mock.calls[0][0].prompt).not.toContain('"title":string');
    expect(mockUpdateTaskName).not.toHaveBeenCalled();

    setStore('tasks', 't1', { brief: undefined, nameIsAutoGenerated: true });
    mockStartRequest.mockReturnValue({
      result: Promise.resolve(JSON.stringify(titled)).then((text) => {
        setStore('tasks', 't1', 'nameIsAutoGenerated', false);
        return text;
      }),
      cancel: vi.fn(),
    });
    await refreshTaskBrief('t1');
    expect(mockUpdateTaskName).not.toHaveBeenCalled();
  });

  it('keeps the name when model naming is off or the task follows Super Productivity', async () => {
    setStore('tasks', 't1', { nameIsAutoGenerated: true });
    setStore('modelTaskNames', false);
    reply(titled);
    await refreshTaskBrief('t1');
    setStore('modelTaskNames', true);
    setStore('tasks', 't1', {
      brief: undefined,
      superProductivity: { taskId: 'sp1' } as Task['superProductivity'],
    });
    await refreshTaskBrief('t1');
    expect(mockUpdateTaskName).not.toHaveBeenCalled();
  });
});

describe('dropAnsweredQuestion', () => {
  it('forgets the question once the agent works again, and briefs its next reply', () => {
    setStore('tasks', 't1', 'brief', {
      brief: { goal: 'Fix login', now: 'Asking', needsYou: 'Keep the old route?' },
      generatedAt: 100,
      fingerprint: 'f',
      messageFingerprint: 'm',
    });
    dropAnsweredQuestion('t1');
    expect(task().brief?.brief).toEqual({ goal: 'Fix login', now: 'Asking' });
    expect(task().brief?.messageFingerprint).toBeUndefined();
  });

  it('leaves a brief without a question alone', () => {
    setStore('tasks', 't1', 'brief', {
      brief: { goal: 'Fix login', now: 'Working' },
      generatedAt: 100,
      fingerprint: 'f',
      messageFingerprint: 'm',
    });
    dropAnsweredQuestion('t1');
    expect(task().brief?.messageFingerprint).toBe('m');
  });
});

describe('ratings', () => {
  beforeEach(async () => {
    reply({ now: 'h' });
    await refreshTaskBrief('t1');
  });

  it('stores a published rating with the fingerprint of the code it rated', async () => {
    publishTaskConfidence('t1', { scores: [{ label: 'Confidence', score: 70, why: 'x' }] });
    expect(task().confidence).toMatchObject({ scores: [{ score: 70 }], findings: [] });
    await vi.waitFor(() => expect(task().confidence?.fingerprint).toBe(task().brief?.fingerprint));
    expect(() => publishTaskConfidence('t1', { scores: [] })).toThrow('scores must be');
    expect(() =>
      publishTaskConfidence('missing', { scores: [{ label: 'C', score: 1, why: 'x' }] }),
    ).toThrow('Task not available');
  });
});
