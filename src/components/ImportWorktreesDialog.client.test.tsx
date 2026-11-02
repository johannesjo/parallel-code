import { render } from 'solid-js/web';
import { afterEach, expect, it, vi } from 'vitest';
import { ImportWorktreesDialog } from './ImportWorktreesDialog';
import { createImportedTask } from '../store/store';

vi.mock('../store/store', () => ({
  store: {
    availableAgents: [{ id: 'agent', name: 'Agent' }],
    taskOrder: ['tracked'],
    collapsedTaskOrder: [],
    tasks: { tracked: { projectId: 'project', worktreePath: '/repo/tracked' } },
  },
  getProjectPath: () => '/repo',
  loadAgents: vi.fn(),
  createImportedTask: vi.fn(async () => {}),
}));
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
  button('Import 2 worktrees').click();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(vi.mocked(createImportedTask).mock.calls.map(([args]) => args.worktree.path)).toEqual([
    '/repo/one',
    '/repo/two',
  ]);
});
