import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import type { ReasoningFeedRead } from '../../electron/shared/reasoning';
import { invoke } from '../lib/ipc';
import { notifyReasoningFeedChanged } from '../store/reasoning-activity';
import { makeFixture } from './fixture';
import { createReasoningFeed } from './live-feed';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));

const source = { taskId: 'task', agentId: 'agent', worktreePath: '/task' };
const encode = (count: number) =>
  makeFixture()
    .updates.slice(0, count)
    .map((u) => JSON.stringify(u))
    .join('\n') + '\n';
let dispose: (() => void) | undefined;
let reads: Array<string | undefined>;
let file: { raw: string; stamp: string } | null;

beforeEach(() => {
  vi.useFakeTimers();
  reads = [];
  file = { raw: encode(1), stamp: 'a' };
  vi.mocked(invoke).mockImplementation(
    async (_channel, args): Promise<ReasoningFeedRead | null> => {
      const { knownStamp } = args as { knownStamp?: string };
      reads.push(knownStamp);
      if (!file) return null;
      return knownStamp === file.stamp ? { unchanged: true, stamp: file.stamp } : file;
    },
  );
});
afterEach(() => {
  dispose?.();
  vi.useRealTimers();
});

function mount() {
  const [visible, setVisible] = createSignal(true);
  let feed!: ReturnType<typeof createReasoningFeed>;
  dispose = render(() => {
    feed = createReasoningFeed(() => source, visible);
    return null;
  }, document.body);
  return { feed, setVisible };
}

it('polls with the last stamp so an unchanged feed is not re-read, and re-reads on change', async () => {
  const { feed } = mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(feed.snapshot()?.revision).toBe(1);
  expect(feed.updatedAt()).toBe(Date.now());
  const seenAt = feed.updatedAt();
  await vi.advanceTimersByTimeAsync(2000);
  expect(reads).toEqual([undefined, 'a', 'a']);
  expect(feed.updatedAt()).toBe(seenAt);
  file = { raw: encode(2), stamp: 'b' };
  await vi.advanceTimersByTimeAsync(1000);
  expect(feed.snapshot()?.revision).toBe(2);
  expect(feed.caption()).toBe(makeFixture().updates[1].caption);
  expect(reads.at(-1)).toBe('a');
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads.at(-1)).toBe('b');
  expect(vi.mocked(invoke).mock.calls.every(([channel]) => channel === IPC.ReadReasoningFeed)).toBe(
    true,
  );
});

it('treats the first read of each polling session as catch-up and later updates as live', async () => {
  const { feed, setVisible } = mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(feed.updates()).toHaveLength(1);
  expect(feed.jumpableFrom()).toBe(1);
  file = { raw: encode(2), stamp: 'b' };
  await vi.advanceTimersByTimeAsync(1000);
  expect(feed.updates()).toHaveLength(2);
  expect(feed.jumpableFrom()).toBe(1);
  setVisible(false);
  file = { raw: encode(3), stamp: 'c' };
  setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(feed.updates()).toHaveLength(3);
  expect(feed.jumpableFrom()).toBe(3);
});

it('re-reads at once after a write from this renderer and coalesces overlapping refreshes', async () => {
  const { feed } = mount();
  await vi.advanceTimersByTimeAsync(0);
  file = { raw: encode(2), stamp: 'b' };
  notifyReasoningFeedChanged('other-task');
  await vi.advanceTimersByTimeAsync(0);
  expect(feed.snapshot()?.revision).toBe(1);
  notifyReasoningFeedChanged('task');
  await vi.advanceTimersByTimeAsync(0);
  expect(feed.snapshot()?.revision).toBe(2);
  const before = reads.length;
  file = { raw: encode(3), stamp: 'c' };
  const first = feed.refresh();
  const second = feed.refresh();
  await Promise.all([first, second]);
  expect(feed.snapshot()?.revision).toBe(3);
  expect(reads.length - before).toBeLessThanOrEqual(2);
});

it('stops reading while hidden and resolves refresh without a source', async () => {
  const { feed, setVisible } = mount();
  await vi.advanceTimersByTimeAsync(0);
  setVisible(false);
  const before = reads.length;
  await vi.advanceTimersByTimeAsync(3000);
  await feed.refresh();
  expect(reads.length).toBe(before);
  expect(feed.snapshot()?.revision).toBe(1);
});
