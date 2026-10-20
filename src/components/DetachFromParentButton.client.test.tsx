import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Show, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { invoke } from '../lib/ipc';
import { setStore, store } from '../store/core';
import { DetachFromParentButton } from './DetachFromParentButton';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('./ConfirmDialog', () => ({
  ConfirmDialog: (props: { open: boolean; message: JSX.Element; onConfirm: () => void }) => (
    <Show when={props.open}>
      <div role="dialog">
        {props.message}
        <button onClick={() => props.onConfirm()}>confirm</button>
      </div>
    </Show>
  ),
}));

let dispose: (() => void) | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  setStore('tasks', 'child', {
    id: 'child',
    name: 'Child',
    projectId: 'project',
    branchName: 'task/child',
    worktreePath: '/repo/child',
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    coordinatedBy: 'parent',
    controlledBy: 'coordinator',
    integrationPolicy: 'review',
  });
  host = document.createElement('div');
  document.body.append(host);
  dispose = render(() => <DetachFromParentButton taskId="child" parentName="Parent" />, host);
});

afterEach(() => {
  dispose?.();
  host.remove();
});

function click(label: string): void {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!button) throw new Error(`No ${label} button`);
  button.click();
}

it('detaches the child after confirmation', async () => {
  vi.mocked(invoke).mockResolvedValue({
    taskId: 'parent',
    detachedChildIds: ['child'],
    paused: false,
  });
  click('Detach');
  expect(invoke).not.toHaveBeenCalled();
  click('confirm');
  await vi.waitFor(() => expect(host.querySelector('[role="dialog"]')).toBeNull());
  expect(invoke).toHaveBeenCalledWith(expect.anything(), {
    action: 'detachChild',
    taskId: 'child',
  });
  expect(store.tasks.child.coordinatedBy).toBeUndefined();
  expect(store.tasks.child.controlledBy).toBeUndefined();
  expect(store.tasks.child.integrationPolicy).toBeUndefined();
  expect(store.tasks.child.delegationPaused).toBe(false);
});

it('keeps the link and shows the error when detaching fails', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('The child is still starting.'));
  click('Detach');
  click('confirm');
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('still starting'),
  );
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  expect(store.tasks.child.coordinatedBy).toBe('parent');
});
