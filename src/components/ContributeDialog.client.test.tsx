import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContributeDialog } from './ContributeDialog';
import { findParallelCodeProject } from '../store/contribute';
import { openGitHubIssuesWithLabel } from '../store/github';
import { pickAndAddProject } from '../store/projects';
import type { Project } from '../store/types';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../store/contribute', async (original) => ({
  ...(await original<typeof import('../store/contribute')>()),
  findParallelCodeProject: vi.fn(),
}));
vi.mock('../store/github', () => ({ openGitHubIssuesWithLabel: vi.fn() }));
vi.mock('../store/projects', () => ({ pickAndAddProject: vi.fn() }));

const checkout: Project = { id: 'pc', name: 'parallel-code', path: '/pc', color: '#fff' };
let dispose: (() => void) | undefined;
// The dialog renders through a portal into the body.
const host = document.body;
const onClose = vi.fn();
const [open, setOpen] = createSignal(true);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function button(text: string): HTMLButtonElement {
  // Choice buttons carry a description after their title.
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text));
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  setOpen(true);
  const root = document.createElement('div');
  document.body.append(root);
  dispose = render(() => <ContributeDialog open={open()} onClose={onClose} />, root);
});
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

it('opens the checkout’s issue browser filtered to the chosen label', async () => {
  vi.mocked(findParallelCodeProject).mockResolvedValue({ project: checkout, lookupError: null });
  button('Help wanted').click();
  await flush();
  expect(onClose).toHaveBeenCalled();
  expect(openGitHubIssuesWithLabel).toHaveBeenCalledWith('pc', 'help wanted');
  expect(host.textContent).not.toContain('gh repo fork johannesjo/parallel-code --clone');
});

it('explains how to get a checkout, then continues once one is added', async () => {
  vi.mocked(findParallelCodeProject).mockResolvedValueOnce({ project: null, lookupError: null });
  button('Good first issues').click();
  await flush();
  expect(openGitHubIssuesWithLabel).not.toHaveBeenCalled();
  expect(host.textContent).toContain('gh repo fork johannesjo/parallel-code --clone');

  vi.mocked(pickAndAddProject).mockResolvedValue('pc');
  vi.mocked(findParallelCodeProject).mockResolvedValueOnce({
    project: checkout,
    lookupError: null,
  });
  button('Add project…').click();
  await flush();
  expect(openGitHubIssuesWithLabel).toHaveBeenCalledWith('pc', 'good first issue');
  expect(host.textContent).not.toContain('gh repo fork johannesjo/parallel-code --clone');
});

it('keeps the guidance when adding a project is cancelled', async () => {
  vi.mocked(findParallelCodeProject).mockResolvedValue({ project: null, lookupError: null });
  button('Good first issues').click();
  await flush();
  vi.mocked(pickAndAddProject).mockResolvedValue(null);
  button('Add project…').click();
  await flush();
  expect(findParallelCodeProject).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('gh repo fork johannesjo/parallel-code --clone');
});

it('says gh could not check the projects, as the checkout may be among them', async () => {
  vi.mocked(findParallelCodeProject).mockResolvedValue({
    project: null,
    lookupError: 'GitHub CLI is not logged in.',
  });
  button('Help wanted').click();
  await flush();
  expect(host.textContent).toContain(
    'GitHub CLI could not check your projects (GitHub CLI is not logged in.)',
  );
});

it('reports a project that could not be added', async () => {
  vi.mocked(findParallelCodeProject).mockResolvedValue({ project: null, lookupError: null });
  button('Help wanted').click();
  await flush();
  vi.mocked(pickAndAddProject).mockRejectedValue(new Error('IPC failed'));
  button('Add project…').click();
  await flush();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('IPC failed');
});

it('tells a clone without push access to fork first', () => {
  expect(host.textContent).toContain('gh repo fork --remote');
});

it('starts over when reopened after a failed lookup', async () => {
  vi.mocked(findParallelCodeProject).mockResolvedValue({ project: null, lookupError: null });
  button('Help wanted').click();
  await flush();
  setOpen(false);
  setOpen(true);
  expect(host.textContent).not.toContain('gh repo fork johannesjo/parallel-code --clone');
});

it('drops a lookup that finishes after the dialog closed', async () => {
  let finish: (search: { project: Project | null; lookupError: null }) => void = () => {};
  vi.mocked(findParallelCodeProject).mockImplementation(
    () => new Promise((resolve) => (finish = resolve)),
  );
  button('Help wanted').click();
  setOpen(false);
  finish({ project: checkout, lookupError: null });
  await flush();
  expect(openGitHubIssuesWithLabel).not.toHaveBeenCalled();

  setOpen(true);
  button('Good first issues').click();
  setOpen(false);
  finish({ project: null, lookupError: null });
  await flush();
  setOpen(true);
  expect(host.textContent).not.toContain('gh repo fork johannesjo/parallel-code --clone');
});
