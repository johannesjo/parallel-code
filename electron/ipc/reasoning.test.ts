import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import {
  appendReasoningUpdate,
  prepareReasoningFeed,
  readReasoningFeed,
  removeReasoningFeeds,
} from './reasoning.js';
import { parseReasoningFeed } from '../shared/reasoning-feed.js';
import type { ReasoningUpdate } from '../shared/reasoning-state.js';
import { reasoningFeedPath, REASONING_MAX_BYTES } from '../shared/reasoning.js';
import { MAX_COORDINATOR_CONCURRENT_TASKS } from '../shared/coordinator-limits.js';

const { appendGitInfoExcludeBlock, replayed } = vi.hoisted(() => ({
  appendGitInfoExcludeBlock: vi.fn(() => 'appended' as const),
  /** Updates each parse had to re-derive, i.e. the history it could not carry over. */
  replayed: [] as number[],
}));
vi.mock('./git-exclude.js', () => ({ appendGitInfoExcludeBlock }));
vi.mock('../shared/reasoning-feed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/reasoning-feed.js')>();
  return {
    ...actual,
    parseReasoningFeed: (
      raw: string,
      previous?: Parameters<typeof actual.parseReasoningFeed>[1],
    ) => {
      const result = actual.parseReasoningFeed(raw, previous);
      replayed.push(result.history.updates.length - (previous?.updates.length ?? 0));
      return result;
    },
  };
});
const roots: string[] = [];
const root = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-'));
  roots.push(dir);
  return dir;
};
afterEach(() => roots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
/** The text of a feed, or null when absent; stamps are exercised separately. */
async function read(worktreePath: string, taskId = 'task', agentId = 'agent') {
  const result = await readReasoningFeed({ worktreePath, taskId, agentId });
  // Without a known stamp the read is never `unchanged`.
  return result && 'raw' in result ? result.raw : null;
}

const initial: ReasoningUpdate = {
  runId: null,
  newRunId: 'run',
  expectedRevision: 0,
  caption: 'Start',
  activeId: 'goal',
  operations: [
    {
      type: 'insert',
      node: { id: 'goal', kind: 'goal', status: 'unresolved', title: 'Investigate', detail: '' },
    },
  ],
};
it('serializes user and agent writes, rejects stale edits and preserves failed bytes', async () => {
  const dir = root();
  const first = appendReasoningUpdate(dir, 'task', 'agent', initial);
  const user = {
    runId: 'run',
    expectedRevision: first.revision,
    operations: [{ type: 'update' as const, id: 'goal', changes: { title: 'User goal' } }],
  };
  const saved = appendReasoningUpdate(dir, 'task', 'agent', user, 'user');
  const raw = await read(dir);
  expect(saved).toMatchObject({ revision: 2, activeId: 'goal', caption: 'Start' });
  expect(() => appendReasoningUpdate(dir, 'task', 'agent', user)).toThrow('revision');
  expect(() =>
    appendReasoningUpdate(dir, 'task', 'agent', {
      ...user,
      expectedRevision: 2,
      operations: [{ type: 'update', id: 'goal', changes: { title: 'Agent overwrite' } }],
    }),
  ).toThrow('protected');
  expect(await read(dir)).toBe(raw);
  const next = appendReasoningUpdate(dir, 'task', 'agent', {
    runId: 'run',
    expectedRevision: 2,
    operations: [{ type: 'update', id: 'goal', changes: { detail: 'New evidence' } }],
  });
  expect(next.records[0]).toMatchObject({
    title: 'User goal',
    detail: 'New evidence',
    userEdited: ['title'],
  });
  const parsed = parseReasoningFeed((await read(dir)) ?? '');
  expect(parsed.history.updates.map((event) => event.actor)).toEqual(['agent', 'user', 'agent']);
  expect(parsed.history.snapshots[2]).toEqual(next);
});
it('checks the old revision when starting a new run', async () => {
  const dir = root();
  appendReasoningUpdate(dir, 'task', 'agent', initial);
  const reset = { ...initial, runId: 'run', newRunId: 'new', expectedRevision: 1 };
  appendReasoningUpdate(
    dir,
    'task',
    'agent',
    { runId: 'run', expectedRevision: 1, operations: [] },
    'user',
  );
  const raw = await read(dir);
  expect(() => appendReasoningUpdate(dir, 'task', 'agent', reset)).toThrow('revision');
  expect(() =>
    appendReasoningUpdate(dir, 'task', 'agent', { ...reset, expectedRevision: 2, newRunId: 'run' }),
  ).toThrow('new stable');
  expect(await read(dir)).toBe(raw);
  appendReasoningUpdate(dir, 'task', 'agent', { ...reset, expectedRevision: 2 });
  const parsed = parseReasoningFeed((await read(dir)) ?? '');
  expect(parsed.history.updates[0].runId).toBe('new');
  expect(parsed.history.snapshots[0].revision).toBe(1);
});
it('rejects invalid graph commands and authority fields before filesystem side effects', () => {
  const dir = root();
  expect(() =>
    appendReasoningUpdate(dir, 'task', 'agent', { ...initial, actor: 'user' }),
  ).toThrow();
  expect(fs.existsSync(path.join(dir, '.parallel-code'))).toBe(false);
  appendReasoningUpdate(dir, 'task', 'agent', initial);
  expect(() =>
    appendReasoningUpdate(dir, 'task', 'agent', {
      runId: 'run',
      expectedRevision: 1,
      operations: [
        {
          type: 'insert',
          node: {
            id: 'bad',
            parent: 'absent',
            title: 'Bad',
            detail: '',
            kind: 'goal',
            status: 'unresolved',
          },
        },
      ],
    }),
  ).toThrow();
});
it('checks the resulting byte size before writing', async () => {
  const dir = root();
  appendReasoningUpdate(dir, 'task', 'agent', initial);
  const target = path.join(dir, reasoningFeedPath('task', 'agent'));
  const raw = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(
    target,
    raw.trimEnd() + ' '.repeat(REASONING_MAX_BYTES - Buffer.byteLength(raw)) + '\n',
  );
  const before = fs.readFileSync(target, 'utf8');
  expect(() =>
    appendReasoningUpdate(dir, 'task', 'agent', {
      runId: 'run',
      expectedRevision: 1,
      operations: [],
      caption: 'Next',
    }),
  ).toThrow('full');
  expect(fs.readFileSync(target, 'utf8')).toBe(before);
});

it('excludes the report directory from Git once per worktree, not on every append', () => {
  const dir = root(),
    other = root();
  appendGitInfoExcludeBlock.mockClear();
  appendReasoningUpdate(dir, 'task', 'agent', initial);
  expect(appendGitInfoExcludeBlock).toHaveBeenCalledTimes(1);
  appendReasoningUpdate(dir, 'task', 'agent', {
    runId: 'run',
    expectedRevision: 1,
    operations: [{ type: 'update', id: 'goal', changes: { detail: 'More' } }],
  });
  appendReasoningUpdate(dir, 'other-task', 'agent', initial);
  expect(appendGitInfoExcludeBlock).toHaveBeenCalledTimes(1);
  appendReasoningUpdate(other, 'task', 'agent', initial);
  expect(appendGitInfoExcludeBlock).toHaveBeenCalledTimes(2);
  expect(appendGitInfoExcludeBlock).toHaveBeenLastCalledWith(
    other,
    '/.parallel-code/reasoning/',
    '/.parallel-code/reasoning/\n',
  );
});

it('retries the Git exclude on the next append after a failure', () => {
  const dir = root();
  appendGitInfoExcludeBlock.mockClear();
  appendGitInfoExcludeBlock.mockReturnValueOnce('failed' as never);
  expect(() => appendReasoningUpdate(dir, 'task', 'agent', initial)).toThrow('exclude');
  appendReasoningUpdate(dir, 'task', 'agent', initial);
  expect(appendGitInfoExcludeBlock).toHaveBeenCalledTimes(2);
});

it('isolates each task and agent and reads a feed created after the panel opens', async () => {
  const dir = root();
  expect(await read(dir)).toBeNull();
  prepareReasoningFeed(dir, 'task', 'agent');
  fs.writeFileSync(path.join(dir, reasoningFeedPath('task', 'agent')), 'reported\n');
  expect(await read(dir)).toBe('reported\n');
  expect(await read(dir, 'task2')).toBeNull();
  expect(await read(dir, 'task', 'agent2')).toBeNull();
});

it('rejects traversal, symlinked directories and files, and oversized input', async () => {
  const dir = root(),
    outside = root();
  expect(() => prepareReasoningFeed(dir, '../task', 'agent')).toThrow();
  fs.symlinkSync(outside, path.join(dir, '.parallel-code'));
  await expect(read(dir)).rejects.toThrow(/symbolic/i);
  expect(() => prepareReasoningFeed(dir, 'task', 'agent')).toThrow(/symbolic/i);
  fs.unlinkSync(path.join(dir, '.parallel-code'));
  prepareReasoningFeed(dir, 'task', 'agent');
  const target = path.join(dir, reasoningFeedPath('task', 'agent'));
  const external = path.join(outside, 'data');
  fs.writeFileSync(external, 'do not read');
  fs.symlinkSync(external, target);
  await expect(read(dir)).rejects.toThrow();
  fs.unlinkSync(target);
  fs.writeFileSync(target, Buffer.alloc(REASONING_MAX_BYTES + 1));
  await expect(read(dir)).rejects.toThrow(/large/i);
});

it.each(['symlink', 'directory', 'fifo'])(
  'rejects an existing %s report before connecting',
  (kind) => {
    const dir = root();
    prepareReasoningFeed(dir, 'task', 'agent');
    const target = path.join(dir, reasoningFeedPath('task', 'agent'));
    const external = path.join(root(), 'data');
    fs.writeFileSync(external, 'untouched');
    if (kind === 'symlink') fs.symlinkSync(external, target);
    if (kind === 'directory') fs.mkdirSync(target);
    if (kind === 'fifo') execFileSync('mkfifo', [target]);
    expect(() => prepareReasoningFeed(dir, 'task', 'agent')).toThrow(/regular file/);
    expect(fs.readFileSync(external, 'utf8')).toBe('untouched');
  },
);

it('preserves an existing regular report during reconnection', () => {
  const dir = root();
  prepareReasoningFeed(dir, 'task', 'agent');
  const target = path.join(dir, reasoningFeedPath('task', 'agent'));
  fs.writeFileSync(target, 'reported\n');
  prepareReasoningFeed(dir, 'task', 'agent');
  expect(fs.readFileSync(target, 'utf8')).toBe('reported\n');
});

it('archives a stuck graph only on an explicit revision-checked fresh run', async () => {
  const dir = root();
  appendReasoningUpdate(dir, 'task', 'agent', initial);
  const target = path.join(dir, reasoningFeedPath('task', 'agent'));
  const stuck = (await read(dir)) + '{partial';
  fs.writeFileSync(target, stuck);
  expect(() =>
    appendReasoningUpdate(dir, 'task', 'agent', {
      runId: 'run',
      expectedRevision: 1,
      operations: [],
    }),
  ).toThrow('newRunId');
  appendReasoningUpdate(dir, 'task', 'agent', {
    ...initial,
    runId: 'run',
    newRunId: 'second',
    expectedRevision: 1,
  });
  const parsed = parseReasoningFeed((await read(dir)) ?? '');
  expect(parsed.history.updates[0].runId).toBe('second');
  const archived = fs
    .readdirSync(path.dirname(target))
    .filter((name) => name.startsWith('agent.jsonl.'));
  expect(archived).toHaveLength(1);
  expect(fs.readFileSync(path.join(path.dirname(target), archived[0]), 'utf8')).toBe(stuck);
});

/** Grow a feed one update at a time, as an agent does; returns the last revision. */
function appendRun(dir: string, count: number, from: number): number {
  let revision = from;
  for (let i = 0; i < count; i++)
    revision = appendReasoningUpdate(dir, 'task', 'agent', {
      runId: 'run',
      expectedRevision: revision,
      operations: [{ type: 'update', id: 'goal', changes: { title: `Step ${i}` } }],
    }).revision;
  return revision;
}

/** Insert `count` children of the central topic; the graph cost per replayed update. */
function growGraph(dir: string, count: number, from: number): number {
  let revision = from;
  for (let i = 0; i < count; i++)
    revision = appendReasoningUpdate(dir, 'task', 'agent', {
      runId: 'run',
      expectedRevision: revision,
      operations: [
        {
          type: 'insert',
          node: {
            id: `n${i}`,
            parent: 'goal',
            kind: 'observation',
            status: 'observed',
            title: `Observation number ${i}`,
            detail: 'Some detail text, so the graph is a realistic size to clone.',
          },
        },
      ],
    }).revision;
  return revision;
}

it('keeps one append cheap however long the history is', async () => {
  const dir = root();
  let revision = appendReasoningUpdate(dir, 'task', 'agent', initial).revision;
  revision = growGraph(dir, 40, revision);
  revision = appendRun(dir, 40, revision);
  // A feed this process never appended to carries no history, so its first append replays
  // every line — the O(history × graph) cost that each append used to pay. Counting replayed
  // updates rather than milliseconds keeps the test honest on a loaded machine, and lets the
  // fixture stay small: the graph size only ever changed how slow the replay was, not whether
  // it happened.
  const cold = root();
  const copy = path.join(cold, reasoningFeedPath('task', 'agent'));
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(path.join(dir, reasoningFeedPath('task', 'agent')), copy);
  const last: ReasoningUpdate = {
    runId: 'run',
    expectedRevision: revision,
    operations: [{ type: 'update', id: 'goal', changes: { title: 'Last' } }],
  };
  replayed.length = 0;
  appendReasoningUpdate(cold, 'task', 'agent', last);
  const appended = appendReasoningUpdate(dir, 'task', 'agent', last);
  expect(appended.revision).toBe(revision + 1);
  // The cold append re-derives every stored update; the warm one resumes from them and
  // replays only the line it just wrote.
  expect(replayed).toEqual([revision, 0]);
  const parsed = parseReasoningFeed((await read(dir)) ?? '');
  expect(parsed.error).toBeUndefined();
  expect(parsed.history.updates).toHaveLength(revision + 1);
});

it('keeps every feed of a full coordinator run warm, not just the last one appended to', () => {
  // A coordinator run drives one feed per concurrent subtask plus its own, and they interleave:
  // each agent appends in turn. A cache that cannot hold them all evicts each feed before its
  // next turn, so every append replays the whole history — the exact cost the cache exists to
  // avoid, paid on every write instead of none. Size the fixture at the concurrency ceiling the
  // coordinator actually allows.
  const dir = root();
  const agents = Array.from(
    { length: MAX_COORDINATOR_CONCURRENT_TASKS + 1 },
    (_, i) => `agent-${i}`,
  );
  const revisions = new Map(
    agents.map((agent) => [agent, appendReasoningUpdate(dir, 'task', agent, initial).revision]),
  );
  const round = () => {
    for (const agent of agents)
      revisions.set(
        agent,
        appendReasoningUpdate(dir, 'task', agent, {
          runId: 'run',
          expectedRevision: revisions.get(agent),
          operations: [{ type: 'update', id: 'goal', changes: { title: `by ${agent}` } }],
        }).revision,
      );
  };
  round();
  replayed.length = 0;
  round();
  // Every feed resumed from the history the previous round left cached, replaying only the line
  // it just wrote. A non-zero entry here is a feed that was evicted between its own turns.
  expect(replayed).toEqual(agents.map(() => 0));
});

it('re-reads a feed that changed outside the append path', async () => {
  const dir = root();
  const target = path.join(dir, reasoningFeedPath('task', 'agent'));
  const first = appendReasoningUpdate(dir, 'task', 'agent', initial).revision;
  const second = appendRun(dir, 2, first);
  const full = fs.readFileSync(target, 'utf8');
  // Roll the feed back to its first line; a carried-forward history must not be trusted.
  fs.writeFileSync(target, full.split('\n').slice(0, 1).join('\n') + '\n');
  expect(() =>
    appendReasoningUpdate(dir, 'task', 'agent', {
      runId: 'run',
      expectedRevision: second,
      operations: [],
    }),
  ).toThrow('revision');
  const resumed = appendReasoningUpdate(dir, 'task', 'agent', {
    runId: 'run',
    expectedRevision: first,
    operations: [],
  });
  expect(resumed.revision).toBe(first + 1);
  const parsed = parseReasoningFeed((await read(dir)) ?? '');
  expect(parsed.error).toBeUndefined();
  expect(parsed.history.updates).toHaveLength(2);
});

it('reports an unchanged feed by stamp and a new stamp after an append or rotation', async () => {
  const dir = root();
  appendReasoningUpdate(dir, 'task', 'agent', initial);
  const feed = { worktreePath: dir, taskId: 'task', agentId: 'agent' };
  const first = await readReasoningFeed(feed);
  if (!first || !('raw' in first)) throw new Error('expected a full read');
  expect(await readReasoningFeed(feed, first.stamp)).toEqual({
    unchanged: true,
    stamp: first.stamp,
  });
  appendReasoningUpdate(dir, 'task', 'agent', {
    runId: 'run',
    expectedRevision: 1,
    operations: [{ type: 'update', id: 'goal', changes: { title: 'Investigate more' } }],
  });
  const second = await readReasoningFeed(feed, first.stamp);
  if (!second || !('raw' in second)) throw new Error('expected a full read after the append');
  expect(second.stamp).not.toBe(first.stamp);
  expect(second.raw.split('\n').filter(Boolean)).toHaveLength(2);
  const file = path.join(dir, reasoningFeedPath('task', 'agent'));
  fs.rmSync(file);
  fs.writeFileSync(file, second.raw);
  const rewritten = await readReasoningFeed(feed, second.stamp);
  expect(rewritten && 'raw' in rewritten).toBe(true);
  fs.rmSync(file);
  fs.symlinkSync(path.join(dir, 'elsewhere'), file);
  await expect(readReasoningFeed(feed, second.stamp)).rejects.toThrow();
});

it('removes only a real report directory of the task', () => {
  const dir = root(),
    outside = root();
  appendReasoningUpdate(dir, 'task', 'agent', initial);
  appendReasoningUpdate(dir, 'other', 'agent', initial);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, path.join(dir, '.parallel-code', 'reasoning', 'task', 'link'));
  removeReasoningFeeds(dir, 'task');
  expect(fs.existsSync(path.join(dir, '.parallel-code', 'reasoning', 'task'))).toBe(false);
  expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  expect(fs.existsSync(path.join(dir, reasoningFeedPath('other', 'agent')))).toBe(true);
  removeReasoningFeeds(dir, 'missing');
  fs.symlinkSync(outside, path.join(dir, '.parallel-code', 'reasoning', 'linked'));
  expect(() => removeReasoningFeeds(dir, 'linked')).toThrow(/symbolic links/);
  expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
  expect(() => removeReasoningFeeds(dir, '../task')).toThrow();
});

it('does not delete through a linked parent directory', () => {
  const dir = root();
  const victim = root();
  fs.mkdirSync(path.join(victim, 'reasoning', 'task'), { recursive: true });
  fs.writeFileSync(path.join(victim, 'reasoning', 'task', 'agent.jsonl'), 'keep');
  fs.symlinkSync(victim, path.join(dir, '.parallel-code'));
  expect(() => removeReasoningFeeds(dir, 'task')).toThrow(/symbolic links/);
  expect(fs.existsSync(path.join(victim, 'reasoning', 'task', 'agent.jsonl'))).toBe(true);
});
