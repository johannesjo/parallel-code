import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { pushTask, startCloudSession } from '../store/store';
import type { Task } from '../store/types';
import { CloudHandoffDialog } from './CloudHandoffDialog';

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(async () => ({})),
  Channel: class {
    onmessage: ((text: string) => void) | undefined;
    cleanup() {}
  },
}));
vi.mock('../store/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/store')>()),
  pushTask: vi.fn(() => Promise.resolve()),
  startCloudSession: vi.fn(),
}));

const task = {
  id: 't1',
  name: 'Fix login on Safari',
  branchName: 'task/fix-login',
  gitIsolation: 'worktree',
} as unknown as Task;

let dispose: (() => void) | undefined;

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );
}

let setOpen: (open: boolean) => void = () => undefined;

function openDialog(shown: Task = task) {
  const [open, setOpenSignal] = createSignal(true);
  setOpen = setOpenSignal;
  const onDone = vi.fn(() => setOpenSignal(false));
  const showTask = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  dispose = render(
    () => <CloudHandoffDialog open={open()} task={shown} showTask={showTask} onDone={onDone} />,
    host,
  );
  return { onDone, showTask };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.mocked(pushTask).mockReset().mockResolvedValue(undefined);
  vi.mocked(startCloudSession).mockClear();
});

it('names the task, since the cloud session has no conversation', () => {
  openDialog();
  expect(document.querySelector('textarea')?.value).toBe(
    'Continue this task: Fix login on Safari\nThe branch has the work so far.',
  );
});

it('marks the title with the Claude icon', () => {
  openDialog();
  expect(document.querySelector('h2 svg')).not.toBeNull();
});

it('pushes the branch, then starts the cloud session and shows the task', async () => {
  const { onDone, showTask } = openDialog();
  button('Start cloud session')?.click();
  await flush();
  expect(pushTask).toHaveBeenCalledWith('t1', expect.anything());
  expect(startCloudSession).toHaveBeenCalledWith('t1', expect.stringContaining('Safari'));
  expect(showTask).toHaveBeenCalled();
  expect(onDone).toHaveBeenCalled();
});

it('starts nothing and shows the error when the push fails', async () => {
  vi.mocked(pushTask).mockRejectedValue(new Error('no upstream'));
  const { onDone } = openDialog();
  button('Start cloud session')?.click();
  await flush();
  expect(startCloudSession).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('no upstream');
});

it('skips the push when unchecked', async () => {
  openDialog();
  document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
  button('Start cloud session')?.click();
  await flush();
  expect(pushTask).not.toHaveBeenCalled();
  expect(startCloudSession).toHaveBeenCalled();
});

it('starts nothing when cancelled while the push runs', async () => {
  let finishPush: () => void = () => undefined;
  vi.mocked(pushTask).mockReturnValue(new Promise<void>((resolve) => (finishPush = resolve)));
  openDialog();
  button('Start cloud session')?.click();
  await flush();
  button('Cancel')?.click();
  finishPush();
  await flush();
  expect(startCloudSession).not.toHaveBeenCalled();
});

it('does not let a push from a cancelled attempt start the reopened one', async () => {
  let finishPush: () => void = () => undefined;
  vi.mocked(pushTask).mockReturnValue(new Promise<void>((resolve) => (finishPush = resolve)));
  openDialog();
  button('Start cloud session')?.click();
  await flush();
  button('Cancel')?.click();
  setOpen(true);
  finishPush();
  await flush();
  expect(startCloudSession).not.toHaveBeenCalled();
  expect(document.querySelector('textarea')).not.toBeNull();
});
