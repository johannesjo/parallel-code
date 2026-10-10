import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStartRequest, mockLoadTaskDiff, mockSendPrompt, mockIsTaskWorking, hook } = vi.hoisted(
  () => ({
    mockStartRequest: vi.fn(),
    mockLoadTaskDiff: vi.fn(),
    mockSendPrompt: vi.fn(),
    mockIsTaskWorking: vi.fn(),
    hook: { status: null as null | { lastAssistantMessage?: string; updatedAt: number } },
  }),
);

vi.mock('../lib/evidence-model-request', () => ({ startEvidenceModelRequest: mockStartRequest }));
vi.mock('../lib/load-task-diff', () => ({
  loadTaskDiff: mockLoadTaskDiff,
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
}));
vi.mock('./tasks', () => ({ sendPrompt: mockSendPrompt }));
vi.mock('./projects', () => ({ getProjectPath: () => '/repo' }));
vi.mock('./agentHookStatus', () => ({ getAgentHookStatus: () => hook.status }));
vi.mock('./taskStatus', () => ({
  isTaskWorking: mockIsTaskWorking,
  getAgentOutputTail: () => 'screen text',
  normalizeCurrentFrame: (text: string) => text,
}));

import { store, setStore } from './core';
import type { Task } from './types';
import {
  changeBriefDecision,
  keepBriefDecision,
  publishTaskConfidence,
  refreshTaskBrief,
  requestConfidenceRating,
} from './task-brief';
import { DEFAULT_CONFIDENCE_PROMPT } from '../lib/task-confidence';

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
  setStore('taskNameModel', 'haiku');
  setStore('confidencePrompt', '');
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
      headline: 'Tests not run yet',
      turnOutcome: 'Fixed the redirect.',
      changed: [{ text: 'Keeps the target.', file: 'src/a.ts' }],
      open: [{ text: 'Tests not run.' }],
      decided: [{ text: 'Kept ?next= working.' }],
    });
    await refreshTaskBrief('t1');
    const request = mockStartRequest.mock.calls[0][0];
    expect(request).toMatchObject({ purpose: 'brief', cwd: '/wt' });
    expect(request.prompt).toContain('I fixed it; tests not run.');
    expect(request.prompt).toContain('Fix the redirect');
    expect(request.prompt).toContain('+change');
    expect(task().briefStatus).toBeUndefined();
    expect(task().brief?.brief.headline).toBe('Tests not run yet');
    expect(task().brief?.brief.changed).toEqual([{ text: 'Keeps the target.', file: 'src/a.ts' }]);
    expect(task().brief?.turns).toEqual([
      expect.objectContaining({ prompt: 'Fix the redirect', outcome: 'Fixed the redirect.' }),
    ]);
    expect(task().brief?.fingerprint).toBeTruthy();
  });

  it('keeps decision marks across a rewrite and records failures', async () => {
    reply({ headline: 'h', decided: [{ text: 'Kept ?next= working.' }, { text: 'Dropped X.' }] });
    await refreshTaskBrief('t1');
    keepBriefDecision('t1', 'Dropped X.');
    reply({ headline: 'h2', decided: [{ text: 'Dropped X.' }] });
    await refreshTaskBrief('t1');
    expect(task().brief?.decisions).toEqual({ 'Dropped X.': 'kept' });

    mockStartRequest.mockReturnValue({
      result: Promise.reject(new Error('provider down')),
      cancel: vi.fn(),
    });
    await refreshTaskBrief('t1');
    expect(task().briefStatus).toEqual({ state: 'failed', message: 'provider down' });
    expect(task().brief?.brief.headline).toBe('h2');
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
    reply({ headline: 'second' });
    void refreshTaskBrief('t1');
    resolveFirst(JSON.stringify({ headline: 'first' }));
    await first;
    await vi.waitFor(() => expect(task().brief?.brief.headline).toBe('second'));
    expect(mockStartRequest).toHaveBeenCalledTimes(2);
  });
});

describe('decisions and ratings', () => {
  beforeEach(async () => {
    reply({ headline: 'h', decided: [{ text: 'Used BullMQ.' }] });
    await refreshTaskBrief('t1');
  });

  it('sends a correction to the agent and marks the decision', async () => {
    await changeBriefDecision('t1', 'Used BullMQ.', '  Use pg-boss instead.  ');
    expect(mockSendPrompt).toHaveBeenCalledWith('t1', 'agent-1', 'Use pg-boss instead.');
    expect(task().brief?.decisions).toEqual({ 'Used BullMQ.': 'sent' });
  });

  it('leaves the decision open when the prompt could not be sent', async () => {
    mockSendPrompt.mockRejectedValueOnce(new Error('busy'));
    await expect(changeBriefDecision('t1', 'Used BullMQ.', 'No')).rejects.toThrow('busy');
    expect(task().brief?.decisions).toEqual({});
  });

  it('asks for a rating with the configured prompt or the built-in one', async () => {
    await requestConfidenceRating('t1');
    expect(mockSendPrompt).toHaveBeenLastCalledWith('t1', 'agent-1', DEFAULT_CONFIDENCE_PROMPT);
    setStore('confidencePrompt', 'Run my /confidence skill');
    await requestConfidenceRating('t1');
    expect(mockSendPrompt).toHaveBeenLastCalledWith('t1', 'agent-1', 'Run my /confidence skill');
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
