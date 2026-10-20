import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ConnectPhoneModal } from './ConnectPhoneModal';
import { setStore } from '../store/core';
import { generatePairingPin, stopRemoteAccess, startRemoteAccess } from '../store/remote';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';

vi.mock('../store/core', async () => {
  const { createStore } = await import('solid-js/store');
  const [store, setStore] = createStore({ remoteAccess: { enabled: false } });
  return { store, setStore };
});
vi.mock('../store/remote', () => ({
  startRemoteAccess: vi.fn(() => new Promise(() => {})),
  stopRemoteAccess: vi.fn(),
  refreshRemoteStatus: vi.fn(),
  setAutoStartRemoteAccess: vi.fn(),
  generatePairingPin: vi.fn(),
}));
vi.mock('../lib/ipc', () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,') } }));

let dispose: () => void;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setStore('remoteAccess', {
    enabled: true,
    url: 'http://localhost:7777?token=watch',
    wifiUrl: 'http://localhost:7777?token=watch',
    tailscaleUrl: null,
    port: 7777,
    connectedClients: 0,
  });
  vi.mocked(generatePairingPin).mockImplementation(async () => ({
    pin: '123456',
    expiresAt: Date.now() + 300_000,
  }));
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  dispose?.();
  host.remove();
  vi.useRealTimers();
});
function mount() {
  const [open, setOpen] = createSignal(true);
  dispose = render(() => <ConnectPhoneModal open={open()} onClose={() => setOpen(false)} />, host);
  return setOpen;
}

describe('automatic phone pairing setup', () => {
  it('does not restart after a coordinator delays an explicit disconnect', async () => {
    vi.mocked(stopRemoteAccess).mockResolvedValue({ stopped: false, reason: 'coordinator_active' });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Disconnect',
    );
    if (!button) throw new Error('Missing disconnect button');
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.body.textContent).toContain('coordinator is active');
    // The next status poll observes shutdown after the last coordinator exits.
    setStore('remoteAccess', 'enabled', false);
    await vi.advanceTimersByTimeAsync(0);
    expect(startRemoteAccess).not.toHaveBeenCalled();
    expect(document.querySelector('.dialog-panel')).toBeNull();
  });

  it('does not restart the server while disconnecting', async () => {
    vi.mocked(stopRemoteAccess).mockImplementation(async () => {
      setStore('remoteAccess', 'enabled', false);
      return { stopped: true };
    });
    mount();
    await vi.advanceTimersByTimeAsync(0);
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Disconnect',
    );
    if (!button) throw new Error('Missing disconnect button');
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopRemoteAccess).toHaveBeenCalledOnce();
    expect(startRemoteAccess).not.toHaveBeenCalled();
    expect(document.querySelector('.dialog-panel')).toBeNull();
  });

  it('keeps the dialog open and reports a revocation failure', async () => {
    vi.mocked(stopRemoteAccess).mockRejectedValue(new Error('Could not revoke phone access'));
    mount();
    await vi.advanceTimersByTimeAsync(0);
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Disconnect',
    );
    if (!button) throw new Error('Missing disconnect button');
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.body.textContent).toContain('Could not revoke phone access');
    expect(document.querySelector('.dialog-panel')).not.toBeNull();
  });

  it('shows a code on open, refreshes it on expiry, and stops when closed', async () => {
    const setOpen = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(generatePairingPin).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('123456');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(generatePairingPin).toHaveBeenCalledTimes(2);
    setOpen(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(generatePairingPin).toHaveBeenCalledTimes(2);
  });

  it('waits for the server to start before preparing a code', async () => {
    setStore('remoteAccess', 'enabled', false);
    mount();
    expect(generatePairingPin).not.toHaveBeenCalled();
    setStore('remoteAccess', 'enabled', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(generatePairingPin).toHaveBeenCalledOnce();
  });

  it('ignores a pending code response after the dialog closes', async () => {
    let resolvePin: ((result: { pin: string; expiresAt: number }) => void) | undefined;
    vi.mocked(generatePairingPin).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePin = resolve;
        }),
    );
    const setOpen = mount();
    setOpen(false);
    resolvePin?.({ pin: '654321', expiresAt: Date.now() + 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(generatePairingPin).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('654321');
  });
});

it('opens the Android app guide in the browser', async () => {
  mount();
  await vi.advanceTimersByTimeAsync(0);
  const link = [...document.querySelectorAll('a')].find(
    (a) => a.textContent === 'Parallel Code app',
  );
  if (!link) throw new Error('Missing Android app link');
  link.click();
  expect(invoke).toHaveBeenCalledWith(IPC.ShellOpenExternal, {
    url: 'https://github.com/johannesjo/parallel-code#android-app',
  });
});
