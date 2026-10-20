import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { RemoveProjectConfirm, removeProjectAndHiddenAgents } from './RemoveProjectConfirm';
import { NOTIFICATION_ERROR_MS, showNotification } from '../store/notification';
import { removeProject, removeProjectWithTasks } from '../store/store';
import { disposeHiddenAgentTasks } from '../documents/agent-task';

const mockStore = vi.hoisted(() => ({ projects: [{ id: 'p' }] as { id: string }[] }));
vi.mock('../store/store', () => ({
  store: mockStore,
  removeProject: vi.fn(),
  removeProjectWithTasks: vi.fn(),
}));
vi.mock('../store/notification', () => ({
  NOTIFICATION_ERROR_MS: 10_000,
  showNotification: vi.fn(),
}));
vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: (props: { onConfirm: () => void }) => (
    <button onClick={() => props.onConfirm()}>confirm</button>
  ),
}));
vi.mock('../documents/agent-task', () => ({ disposeHiddenAgentTasks: vi.fn() }));
vi.mock('./project-remove-confirmation', () => ({ getProjectTaskCount: () => 0 }));

beforeEach(() => {
  vi.resetAllMocks();
  mockStore.projects = [{ id: 'p' }];
});

it('disposes hidden agents only after the project is gone', async () => {
  vi.mocked(removeProjectWithTasks).mockImplementation(async () => {
    expect(disposeHiddenAgentTasks).not.toHaveBeenCalled();
    mockStore.projects = [];
  });
  await removeProjectAndHiddenAgents('p', true);
  expect(disposeHiddenAgentTasks).toHaveBeenCalledWith('p');
});

it('keeps hidden agents when the project survives a failed task close', async () => {
  await removeProjectAndHiddenAgents('p', true);
  expect(disposeHiddenAgentTasks).not.toHaveBeenCalled();
});

it('removes a project without tasks directly', async () => {
  vi.mocked(removeProject).mockImplementation(() => {
    mockStore.projects = [];
  });
  await removeProjectAndHiddenAgents('p', false);
  expect(removeProjectWithTasks).not.toHaveBeenCalled();
  expect(disposeHiddenAgentTasks).toHaveBeenCalledWith('p');
});

it('shows a failed removal to the user', async () => {
  vi.mocked(removeProject).mockImplementation(() => {
    throw new Error('disk full');
  });
  const host = document.createElement('div');
  document.body.append(host);
  const dispose = render(
    () => <RemoveProjectConfirm projectId="p" onDone={() => undefined} />,
    host,
  );
  host.querySelector('button')?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('disk full'), {
    durationMs: NOTIFICATION_ERROR_MS,
  });
  dispose();
  host.remove();
});
