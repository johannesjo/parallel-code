import { afterEach, expect, it, vi } from 'vitest';
import { getDeepActiveElement } from './dom-focus';
import { initShortcuts, registerShortcut } from './shortcuts';

afterEach(() => document.body.replaceChildren());

it('finds the editable composer through nested shadow roots', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const inner = document.createElement('div');
  host.attachShadow({ mode: 'open' }).append(inner);
  const composer = document.createElement('textarea');
  inner.attachShadow({ mode: 'open' }).append(composer);
  composer.focus();
  expect(document.activeElement).toBe(host);
  expect(getDeepActiveElement()).toBe(composer);
  expect(getDeepActiveElement()).toBeInstanceOf(HTMLTextAreaElement);
});

it('does not run non-global shortcuts while typing in the chat island', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const composer = document.createElement('textarea');
  host.attachShadow({ mode: 'open' }).append(composer);
  const handler = vi.fn();
  const unregister = registerShortcut({ key: 'b', modifiers: {}, handler });
  const stop = initShortcuts();
  try {
    composer.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', bubbles: true, composed: true }),
    );
    expect(handler).not.toHaveBeenCalled();
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    expect(handler).toHaveBeenCalledOnce();
  } finally {
    unregister();
    stop();
  }
});
