import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { PairScreen } from './PairScreen';
import { verifyPairingPin } from './api';
import { getPairedToken } from './auth';

vi.mock('./api', () => ({ verifyPairingPin: vi.fn() }));

let host: HTMLDivElement;
let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  vi.mocked(verifyPairingPin).mockResolvedValue('phone-token');
});
afterEach(() => {
  dispose?.();
  host.remove();
});

function mountAndSubmit(remember: boolean) {
  const onPaired = vi.fn();
  dispose = render(() => <PairScreen onPaired={onPaired} onCancel={() => {}} />, host);
  const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
  const pin = host.querySelector<HTMLInputElement>('input[type="text"]');
  const form = host.querySelector('form');
  if (!checkbox || !pin || !form) throw new Error('Missing pairing form');
  checkbox.checked = remember;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  pin.value = '123456';
  pin.dispatchEvent(new Event('input', { bubbles: true }));
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return onPaired;
}

describe('phone pairing', () => {
  it.each([true, false])('honors the remember-device choice: %s', async (remember) => {
    const onPaired = mountAndSubmit(remember);
    await vi.waitFor(() => expect(onPaired).toHaveBeenCalledOnce());
    expect(verifyPairingPin).toHaveBeenCalledWith('123456', remember);
    expect(getPairedToken()).toBe('phone-token');
    sessionStorage.clear();
    expect(getPairedToken()).toBe(remember ? 'phone-token' : null);
  });

  it('keeps the form and choice available after a failed pairing', async () => {
    vi.mocked(verifyPairingPin).mockRejectedValue(new Error('invalid or expired code'));
    const onPaired = mountAndSubmit(false);
    await vi.waitFor(() => expect(host.textContent).toContain('invalid or expired code'));
    expect(onPaired).not.toHaveBeenCalled();
    expect(getPairedToken()).toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  });
});
