import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIEF_MODELS } from '../../electron/shared/task-name-model';

const { mockRequest, mockInvoke, mockDiff, mockHook } = vi.hoisted(() => ({
  mockHook: { reply: undefined as string | undefined },
  mockRequest: vi.fn(),
  mockInvoke: vi.fn(),
  mockDiff: { raw: 'diff --git a/q.ts b/q.ts\n+retry()' },
}));
vi.mock('../lib/model-request', () => ({ startModelRequest: mockRequest }));
vi.mock('./agentHookStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentHookStatus')>()),
  getAgentHookStatus: () =>
    mockHook.reply === undefined ? null : { lastAssistantMessage: mockHook.reply, updatedAt: 1 },
}));
vi.mock('../lib/ipc', () => ({ invoke: mockInvoke }));
vi.mock('../lib/load-task-diff', () => ({
  loadTaskDiff: () => Promise.resolve({ rawDiff: mockDiff.raw, cwd: '/wt' }),
  getTaskDiffBaseBranch: (_mode: string, base?: string) => base,
}));
vi.mock('./projects', () => ({ getProjectPath: () => '/repo' }));
vi.mock('./check-suite-state', () => ({
  getTaskChecks: () => [{ id: 'lint', name: 'Lint', kind: 'static', command: 'npm run lint' }],
}));

import type { CardDefinition } from '../lib/cards';
import { diffFingerprint } from '../lib/diff-excerpt';
import { getModelCardRun, runModelCard, updateModelCards } from './card-models';
import { saveCard, setSlotPinned } from './cards';
import { setStore, store } from './core';
import type { Task } from './types';

const CARD: CardDefinition = {
  id: 'risks',
  name: 'Risks',
  description: 'Risks in the change',
  source: {
    kind: 'model',
    model: 'default',
    prompt: 'List risks.',
    inputs: ['diff'],
    trigger: 'after-turn',
  },
  slots: [{ id: 'found', type: 'items', label: 'Found', addUp: true }],
  enabled: true,
};

function answer(text: string) {
  mockRequest.mockImplementationOnce(() => ({ result: Promise.resolve(text), cancel: vi.fn() }));
}
const found = () => store.tasks.t1.cards?.risks?.values.found;

beforeEach(() => {
  mockRequest.mockReset();
  mockInvoke.mockReset();
  mockDiff.raw = 'diff --git a/q.ts b/q.ts\n+retry()';
  mockHook.reply = undefined;
  setStore('showCards', true);
  setStore('briefModel', 'haiku');
  setStore('cardDefinitions', [structuredClone(CARD)]);
  setStore('tasks', {
    t1: {
      id: 't1',
      name: 'Retry webhooks',
      projectId: 'p1',
      worktreePath: '/wt',
      gitIsolation: 'worktree',
      baseBranch: 'main',
      agentIds: [],
      shellAgentIds: [],
      promptHistory: [{ text: 'add retries', sentAt: 10 }],
    } as unknown as Task,
  });
});

describe('runModelCard', () => {
  it('fills the card with the default model, tagged with the turn, dated by the diff it read', async () => {
    answer('{"found":[{"text":"No backoff cap","severity":"warn"}]}');
    await runModelCard('t1', 'risks');
    expect(mockRequest).toHaveBeenCalledTimes(1);
    const options = mockRequest.mock.calls[0][0] as { purpose: string; settings: unknown };
    expect(options.purpose).toBe('card');
    expect(options.settings).toEqual(BRIEF_MODELS.haiku);
    expect(found()).toEqual({
      type: 'items',
      items: [{ text: 'No backoff cap', severity: 'warn', turn: 1 }],
    });
    expect(store.tasks.t1.cards?.risks?.fingerprint).toBe(diffFingerprint(mockDiff.raw));
  });

  it('sends nothing when no prompt went out and neither the diff nor the reply changed', async () => {
    answer('{"found":["one"]}');
    await runModelCard('t1', 'risks');
    await runModelCard('t1', 'risks');
    expect(mockRequest).toHaveBeenCalledTimes(1);
    mockDiff.raw = 'diff --git a/q.ts b/q.ts\n+retry()\n+cap()';
    answer('{"found":["two"]}');
    await runModelCard('t1', 'risks');
    expect(mockRequest).toHaveBeenCalledTimes(2);
    answer('{"found":["three"]}');
    await runModelCard('t1', 'risks', { force: true });
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });

  it('reruns only for a change in an input the card sends', async () => {
    setStore('tasks', 't1', 'agentIds', ['a1']);
    answer('{"found":["one"]}');
    await runModelCard('t1', 'risks');
    // The card sends only the diff: a new prompt and a new reply are not news to it.
    setStore('tasks', 't1', 'promptHistory', [{ text: 'cap the backoff', sentAt: Date.now() + 1 }]);
    mockHook.reply = 'Capped the backoff.';
    await runModelCard('t1', 'risks');
    expect(mockRequest).toHaveBeenCalledTimes(1);
    setStore('cardDefinitions', 0, 'source', { inputs: ['diff', 'prompts'] } as never);
    answer('{"found":["two"]}');
    await runModelCard('t1', 'risks');
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('remembers the last reply across a run that could read none', async () => {
    setStore('cardDefinitions', 0, 'source', { inputs: ['diff', 'agent-message'] } as never);
    setStore('tasks', 't1', 'agentIds', ['a1']);
    mockHook.reply = 'Added retries.';
    answer('{"found":["one"]}');
    await runModelCard('t1', 'risks');
    mockHook.reply = undefined;
    answer('{"found":["two"]}');
    await runModelCard('t1', 'risks', { force: true });
    mockHook.reply = 'Added retries.';
    await runModelCard('t1', 'risks');
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('queues one more run for a turn that ends while a run is going', async () => {
    let release: (text: string) => void = () => {};
    mockRequest.mockImplementationOnce(() => ({
      result: new Promise<string>((resolve) => (release = resolve)),
      cancel: vi.fn(),
    }));
    const first = runModelCard('t1', 'risks');
    await vi.waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
    expect(getModelCardRun('t1', 'risks').running).toBe(true);
    void runModelCard('t1', 'risks', { force: true });
    void runModelCard('t1', 'risks', { force: true });
    answer('{"found":["second"]}');
    release('{"found":["first"]}');
    await first;
    await vi.waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(JSON.stringify(found())).toContain('second'));
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('drops the values of a run whose card was edited meanwhile', async () => {
    let reply: (text: string) => void = () => {};
    mockRequest.mockImplementationOnce(() => ({
      result: new Promise<string>((resolve) => (reply = resolve)),
      cancel: vi.fn(),
    }));
    const run = runModelCard('t1', 'risks');
    await vi.waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
    saveCard({ ...structuredClone(CARD), slots: [{ id: 'note', type: 'line', label: 'Note' }] });
    reply('{"found":["old layout"]}');
    await run;
    expect(store.tasks.t1.cards?.risks).toBeUndefined();
  });

  it('keeps the values of a run when only a pin changed meanwhile', async () => {
    let reply: (text: string) => void = () => {};
    mockRequest.mockImplementationOnce(() => ({
      result: new Promise<string>((resolve) => (reply = resolve)),
      cancel: vi.fn(),
    }));
    const run = runModelCard('t1', 'risks');
    await vi.waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
    setSlotPinned('risks', 'found', true);
    reply('{"found":["kept"]}');
    await run;
    expect(found()).toEqual({
      type: 'items',
      items: [{ text: 'kept', severity: 'info', turn: 1 }],
    });
  });

  it('keeps the previous values and shows the error when the model fails', async () => {
    answer('{"found":["kept"]}');
    await runModelCard('t1', 'risks');
    mockRequest.mockImplementationOnce(() => ({
      result: Promise.reject(new Error('Rate limited')),
      cancel: vi.fn(),
    }));
    await runModelCard('t1', 'risks', { force: true });
    expect(getModelCardRun('t1', 'risks').error).toBe('Rate limited');
    expect(found()).toEqual({
      type: 'items',
      items: [{ text: 'kept', severity: 'info', turn: 1 }],
    });
  });

  it("runs the card's check first and lets the model read its output", async () => {
    setStore('cardDefinitions', 0, 'source', { ...CARD.source, checkId: 'lint' } as never);
    mockInvoke.mockResolvedValueOnce({
      run: { status: 'failed', exitCode: 1, outputTail: 'src/a.ts: no-unused-vars' },
    });
    answer('{"found":["unused var"]}');
    await runModelCard('t1', 'risks');
    expect(mockInvoke.mock.calls[0][1]).toMatchObject({
      command: 'npm run lint',
      mode: 'exit-code',
    });
    const { prompt } = mockRequest.mock.calls[0][0] as { prompt: string };
    expect(prompt).toContain('## Check "Lint": failed');
    expect(prompt).toContain('src/a.ts: no-unused-vars');
  });

  it('reruns a card with a check after a code change, though it sends no diff', async () => {
    setStore('cardDefinitions', 0, 'source', { inputs: ['task-name'], checkId: 'lint' } as never);
    mockInvoke.mockResolvedValue({ run: { status: 'passed', exitCode: 0, outputTail: '' } });
    answer('{"found":["one"]}');
    await runModelCard('t1', 'risks');
    await runModelCard('t1', 'risks');
    expect(mockRequest).toHaveBeenCalledTimes(1);
    // The check reads the code, so its output is news whenever the code is.
    mockDiff.raw = 'diff --git a/q.ts b/q.ts\n+retry()\n+cap()';
    answer('{"found":["two"]}');
    await runModelCard('t1', 'risks');
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('starts no model request when cards were turned off while its check ran', async () => {
    setStore('cardDefinitions', 0, 'source', { ...CARD.source, checkId: 'lint' } as never);
    let finishCheck: (value: unknown) => void = () => {};
    mockInvoke.mockReturnValueOnce(new Promise((resolve) => (finishCheck = resolve)));
    answer('{"found":["late"]}');
    const run = runModelCard('t1', 'risks');
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    setStore('showCards', false);
    finishCheck({ run: { status: 'passed', exitCode: 0, outputTail: '' } });
    await run;
    expect(mockRequest).not.toHaveBeenCalled();
    expect(getModelCardRun('t1', 'risks')).toEqual({});
  });
});

describe('updateModelCards', () => {
  it('runs every enabled model card on the task, even when nothing changed', async () => {
    setStore('cardDefinitions', [
      structuredClone(CARD),
      { ...structuredClone(CARD), id: 'off', enabled: false },
    ]);
    answer('{"found":["one"]}');
    await runModelCard('t1', 'risks');
    answer('{"found":["two"]}');
    updateModelCards('t1');
    // The slot adds up, so the first run's item stays below the new one.
    await vi.waitFor(() =>
      expect(found()).toMatchObject({ items: [{ text: 'two' }, { text: 'one' }] }),
    );
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('starts at most three card requests at once, leaving room for the rest of the app', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    setStore(
      'cardDefinitions',
      ids.map((id) => ({ ...structuredClone(CARD), id })),
    );
    const replies: Array<(text: string) => void> = [];
    mockRequest.mockImplementation(() => ({
      result: new Promise<string>((resolve) => replies.push(resolve)),
      cancel: vi.fn(),
    }));
    updateModelCards('t1');
    await vi.waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockRequest).toHaveBeenCalledTimes(3);
    replies[0]('{"found":["one"]}');
    await vi.waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(4));
    for (const reply of replies.slice(1)) reply('{"found":["x"]}');
    await vi.waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(6));
    for (const reply of replies.slice(4)) reply('{"found":["x"]}');
    await vi.waitFor(() =>
      expect(ids.every((id) => store.tasks.t1.cards?.[id]?.values.found)).toBe(true),
    );
  });
});
