import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyConnectionString,
  getToken,
  getPairedToken,
  setPairedToken,
  clearPairedToken,
  initAuth,
} from './auth';

interface StubLocation {
  origin: string;
  href: string;
}

let storage: Record<string, string>;
let location: StubLocation;
let session: Map<string, string>;

beforeEach(() => {
  storage = {};
  session = new Map();
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => session.set(k, v),
    removeItem: (k: string) => session.delete(k),
  };
  location = { origin: 'http://192.168.1.42:7777', href: 'http://192.168.1.42:7777/' };
  (globalThis as unknown as { window: unknown }).window = { location };
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => storage[k] ?? null,
    removeItem: (k: string) => {
      storage = Object.fromEntries(Object.entries(storage).filter(([key]) => key !== k));
    },
    setItem: (k: string, v: string) => {
      storage[k] = v;
    },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});

describe('applyConnectionString', () => {
  it('stores the token from a same-origin URL', () => {
    const result = applyConnectionString('http://192.168.1.42:7777/?token=abcd1234abcd1234');
    expect(result).toBe('stored');
    expect(storage['parallel-code-token']).toBe('abcd1234abcd1234');
  });

  it('navigates to a different-origin URL instead of storing in place', () => {
    const result = applyConnectionString('http://192.168.1.99:7777/?token=zzzz1234zzzz1234');
    expect(result).toBe('navigating');
    expect(location.href).toBe('http://192.168.1.99:7777/?token=zzzz1234zzzz1234');
    expect(storage['parallel-code-token']).toBeUndefined();
  });

  it('rejects a URL with no token', () => {
    expect(applyConnectionString('http://192.168.1.42:7777/')).toBe('invalid');
  });

  it('rejects non-http(s) schemes even when they carry a token', () => {
    expect(applyConnectionString('javascript:fetch(1)//?token=aaaaaaaaaaaaaaaa')).toBe('invalid');
    expect(applyConnectionString('data:text/html,x?token=aaaaaaaaaaaaaaaa')).toBe('invalid');
    expect(applyConnectionString('file:///etc/passwd?token=aaaaaaaaaaaaaaaa')).toBe('invalid');
    expect(storage['parallel-code-token']).toBeUndefined();
    expect(location.href).toBe('http://192.168.1.42:7777/');
  });

  it('rejects empty or non-URL input', () => {
    expect(applyConnectionString('')).toBe('invalid');
    expect(applyConnectionString('   ')).toBe('invalid');
    expect(applyConnectionString('hello world')).toBe('invalid');
    expect(applyConnectionString('AbC-123_def456ghi789')).toBe('invalid');
  });
});

describe('remembering phone authentication', () => {
  it('uses a remembered paired token for startup and read requests after the base token expires', () => {
    storage['parallel-code-token'] = 'expired';
    setPairedToken('remembered', true);
    expect(getToken()).toBe('remembered');
    expect(initAuth()).toBe('remembered');
    expect(session.size).toBe(0);
  });

  it('keeps unchecked pairing only for the browser session and removes older persistent access', () => {
    setPairedToken('old', true);
    setPairedToken('temporary', false);
    expect(storage['parallel-code-paired-token']).toBeUndefined();
    expect(getPairedToken()).toBe('temporary');
    session.clear();
    expect(getPairedToken()).toBeNull();
  });

  it('clears both kinds of credentials on revocation', () => {
    setPairedToken('temporary', false);
    storage['parallel-code-paired-token'] = 'remembered';
    clearPairedToken();
    expect(getPairedToken()).toBeNull();
  });
});
