import { createRoot } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../electron/ipc/channels';
import { createUnderstandingTour } from './create-understanding-tour';
import { invoke } from './ipc';
import { parseTourFile } from './tour-file';
import { insertAfter, insertChild, replaceCard } from './tour-tree-edit';
import type { TourNode } from './tour-tree';

vi.mock('./ipc', () => ({
  invoke: vi.fn(() => Promise.resolve()),
  Channel: class {
    onmessage = null;
    dispose = vi.fn();
  },
}));
vi.mock('../store/store', async () => {
  const { createStore } = await import('solid-js/store');
  const [store] = createStore({ askCodeProvider: 'minimax', agentEnvFiles: {} });
  return { store };
});

const disposers: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockImplementation(((channel: IPC, args?: { path?: string }) =>
    Promise.resolve(channel === IPC.SaveTourFile ? args?.path : undefined)) as typeof invoke);
});
afterEach(async () => {
  disposers.splice(0).forEach((dispose) => dispose());
  // Disposing writes what was typed last; let it land before the next test counts saves.
  await flush();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function setup() {
  let controller: ReturnType<typeof createUnderstandingTour> | undefined;
  disposers.push(
    createRoot((dispose) => {
      controller = createUnderstandingTour();
      return dispose;
    }),
  );
  if (!controller) throw new Error('Controller was not created');
  controller.startThinking({ worktreePath: '/repo', taskName: 'Task' });
  return controller;
}

const saves = () =>
  vi.mocked(invoke).mock.calls.filter(([channel]) => channel === IPC.SaveTourFile);

function written(tour: ReturnType<typeof setup>, id: string, title: string, body = ''): TourNode[] {
  return replaceCard(tour.tree(), id, { ...tour.tree()[0].card, title, body });
}

function blank(id: string): TourNode {
  return { id, card: { label: '', title: '', body: '', tone: 'neutral', refs: [] }, children: [] };
}

describe('thinking tours', () => {
  it('opens on one blank card and saves nothing until it has text', async () => {
    const tour = setup();
    expect(tour.thinking()).toBe(true);
    expect(tour.tree()).toHaveLength(1);
    const first = tour.currentId();
    tour.edit(tour.tree());
    vi.advanceTimersByTime(1000);
    await flush();
    expect(saves()).toHaveLength(0);

    tour.edit(written(tour, first, 'Why sync breaks', 'Two clocks'));
    expect(tour.subject()).toBe('Why sync breaks');
    vi.advanceTimersByTime(1000);
    await flush();
    expect(saves()).toHaveLength(1);
    expect(saves()[0][1]).toMatchObject({ path: 'why-sync-breaks.tour.md', replace: false });
    const file = parseTourFile(String(saves()[0][1]?.content));
    expect(file?.kind).toBe('thinking');
    expect(file?.roots[0].card.body).toBe('Two clocks');
  });

  it('saves once per pause in typing, then replaces its file', async () => {
    const tour = setup();
    const id = tour.currentId();
    tour.edit(written(tour, id, 'A'));
    vi.advanceTimersByTime(1000);
    await flush();
    tour.edit(written(tour, id, 'Ab'));
    tour.edit(written(tour, id, 'Abc'));
    vi.advanceTimersByTime(100);
    await flush();
    expect(saves()).toHaveLength(1);
    // Waiting for a pause is not a failed save, so it must not offer a retry.
    expect(tour.unsaved()).toBe(false);
    vi.advanceTimersByTime(1000);
    await flush();
    expect(saves()).toHaveLength(2);
    expect(saves()[1][1]).toMatchObject({ path: 'a.tour.md', replace: true });
    expect(String(saves()[1][1]?.content)).toContain('Abc');
  });

  it('keeps the last saved version of a tour emptied again', async () => {
    const tour = setup();
    const id = tour.currentId();
    tour.edit(written(tour, id, 'A'));
    vi.advanceTimersByTime(1000);
    await flush();
    expect(saves()).toHaveLength(1);
    // A file with no cards would not open again, and the list would drop it.
    tour.edit(written(tour, id, ''));
    vi.advanceTimersByTime(1000);
    await flush();
    expect(saves()).toHaveLength(1);
  });

  it('writes pending edits before another tour takes the screen', async () => {
    const tour = setup();
    tour.edit(written(tour, tour.currentId(), 'Kept'));
    tour.startThinking({ worktreePath: '/repo', taskName: 'Task' });
    await flush();
    expect(saves()).toHaveLength(1);
    expect(String(saves()[0][1]?.content)).toContain('Kept');
    expect(tour.tree()[0].card.title).toBe('');
  });

  it('drops a blank card and shows the card before it', () => {
    const tour = setup();
    const first = tour.currentId();
    tour.edit(insertChild(written(tour, first, 'One'), first, blank('c2')), 'c2');
    tour.edit(insertAfter(tour.tree(), first, blank('c3')), 'c3');
    tour.dropIfBlank('c3');
    expect(tour.tree().map((node) => node.id)).toEqual([first]);
    expect(tour.currentId()).toBe(first);
    tour.select('c2');
    tour.dropIfBlank('c2');
    expect(tour.tree()[0].children).toEqual([]);
    expect(tour.currentId()).toBe(first);
    // The last card stays, blank or not, to write on.
    tour.edit(written(tour, first, ''));
    tour.dropIfBlank(first);
    expect(tour.tree()).toHaveLength(1);
  });

  it('keeps the reader on the card they moved to when the blank one they left is dropped', () => {
    const tour = setup();
    const first = tour.currentId();
    tour.edit(insertAfter(written(tour, first, 'One'), first, blank('c2')), 'c2');
    tour.edit(
      insertAfter(tour.tree(), 'c2', {
        ...blank('c3'),
        card: { ...blank('c3').card, title: 'Three' },
      }),
    );
    tour.select('c3');
    tour.dropIfBlank('c2');
    expect(tour.tree().map((node) => node.id)).toEqual([first, 'c3']);
    expect(tour.currentId()).toBe('c3');
  });

  it('reopens a saved thinking tour as one the reader writes', async () => {
    const tour = setup();
    tour.edit(written(tour, tour.currentId(), 'Saved idea', 'Body'));
    vi.advanceTimersByTime(1000);
    await flush();
    const text = String(saves()[0][1]?.content);
    const file = parseTourFile(text);
    if (!file) throw new Error('The saved tour did not parse');
    await tour.restore({
      file,
      text,
      savedPath: 'x.tour.md',
      worktreePath: '/repo',
      taskName: 'T',
    });
    expect(tour.thinking()).toBe(true);
    expect(tour.tree()[0].card.title).toBe('Saved idea');
  });

  it('ignores edits on a generated tour', () => {
    const tour = setup();
    tour.publish({
      subject: 'S',
      tour: { subject: 'S', kind: 'agent', cards: [{ ...blank('x').card, title: 'G' }] },
      context: '',
      worktreePath: '/repo',
    });
    expect(tour.thinking()).toBe(false);
    tour.edit([]);
    expect(tour.tree()).toHaveLength(1);
  });
});
