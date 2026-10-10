import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { FixCiDialog } from './FixCiDialog';
import { ApiError, fetchFixCiPrompt, sendFixCiPrompt } from './api';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  fetchFixCiPrompt: vi.fn(),
  sendFixCiPrompt: vi.fn(),
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
  dispose = render(() => <FixCiDialog taskId="t1" onClose={onClose} />, host);
}

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);

it('sends the prompt as the user edited it', async () => {
  vi.mocked(fetchFixCiPrompt).mockResolvedValue('CI failed on pull request #7.');
  vi.mocked(sendFixCiPrompt).mockResolvedValue();
  mount();
  const field = await vi.waitFor(() => {
    const el = host.querySelector('textarea');
    if (!el) throw new Error('prompt not loaded');
    return el;
  });
  expect(field.value).toBe('CI failed on pull request #7.');
  field.value = 'Fix only the lint job.';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  button('Send to agent')?.click();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(sendFixCiPrompt).toHaveBeenCalledWith('t1', 'Fix only the lint job.');
});

it('says so when no check failed, and offers nothing to send', async () => {
  vi.mocked(fetchFixCiPrompt).mockResolvedValue(null);
  mount();
  await vi.waitFor(() => expect(host.textContent).toContain('No failed checks found.'));
  expect(button('Send to agent')).toBeUndefined();
});

it('asks for a desktop update when the route is missing', async () => {
  vi.mocked(fetchFixCiPrompt).mockRejectedValue(new ApiError('forbidden', 403));
  mount();
  await vi.waitFor(() => expect(host.textContent).toContain('Update Parallel Code'));
});

it('keeps the dialog open with the error when sending fails', async () => {
  vi.mocked(fetchFixCiPrompt).mockResolvedValue('prompt');
  vi.mocked(sendFixCiPrompt).mockRejectedValue(new Error('agent gone'));
  mount();
  await vi.waitFor(() => expect(button('Send to agent')).toBeDefined());
  button('Send to agent')?.click();
  await vi.waitFor(() => expect(host.textContent).toContain('agent gone'));
  expect(onClose).not.toHaveBeenCalled();
});
