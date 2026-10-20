import { Show, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../../electron/ipc/channels';
import { invoke } from '../../lib/ipc';
import { serializeTour } from '../../lib/tour-file';
import { startUnderstandingRequest } from '../../lib/understanding-request';
import { ThinkingSpace } from './ThinkingSpace';

vi.mock('../../lib/ipc', () => ({
  invoke: vi.fn(() => Promise.resolve()),
  Channel: class {
    onmessage = null;
    dispose = vi.fn();
  },
}));
const state = vi.hoisted(() => ({
  setMode: (_mode: 'list' | 'new' | null) => {},
  openThinkingSpace: vi.fn((mode: 'list' | 'new' | null) => state.setMode(mode)),
}));
vi.mock('../../store/store', async () => {
  const { createStore } = await import('solid-js/store');
  const [store] = createStore({ askCodeProvider: 'minimax', agentEnvFiles: {}, editorCommand: '' });
  return { store, openThinkingSpace: state.openThinkingSpace };
});
vi.mock('../../lib/understanding-request', () => ({ startUnderstandingRequest: vi.fn() }));
vi.mock('../../mindmap/MindMapEditor', () => ({ MindMapEditor: () => <div /> }));

const DIR = '/user-data/thinking';
const card = { label: '', body: 'Two laptops', tone: 'neutral' as const, refs: [] };
const saved = serializeTour(
  {
    subject: 'Why sync breaks',
    kind: 'thinking',
    roots: [{ id: 'a', card: { ...card, title: 'Why sync breaks' }, children: [] }],
  },
  { forFile: true },
);

const disposers: (() => void)[] = [];
beforeEach(() => {
  vi.mocked(invoke).mockImplementation(((channel: IPC, args?: { path?: string }) => {
    if (channel === IPC.ListThinkingTours)
      return Promise.resolve({
        dir: DIR,
        tours: [
          { path: 'why-sync-breaks.tour.md', content: saved, modifiedAt: 0 },
          { path: 'broken.tour.md', content: 'not a tour', modifiedAt: 0 },
        ],
      });
    return Promise.resolve(channel === IPC.SaveTourFile ? args?.path : undefined);
  }) as typeof invoke);
  vi.mocked(startUnderstandingRequest).mockReturnValue({
    cancel: vi.fn(),
    result: new Promise(() => {}),
  });
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function mount(mode: 'list' | 'new') {
  const host = document.createElement('div');
  document.body.append(host);
  // Closing unmounts the space, as the app does.
  // The space switches its own mode back to the list, as the store does.
  const [shown, setShown] = createSignal<'list' | 'new' | null>(mode);
  state.setMode = setShown;
  const onClose = vi.fn(() => setShown(null));
  disposers.push(
    render(
      () => (
        <Show when={shown()}>
          {(current) => <ThinkingSpace mode={current()} onClose={onClose} />}
        </Show>
      ),
      host,
    ),
  );
  return { onClose };
}

const button = (name: string) => {
  const found = [...document.querySelectorAll('button')].find((entry) =>
    entry.textContent?.includes(name),
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
};
const press = (key: string, init: KeyboardEventInit = {}) =>
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  );

describe('thinking space', () => {
  it('lists the saved thinking tours and reopens one to write on', async () => {
    mount('list');
    await flush();
    expect(document.activeElement).toBe(button('New thinking tour'));
    const rows = document.querySelectorAll('.thinking-space-list li');
    expect([...rows].map((row) => row.querySelector('.thinking-space-name')?.textContent)).toEqual([
      'Why sync breaks',
    ]);
    expect(rows[0].querySelector('.thinking-space-meta')?.textContent).toMatch(/^1 card · /);
    button('Why sync breaks').click();
    await flush();
    expect(document.querySelector('.thinking-space')).toBeNull();
    expect(document.querySelector('.understanding-card-title')?.textContent).toBe(
      'Why sync breaks',
    );
  });

  it('opens a blank tour for the shortcut and closes with it, saved in the app folder', async () => {
    const { onClose } = mount('new');
    await flush();
    expect(state.openThinkingSpace).toHaveBeenCalledWith('list');
    const title = document.querySelector<HTMLInputElement>('.thinking-card-title');
    if (!title) throw new Error('The tour did not open on a blank card');
    title.value = 'Fresh idea';
    title.dispatchEvent(new InputEvent('input', { bubbles: true }));
    press('Enter', { altKey: true });
    expect(vi.mocked(startUnderstandingRequest).mock.calls[0][0].cwd).toBe(DIR);
    press('Escape');
    press('Escape');
    await flush();
    // Escape on the tour closes it all; the list is only where tours start.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.thinking-space')).toBeNull();
    const save = vi.mocked(invoke).mock.calls.find(([channel]) => channel === IPC.SaveTourFile);
    expect(save?.[1]).toMatchObject({ worktreePath: DIR, path: 'fresh-idea.tour.md' });
  });

  it('closes a blank tour with one Escape', async () => {
    const { onClose } = mount('new');
    await flush();
    expect(document.querySelector('.thinking-card-title')).not.toBeNull();
    press('Escape');
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.understanding-dialog')).toBeNull();
  });

  it('opens above every other dialog, as the shortcut works over them', async () => {
    mount('list');
    await flush();
    const layers = [...document.querySelectorAll<HTMLElement>('.dialog-overlay')].map((overlay) =>
      Number(overlay.style.zIndex),
    );
    // A task's tour sits at 1450; the space is opened over it.
    expect(Math.min(...layers)).toBeGreaterThan(1450);
    button('New thinking tour').click();
    await flush();
    const tour = document
      .querySelector('.understanding-dialog')
      ?.closest<HTMLElement>('.dialog-overlay');
    expect(Number(tour?.style.zIndex)).toBeGreaterThan(1450);
  });
});
