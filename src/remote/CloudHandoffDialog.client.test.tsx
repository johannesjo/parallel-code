import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { CloudHandoffDialog } from './CloudHandoffDialog';
import { ApiError, fetchCloudHandoff, startCloudHandoff } from './api';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  fetchCloudHandoff: vi.fn(),
  startCloudHandoff: vi.fn(),
}));

let host: HTMLDivElement;
let dispose: (() => void) | undefined;
const onClose = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  dispose?.();
  host.remove();
});

function mount() {
  dispose = render(() => <CloudHandoffDialog taskId="t1" onClose={onClose} />, host);
}

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);

const AVAILABLE = {
  available: true as const,
  prompt: 'Continue this task: Fix login\nThe branch has the work so far.',
  branchName: 'task/fix-login',
  canPush: true,
};

it('starts with the edited prompt, pushing first by default, then says where to follow it', async () => {
  vi.mocked(fetchCloudHandoff).mockResolvedValue(AVAILABLE);
  vi.mocked(startCloudHandoff).mockResolvedValue();
  mount();
  const field = await vi.waitFor(() => {
    const el = host.querySelector('textarea');
    if (!el) throw new Error('prompt not loaded');
    return el;
  });
  expect(field.value).toBe(AVAILABLE.prompt);
  field.value = 'Finish the login tests.';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  button('Start cloud session')?.click();
  await vi.waitFor(() => expect(host.textContent).toContain('claude.ai/code'));
  expect(startCloudHandoff).toHaveBeenCalledWith('t1', {
    prompt: 'Finish the login tests.',
    push: true,
  });
  expect(onClose).not.toHaveBeenCalled();
});

it('skips the push when the user unticks it', async () => {
  vi.mocked(fetchCloudHandoff).mockResolvedValue(AVAILABLE);
  vi.mocked(startCloudHandoff).mockResolvedValue();
  mount();
  const box = await vi.waitFor(() => {
    const el = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!el) throw new Error('not loaded');
    return el;
  });
  box.click();
  button('Start cloud session')?.click();
  await vi.waitFor(() => expect(startCloudHandoff).toHaveBeenCalled());
  expect(vi.mocked(startCloudHandoff).mock.calls[0][1].push).toBe(false);
});

it('explains why a task cannot continue in the cloud, and offers nothing to start', async () => {
  vi.mocked(fetchCloudHandoff).mockResolvedValue({
    available: false,
    reason: 'Only Claude Code tasks outside Docker can continue in the cloud.',
  });
  mount();
  await vi.waitFor(() => expect(host.textContent).toContain('Only Claude Code tasks'));
  expect(button('Start cloud session')).toBeUndefined();
});

it('keeps the dialog open with the error when the push fails', async () => {
  vi.mocked(fetchCloudHandoff).mockResolvedValue(AVAILABLE);
  vi.mocked(startCloudHandoff).mockRejectedValue(
    new ApiError('Error: rejected (non-fast-forward)', 500),
  );
  mount();
  await vi.waitFor(() => expect(button('Start cloud session')).toBeDefined());
  button('Start cloud session')?.click();
  await vi.waitFor(() => expect(host.textContent).toContain('non-fast-forward'));
  expect(button('Start cloud session')).toBeDefined();
});

it('asks for a desktop update when the route is missing', async () => {
  vi.mocked(fetchCloudHandoff).mockRejectedValue(new ApiError('forbidden', 403));
  mount();
  await vi.waitFor(() => expect(host.textContent).toContain('Update Parallel Code'));
});
