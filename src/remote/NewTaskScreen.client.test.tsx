import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { NewTaskScreen } from './NewTaskScreen';
import { fetchProjects, createTask, ApiError } from './api';

vi.mock('./api', () => ({
  fetchProjects: vi.fn(),
  createTask: vi.fn(),
  ApiError: class extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));
vi.mock('./ws', () => ({ status: () => 'connected', reconnect: vi.fn() }));

let host: HTMLDivElement;
let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  vi.mocked(fetchProjects).mockResolvedValue([
    { id: 'p1', name: 'First project' },
    { id: 'p2', name: 'Second project', agentName: 'Agent B' },
  ]);
});
afterEach(() => {
  dispose?.();
  host.remove();
});
function mount(onCreated = vi.fn(), onNeedsPairing = vi.fn()) {
  dispose = render(
    () => (
      <NewTaskScreen onCreated={onCreated} onNeedsPairing={onNeedsPairing} onCancel={() => {}} />
    ),
    host,
  );
  return { onCreated, onNeedsPairing };
}
function type(selector: string, text: string) {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!input) throw new Error(`Missing input: ${selector}`);
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function submit() {
  const form = host.querySelector('form');
  if (!form) throw new Error('Missing form');
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('creating a task from the phone', () => {
  it('keeps the custom title field open while clearing a restored title', () => {
    localStorage.setItem('parallel-mobile:new-name', 'Old title');
    mount();
    expect(host.querySelector('details')?.open).toBe(true);
    type('input', '');
    expect(host.querySelector('details')?.open).toBe(true);
  });
  it('restores the project, derives a title, and opens the returned task', async () => {
    localStorage.setItem('parallel-mobile:project', 'p2');
    vi.mocked(createTask).mockResolvedValue('task-created');
    const { onCreated } = mount();
    await vi.waitFor(() => expect(host.querySelector('select')?.value).toBe('p2'));
    type('textarea', 'Fix the login redirect\nand add a test');
    submit();
    await vi.waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(
        'task-created',
        'Fix the login redirect and add a test',
      ),
    );
    expect(createTask).toHaveBeenCalledWith({
      projectId: 'p2',
      name: 'Fix the login redirect and add a test',
      prompt: 'Fix the login redirect\nand add a test',
    });
    expect(localStorage.getItem('parallel-mobile:new-prompt')).toBeNull();
  });
  it('keeps the form draft through an authorization detour', async () => {
    vi.mocked(createTask).mockRejectedValue(new ApiError('Pair again', 403));
    const { onNeedsPairing } = mount();
    await vi.waitFor(() => expect(host.querySelector('select')?.value).toBe('p1'));
    type('textarea', 'Keep this draft');
    type('input', 'My task');
    submit();
    await vi.waitFor(() => expect(onNeedsPairing).toHaveBeenCalledOnce());
    dispose();
    mount();
    await vi.waitFor(() => expect(host.querySelector('textarea')?.value).toBe('Keep this draft'));
    expect(host.querySelector('input')?.value).toBe('My task');
  });
  it('prevents duplicate submissions while creation is in flight', async () => {
    let resolve!: (id: string) => void;
    vi.mocked(createTask).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { onCreated } = mount();
    await vi.waitFor(() => expect(host.querySelector('select')?.value).toBe('p1'));
    type('textarea', 'One task only');
    submit();
    submit();
    expect(createTask).toHaveBeenCalledOnce();
    resolve('created');
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
  });
  it('does not erase a newer draft or navigate after the user leaves during creation', async () => {
    let resolve!: (id: string) => void;
    vi.mocked(createTask).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { onCreated } = mount();
    await vi.waitFor(() => expect(host.querySelector('select')?.value).toBe('p1'));
    type('textarea', 'First task');
    submit();
    dispose();
    mount();
    await vi.waitFor(() => expect(host.querySelector('select')?.value).toBe('p1'));
    type('textarea', 'A different task');
    resolve('first-created');
    await Promise.resolve();
    await Promise.resolve();
    expect(onCreated).not.toHaveBeenCalled();
    expect(localStorage.getItem('parallel-mobile:new-prompt')).toBe('A different task');
  });
});
