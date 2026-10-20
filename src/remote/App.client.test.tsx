import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { App } from './App';
import { reconnect } from './ws';

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static current: Socket;
  readyState = Socket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor() {
    Socket.current = this;
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  authenticate() {
    this.onmessage?.({ data: JSON.stringify({ type: 'agents', list: [] }) });
  }
  rejectAuthentication() {
    this.close();
    this.onclose?.({ code: 4001 });
  }
}

let host: HTMLDivElement;
let dispose: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('parallel-code-token', 'view-only');
  window.history.replaceState({}, '', '/');
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => {
  dispose?.();
  host.remove();
  localStorage.clear();
  sessionStorage.clear();
  reconnect();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount() {
  dispose = render(() => <App />, host);
}
function isPairing() {
  return host.querySelector('input[autocomplete="one-time-code"]') !== null;
}

describe('automatic pairing on mobile', () => {
  it.each(['visibilitychange', 'online', 'pageshow'])(
    'replaces an apparently open socket when the app resumes via %s',
    (eventType) => {
      localStorage.setItem('parallel-code-paired-token', 'remembered');
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      mount();
      const suspended = Socket.current;
      suspended.authenticate();
      const event = new Event(eventType);
      if (eventType === 'pageshow') Object.defineProperty(event, 'persisted', { value: true });
      (eventType === 'visibilitychange' ? document : window).dispatchEvent(event);
      expect(suspended.readyState).toBe(3);
      expect(Socket.current).not.toBe(suspended);
      Socket.current.authenticate();
      expect(isPairing()).toBe(false);
    },
  );

  it('shows connection setup when a new shortcut has no saved credentials', () => {
    localStorage.clear();
    mount();
    expect(host.textContent).toContain('Connect');
    expect(host.querySelector('input')).not.toBeNull();
    expect(isPairing()).toBe(false);
  });

  it('opens code entry for an unpaired phone even after a previous viewing-only choice', () => {
    localStorage.setItem('parallel-mobile:view-only', 'true');
    mount();
    expect(isPairing()).toBe(true);
  });

  it('leaves an authenticated remembered phone in the app', () => {
    localStorage.setItem('parallel-code-paired-token', 'remembered');
    mount();
    Socket.current.authenticate();
    expect(isPairing()).toBe(false);
  });

  it('opens code entry when a stale paired credential falls back to viewing', async () => {
    localStorage.setItem('parallel-code-paired-token', 'expired');
    mount();
    expect(isPairing()).toBe(false);
    Socket.current.rejectAuthentication();
    await vi.advanceTimersByTimeAsync(0);
    Socket.current.authenticate();
    expect(isPairing()).toBe(true);
  });

  it('respects viewing-only for this visit and offers pairing again on the next visit', () => {
    mount();
    Socket.current.authenticate();
    const cancel = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Continue viewing only',
    );
    if (!cancel) throw new Error('Missing viewing-only button');
    cancel.click();
    expect(isPairing()).toBe(false);
    reconnect();
    Socket.current.authenticate();
    expect(isPairing()).toBe(false);
    dispose();
    mount();
    expect(isPairing()).toBe(true);
  });
});
