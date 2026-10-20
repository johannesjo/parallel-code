import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';

function setup() {
  const window = new Window();
  window.document.body.innerHTML =
    '<button id="save">Save</button><input type="password" value="secret">';
  const handlers = new Map<string, (_event: unknown, value: unknown) => void>();
  const send = vi.fn();
  runInNewContext(readFileSync(new URL('./browser-preload.cjs', import.meta.url), 'utf8'), {
    require: () => ({
      ipcRenderer: {
        on: (channel: string, cb: (_event: unknown, value: unknown) => void) =>
          handlers.set(channel, cb),
        send,
      },
    }),
    window,
    document: window.document,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    CSS: window.CSS,
  });
  const pick = (selector: string, trusted = true) => {
    const event = new window.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    Object.defineProperty(event, 'isTrusted', { value: trusted });
    window.document.querySelector(selector)?.dispatchEvent(event);
    return event;
  };
  return { window, send, pick, arm: () => handlers.get('browser:set-picking')?.({}, true) };
}

describe('isolated element picker', () => {
  it('captures an element and suppresses its normal click, then disarms', () => {
    const { arm, pick, send, window } = setup();
    arm();
    expect(pick('#save').defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledWith(
      'browser:pick-result',
      expect.objectContaining({ selector: '#save', text: 'Save' }),
    );
    pick('#save');
    expect(send).toHaveBeenCalledTimes(1);
    expect(window.document.querySelector('[data-parallel-picker]')).toBeNull();
  });
  it('ignores synthetic page events and never copies input values', () => {
    const { arm, pick, send } = setup();
    arm();
    pick('#save', false);
    expect(send).not.toHaveBeenCalled();
    pick('input');
    expect(JSON.stringify(send.mock.calls)).not.toContain('secret');
  });
  it('intercepts capture listeners registered by the page before arming', () => {
    const { arm, pick, window } = setup();
    const activate = vi.fn();
    window.addEventListener('click', activate, true);
    arm();
    pick('#save');
    expect(activate).not.toHaveBeenCalled();
    pick('#save');
    expect(activate).toHaveBeenCalledTimes(1);
  });
  it.each(['#editor span', '#container'])('omits editable text when selecting %s', (selector) => {
    const { arm, pick, send, window } = setup();
    window.document.body.innerHTML =
      '<div id="container"><div id="editor" contenteditable="true"><span>private draft</span></div></div>';
    arm();
    pick(selector);
    expect(send).toHaveBeenCalledWith('browser:pick-result', expect.objectContaining({ text: '' }));
    expect(JSON.stringify(send.mock.calls)).not.toContain('private draft');
  });
  it('distinguishes same-tag siblings directly inside an open shadow root', () => {
    const { arm, send, window } = setup();
    const host = window.document.createElement('div');
    host.id = 'host';
    window.document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>First</button><button>Second</button>';
    arm();
    const event = new window.MouseEvent('click', {
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'isTrusted', { value: true });
    shadow.children[1].dispatchEvent(event);
    expect(send).toHaveBeenCalledWith(
      'browser:pick-result',
      expect.objectContaining({
        selector: '#host >>> button:nth-of-type(2)',
      }),
    );
  });
  it('cancels on Escape without producing a reference', () => {
    const { arm, send, window } = setup();
    arm();
    window.document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(send).toHaveBeenCalledWith('browser:pick-result', null);
  });
});
