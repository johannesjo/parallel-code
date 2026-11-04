import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('./ipc', () => ({ invoke }));

import { IPC } from '../../electron/ipc/channels';
import { findBareFile } from './find-bare-file';

let exists: Set<string>;
let changed: Array<{ path: string; status: string }>;

beforeEach(() => {
  exists = new Set();
  changed = [];
  invoke.mockImplementation((cmd: string, args: { path?: string }) => {
    if (cmd === IPC.CheckPathExists) return Promise.resolve(exists.has(args.path ?? ''));
    if (cmd === IPC.GetChangedFiles) return Promise.resolve(changed);
    return Promise.reject(new Error(`Unexpected ${cmd}`));
  });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

// Each test uses its own worktree, so the changed-files cache never leaks between them.
it('prefers the file in the worktree root', async () => {
  exists.add('/wt1/notes.md');
  changed = [{ path: 'docs/notes.md', status: 'M' }];
  await expect(findBareFile('notes.md', { worktreePath: '/wt1' })).resolves.toBe('/wt1/notes.md');
  expect(invoke).not.toHaveBeenCalledWith(IPC.GetChangedFiles, expect.anything());
});

it('falls back to the only changed file of that name, never a guess', async () => {
  changed = [
    { path: 'docs/notes.md', status: 'A' },
    { path: 'a/index.ts', status: 'M' },
    { path: 'b/index.ts', status: 'M' },
    { path: 'old/gone.md', status: 'D' },
  ];
  const task = { worktreePath: '/wt2', baseBranch: 'dev' };
  await expect(findBareFile('notes.md', task)).resolves.toBe('/wt2/docs/notes.md');
  await expect(findBareFile('index.ts', task)).resolves.toBeUndefined();
  await expect(findBareFile('gone.md', task)).resolves.toBeUndefined();
  await expect(findBareFile('missing.md', task)).resolves.toBeUndefined();
  expect(invoke).toHaveBeenCalledWith(IPC.GetChangedFiles, {
    worktreePath: '/wt2',
    baseBranch: 'dev',
  });
});

it('asks git for changed files at most once every few seconds', async () => {
  vi.useFakeTimers();
  const changedCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === IPC.GetChangedFiles);
  await findBareFile('a.md', { worktreePath: '/wt3' });
  await findBareFile('b.md', { worktreePath: '/wt3' });
  expect(changedCalls()).toHaveLength(1);
  vi.advanceTimersByTime(10_000);
  await findBareFile('a.md', { worktreePath: '/wt3' });
  expect(changedCalls()).toHaveLength(2);
});

it('leaves the name plain when the lookup fails, and retries it next time', async () => {
  changed = [{ path: 'docs/notes.md', status: 'M' }];
  const listing = invoke.getMockImplementation();
  invoke.mockImplementationOnce(listing ?? vi.fn());
  invoke.mockRejectedValueOnce(new Error('git failed'));
  await expect(findBareFile('notes.md', { worktreePath: '/wt4' })).resolves.toBeUndefined();
  await expect(findBareFile('notes.md', { worktreePath: '/wt4' })).resolves.toBe(
    '/wt4/docs/notes.md',
  );
});
