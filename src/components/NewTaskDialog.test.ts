import { describe, expect, it } from 'vitest';
import { scrollCoordinatorIntoView } from './scrollCoordinatorIntoView';
import {
  createSymlinkCandidateState,
  shouldProbeSymlinkCandidates,
  symlinkProbeBlocksSubmit,
} from '../lib/symlink-candidates';
import type { GitIgnoredEntry } from '../ipc/types';

interface FakeScrollContainer {
  scrollTop: number;
  readonly scrollHeight: number;
}

function fakeContainer(scrollHeight: number): FakeScrollContainer {
  return { scrollTop: 0, scrollHeight };
}

describe('scrollCoordinatorIntoView', () => {
  it('scrolls to scrollHeight when coordinator mode is enabled', () => {
    const el = fakeContainer(800);
    scrollCoordinatorIntoView(true, el);
    expect(el.scrollTop).toBe(800);
  });

  it('does not scroll when coordinator mode is disabled', () => {
    const el = fakeContainer(800);
    scrollCoordinatorIntoView(false, el);
    expect(el.scrollTop).toBe(0);
  });

  it('does not throw when the container ref is null (not yet mounted)', () => {
    expect(() => scrollCoordinatorIntoView(true, null)).not.toThrow();
  });

  it('does not throw when the container ref is undefined', () => {
    expect(() => scrollCoordinatorIntoView(true, undefined)).not.toThrow();
  });

  it('scrolls to the exact scrollHeight value, not a fixed offset', () => {
    const el = fakeContainer(1234);
    scrollCoordinatorIntoView(true, el);
    expect(el.scrollTop).toBe(1234);
  });

  it('is idempotent — calling again when already scrolled to bottom is harmless', () => {
    const el = fakeContainer(800);
    el.scrollTop = 800;
    scrollCoordinatorIntoView(true, el);
    expect(el.scrollTop).toBe(800);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const PROJECT_A_ENTRIES: GitIgnoredEntry[] = [
  { name: 'node_modules', isDefault: true },
  { name: 'dist', isDefault: false },
];
const PROJECT_B_ENTRIES: GitIgnoredEntry[] = [{ name: '.env', isDefault: true }];

describe('createSymlinkCandidateState', () => {
  it('loads candidates and selects the defaults', async () => {
    const state = createSymlinkCandidateState(async () => PROJECT_A_ENTRIES);

    await state.load('/project-a', true);

    expect(state.dirs()).toEqual(['node_modules', 'dist']);
    expect([...state.selected()]).toEqual(['node_modules']);
    expect(state.loading()).toBe(false);
  });

  it('resets the selection to defaults when reloaded (cancel → reopen)', async () => {
    const state = createSymlinkCandidateState(async () => PROJECT_A_ENTRIES);
    await state.load('/project-a', true);
    state.toggle('dist');
    expect(state.selected().has('dist')).toBe(true);

    await state.load('/project-a', true);

    expect(state.selected().has('dist')).toBe(false);
    expect([...state.selected()]).toEqual(['node_modules']);
  });

  it('clears dirs and selection up front, before the fetch resolves', async () => {
    const pending = deferred<GitIgnoredEntry[]>();
    let calls = 0;
    const state = createSymlinkCandidateState(() =>
      calls++ === 0 ? Promise.resolve(PROJECT_A_ENTRIES) : pending.promise,
    );
    await state.load('/project-a', true);
    state.toggle('dist');

    const loadPromise = state.load('/project-b', true);

    expect(state.dirs()).toEqual([]);
    expect(state.selected().size).toBe(0);
    expect(state.loading()).toBe(true);
    pending.resolve(PROJECT_B_ENTRIES);
    await loadPromise;
    expect(state.dirs()).toEqual(['.env']);
  });

  it('drops a stale response from a previous project instead of overwriting state', async () => {
    const slowA = deferred<GitIgnoredEntry[]>();
    const state = createSymlinkCandidateState((projectRoot) =>
      projectRoot === '/project-a' ? slowA.promise : Promise.resolve(PROJECT_B_ENTRIES),
    );

    const staleLoad = state.load('/project-a', true);
    expect(state.loading()).toBe(true);
    await state.load('/project-b', true);
    expect(state.dirs()).toEqual(['.env']);

    // The late project-A response arrives after project B already loaded.
    slowA.resolve(PROJECT_A_ENTRIES);
    await staleLoad;

    expect(state.dirs()).toEqual(['.env']);
    expect([...state.selected()]).toEqual(['.env']);
    expect(state.loading()).toBe(false);
  });

  it('clears state without loading for non-git projects or a missing path', async () => {
    let fetched = 0;
    const state = createSymlinkCandidateState(async () => {
      fetched += 1;
      return PROJECT_A_ENTRIES;
    });
    await state.load('/project-a', true);

    await state.load(undefined, true);
    expect(state.dirs()).toEqual([]);
    expect(state.selected().size).toBe(0);
    expect(state.loading()).toBe(false);

    await state.load('/project-a', false);
    expect(state.dirs()).toEqual([]);
    expect(fetched).toBe(1);
  });

  it('drops an in-flight response when invalidated (dialog closed)', async () => {
    const pending = deferred<GitIgnoredEntry[]>();
    const state = createSymlinkCandidateState(() => pending.promise);

    const loadPromise = state.load('/project-a', true);
    state.invalidate();
    expect(state.loading()).toBe(false);
    pending.resolve(PROJECT_A_ENTRIES);
    await loadPromise;

    expect(state.dirs()).toEqual([]);
  });
});

describe('symlink probe gating by git isolation mode', () => {
  // Direct-mode tasks never send symlinkDirs, so probing candidates there
  // would be a wasted IPC whose pending state must not block submit either.
  it('probes only for git projects in worktree mode', () => {
    expect(shouldProbeSymlinkCandidates(true, 'worktree')).toBe(true);
    expect(shouldProbeSymlinkCandidates(true, 'direct')).toBe(false);
    expect(shouldProbeSymlinkCandidates(false, 'worktree')).toBe(false);
    expect(shouldProbeSymlinkCandidates(false, 'direct')).toBe(false);
  });

  it('blocks submit on a pending probe only in worktree mode', () => {
    expect(symlinkProbeBlocksSubmit('worktree', true)).toBe(true);
    expect(symlinkProbeBlocksSubmit('worktree', false)).toBe(false);
    expect(symlinkProbeBlocksSubmit('direct', true)).toBe(false);
    expect(symlinkProbeBlocksSubmit('direct', false)).toBe(false);
  });

  it('a skipped probe never fetches and never enters the loading state', async () => {
    let fetched = 0;
    const state = createSymlinkCandidateState(async () => {
      fetched += 1;
      return PROJECT_A_ENTRIES;
    });

    await state.load('/project-a', shouldProbeSymlinkCandidates(true, 'direct'));

    expect(fetched).toBe(0);
    expect(state.loading()).toBe(false);
    expect(symlinkProbeBlocksSubmit('direct', state.loading())).toBe(false);
  });
});
