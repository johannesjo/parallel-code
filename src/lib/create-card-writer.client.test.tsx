import { createRoot } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCardWriter } from './create-card-writer';
import type { TourNode } from './tour-tree';
import {
  startUnderstandingRequest,
  type UnderstandingRequestResult,
} from './understanding-request';

vi.mock('./understanding-request', () => ({ startUnderstandingRequest: vi.fn() }));

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.clearAllMocks();
});

function setup() {
  let writer: ReturnType<typeof createCardWriter> | undefined;
  disposers.push(
    createRoot((dispose) => {
      writer = createCardWriter();
      return dispose;
    }),
  );
  if (!writer) throw new Error('Writer was not created');
  return writer;
}

/** Hands each request a result the test settles. */
function respond(): (result: UnderstandingRequestResult) => void {
  let settle: (result: UnderstandingRequestResult) => void = () => {};
  const result = new Promise<UnderstandingRequestResult>((resolve) => (settle = resolve));
  vi.mocked(startUnderstandingRequest).mockReturnValueOnce({ result, cancel: vi.fn() });
  return (outcome) => settle(outcome);
}

const roots: TourNode[] = [
  {
    id: 'c1',
    card: { label: '', title: 'notes', body: 'a b', tone: 'neutral', refs: [] },
    children: [],
  },
];
const ANSWER = JSON.stringify({
  cards: [{ label: 'X', title: 'Written', points: ['a', 'b'], tone: 'neutral' }],
});

describe('card writer', () => {
  it('proposes the written card without touching the notes', async () => {
    const writer = setup();
    const settle = respond();
    const done = writer.write({ roots, nodeId: 'c1', cwd: '/repo' });
    expect(writer.writingId()).toBe('c1');
    settle({ status: 'done', text: ANSWER });
    await done;
    expect(writer.writingId()).toBe('');
    expect(writer.proposal()?.cards[0].title).toBe('Written');
    expect(vi.mocked(startUnderstandingRequest).mock.calls[0][0].prompt).toContain('a b');
    writer.dismiss();
    expect(writer.proposal()).toBeNull();
  });

  it('drops an answer that arrives after a cancel', async () => {
    const writer = setup();
    const settle = respond();
    const done = writer.write({ roots, nodeId: 'c1', cwd: '/repo' });
    writer.cancel();
    settle({ status: 'done', text: ANSWER });
    await done;
    expect(writer.proposal()).toBeNull();
    expect(writer.writingId()).toBe('');
  });

  it('reports a failed or unreadable answer', async () => {
    const writer = setup();
    const settle = respond();
    const done = writer.write({ roots, nodeId: 'c1', cwd: '/repo' });
    settle({ status: 'done', text: 'not json' });
    await done;
    expect(writer.error('c1')).toMatch(/^Could not write the card/);
    expect(writer.error('c2')).toBe('');
    expect(writer.proposal()).toBeNull();
  });
});
