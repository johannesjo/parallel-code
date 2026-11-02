import { beforeEach, describe, expect, it, vi } from 'vitest';

const { windows, mockSession } = vi.hoisted(() => ({
  windows: [] as {
    options: { webPreferences: Record<string, unknown> };
    handlers: Map<string, (event: { preventDefault: () => void }, url: string) => void>;
    destroy: ReturnType<typeof vi.fn>;
  }[],
  mockSession: {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
    clearStorageData: vi.fn(async () => undefined),
  },
}));

vi.mock('electron', () => ({
  session: { fromPartition: () => mockSession },
  BrowserWindow: vi.fn(function (this: unknown, options: (typeof windows)[0]['options']) {
    const handlers = new Map();
    const win = { options, handlers, destroy: vi.fn() };
    windows.push(win);
    return {
      destroy: win.destroy,
      loadURL: async () => undefined,
      webContents: {
        setAudioMuted: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        on: (name: string, handler: unknown) => handlers.set(name, handler),
        capturePage: async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('png') }),
      },
    };
  }),
}));

import { isLoopbackUrl, shootPage } from './task-screens-shoot.js';

beforeEach(() => {
  windows.length = 0;
  mockSession.clearStorageData.mockClear();
});

describe('isLoopbackUrl', () => {
  it('accepts only http pages on this machine', () => {
    for (const url of ['http://localhost:5173/a', 'https://127.0.0.1:8443', 'http://[::1]:3000']) {
      expect(isLoopbackUrl(url)).toBe(true);
    }
    for (const url of [
      'http://example.com',
      'http://localhost.evil.com',
      'file:///etc/passwd',
      'http://user:pw@localhost:1',
      'not a url',
    ]) {
      expect(isLoopbackUrl(url)).toBe(false);
    }
  });
});

describe('shootPage', () => {
  it('refuses a page off this machine without opening a window', async () => {
    await expect(shootPage('https://example.com')).rejects.toThrow('Not a local address');
    expect(windows).toHaveLength(0);
  });

  it('shoots a fresh sandboxed window that cannot leave localhost', async () => {
    vi.useFakeTimers();
    try {
      const shot = shootPage('http://localhost:8101/');
      await vi.runAllTimersAsync();
      expect((await shot).toString()).toBe('png');
    } finally {
      vi.useRealTimers();
    }
    expect(mockSession.clearStorageData).toHaveBeenCalled();
    const [win] = windows;
    expect(win.options.webPreferences).toMatchObject({ sandbox: true, offscreen: true });
    const navigate = (url: string) => {
      const event = { preventDefault: vi.fn() };
      win.handlers.get('will-navigate')?.(event, url);
      return event.preventDefault.mock.calls.length > 0;
    };
    expect(navigate('https://example.com/login')).toBe(true);
    expect(navigate('http://localhost:8101/next')).toBe(false);
    expect(win.destroy).toHaveBeenCalled();
  });
});
