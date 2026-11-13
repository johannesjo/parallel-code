import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { ImportWorktreesDialog } from './ImportWorktreesDialog';
import { createImportedTask } from '../store/store';
import { listWorktreeSessions } from '../store/sessions';

// Reactive like the real store, so an import can change which worktrees count as tracked.
interface MockStore {
  taskOrder: string[];
  tasks: Record<string, { projectId: string; worktreePath: string }>;
}
const storeMock = vi.hoisted(() => ({
  setStore: undefined as unknown as (fn: (s: MockStore) => void) => void,
}));
vi.mock('../store/store', async () => {
  const { createStore, produce } = await import('solid-js/store');
  const [store, setStore] = createStore({
    availableAgents: [{ id: 'agent', name: 'Agent', command: 'claude' }],
    taskOrder: ['tracked'],
    collapsedTaskOrder: [] as string[],
    tasks: { tracked: { projectId: 'project', worktreePath: '/repo/tracked' } } as Record<
      string,
      { projectId: string; worktreePath: string }
    >,
  });
  storeMock.setStore = (fn) => setStore(produce(fn));
  return {
    store,
    getProjectPath: () => '/repo',
    loadAgents: vi.fn(),
    createImportedTask: vi.fn(async () => {}),
  };
});
vi.mock('../store/sessions', () => ({ listWorktreeSessions: vi.fn(async () => []) }));
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
  vi.clearAllMocks();
});
function button(label: string) {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
it('bulk-selects only visible worktrees and explains an empty selection', async () => {
  const onClose = vi.fn();
  dispose = render(
    () => (
      <ImportWorktreesDialog
        open
        onClose={onClose}
        project={{ id: 'project', name: 'Project', path: '/repo', color: '#fff' }}
        initialCandidates={['tracked', 'one', 'two'].map((name) => ({
          path: `/repo/${name}`,
          branch_name: name,
          has_committed_changes: false,
          has_uncommitted_changes: true,
          app_created: false,
        }))}
      />
    ),
    document.body,
  );
  expect(document.body.textContent).toContain('2 of 2 selected');
  button('Clear').click();
  expect(button('Import 0 worktrees').disabled).toBe(true);
  expect(document.body.textContent).toContain('Select at least one worktree');
  button('Select all').click();
  // Import waits for the session scan, so it cannot start a fresh conversation by accident.
  await vi.waitFor(() => expect(button('Import 2 worktrees').disabled).toBe(false));
  button('Import 2 worktrees').click();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(vi.mocked(createImportedTask).mock.calls.map(([args]) => args.worktree.path)).toEqual([
    '/repo/one',
    '/repo/two',
  ]);
});

it('resumes the newest session and pre-ticks cleanup only for app-made worktrees', async () => {
  vi.mocked(listWorktreeSessions).mockImplementation(async (path) =>
    path === '/repo/.worktrees/task/lost'
      ? [
          { id: 'newest', agent: 'claude', cwd: path, title: 'Worklog', updatedAt: 2 },
          { id: 'older', agent: 'claude', cwd: path, updatedAt: 1 },
        ]
      : [],
  );
  const onClose = vi.fn();
  dispose = render(
    () => (
      <ImportWorktreesDialog
        open
        onClose={onClose}
        project={{ id: 'project', name: 'Project', path: '/repo', color: '#fff' }}
        initialCandidates={[
          {
            path: '/repo/.worktrees/task/lost',
            branch_name: 'task/lost',
            has_committed_changes: true,
            has_uncommitted_changes: false,
            app_created: true,
          },
          {
            path: '/elsewhere/manual',
            branch_name: 'manual',
            has_committed_changes: false,
            has_uncommitted_changes: false,
            app_created: false,
          },
        ]}
      />
    ),
    document.body,
  );
  const select = await vi.waitFor(() => {
    const found = document.querySelector<HTMLSelectElement>('select');
    if (!found) throw new Error('no session select yet');
    return found;
  });
  expect(select.value).toBe('newest');
  expect(document.body.textContent).toContain('No recorded sessions; starts a new conversation');
  await vi.waitFor(() => expect(button('Import 2 worktrees').disabled).toBe(false));
  button('Import 2 worktrees').click();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(
    vi
      .mocked(createImportedTask)
      .mock.calls.map(([args]) => [args.worktree.path, args.resumeSessionId, args.cleanupOnClose]),
  ).toEqual([
    ['/repo/.worktrees/task/lost', 'newest', true],
    ['/elsewhere/manual', undefined, false],
  ]);
});

it('starts fresh when the user picks a new conversation', async () => {
  vi.mocked(listWorktreeSessions).mockResolvedValue([
    { id: 'newest', agent: 'claude', cwd: '/repo/one', updatedAt: 2 },
  ]);
  const onClose = vi.fn();
  dispose = render(
    () => (
      <ImportWorktreesDialog
        open
        onClose={onClose}
        project={{ id: 'project', name: 'Project', path: '/repo', color: '#fff' }}
        initialCandidates={[
          {
            path: '/repo/one',
            branch_name: 'one',
            has_committed_changes: false,
            has_uncommitted_changes: false,
            app_created: false,
          },
        ]}
      />
    ),
    document.body,
  );
  const select = await vi.waitFor(() => {
    const found = document.querySelector<HTMLSelectElement>('select');
    if (!found) throw new Error('no session select yet');
    return found;
  });
  select.value = '';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(button('Import 1 worktree').disabled).toBe(false));
  button('Import 1 worktree').click();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(vi.mocked(createImportedTask).mock.calls[0]?.[0].resumeSessionId).toBeUndefined();
});

it("keeps each worktree's session choice when importing several at once", async () => {
  vi.mocked(listWorktreeSessions).mockImplementation(async (path) => [
    { id: `${path}-newest`, agent: 'claude', cwd: path, updatedAt: 2 },
    { id: `${path}-older`, agent: 'claude', cwd: path, updatedAt: 1 },
  ]);
  // Like the real store: an imported task joins taskOrder and its worktree counts as tracked.
  vi.mocked(createImportedTask).mockImplementation(async ({ worktree }) => {
    storeMock.setStore((s) => {
      s.tasks[worktree.path] = { projectId: 'project', worktreePath: worktree.path };
      s.taskOrder.push(worktree.path);
    });
    return worktree.path;
  });
  const onClose = vi.fn();
  dispose = render(
    () => (
      <ImportWorktreesDialog
        open
        onClose={onClose}
        project={{ id: 'project', name: 'Project', path: '/repo', color: '#fff' }}
        initialCandidates={['/repo/one', '/repo/two'].map((path) => ({
          path,
          branch_name: path,
          has_committed_changes: false,
          has_uncommitted_changes: false,
          app_created: false,
        }))}
      />
    ),
    document.body,
  );
  const second = await vi.waitFor(() => {
    const found = document.querySelectorAll<HTMLSelectElement>('select')[1];
    if (!found) throw new Error('no session selects yet');
    return found;
  });
  second.value = '/repo/two-older';
  second.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(button('Import 2 worktrees').disabled).toBe(false));
  button('Import 2 worktrees').click();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(vi.mocked(createImportedTask).mock.calls.map(([args]) => args.resumeSessionId)).toEqual([
    '/repo/one-newest',
    '/repo/two-older',
  ]);
});
