import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineInput } from './InlineInput';
import { invoke } from '../lib/ipc';
import { setStore } from '../store/core';

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));

const disposers: Array<() => void> = [];

/** Paste a clipboard image and let the async resolver settle. */
async function pasteImage(input: HTMLInputElement) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { items: [{ type: 'image/png', kind: 'file' }] },
  });
  input.dispatchEvent(event);
  await Promise.resolve();
  await Promise.resolve();
}

function mount(onSubmit: (text: string, mode: string, imagePaths?: string[]) => void) {
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(render(() => <InlineInput onSubmit={onSubmit} onDismiss={() => {}} />, container));
  return container;
}

function modeButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label);
}

function attachmentChip(container: HTMLElement) {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    /image[s]? ×$/.test(b.textContent ?? ''),
  );
}

beforeEach(() => {
  setStore('askCodeProvider', 'minimax');
  vi.mocked(invoke).mockResolvedValue({ kind: 'image', path: '/tmp/shot.png' });
});

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
  setStore('askCodeProvider', 'claude');
  vi.mocked(invoke).mockReset();
});

describe('InlineInput image attachment', () => {
  it('does not advertise an attachment in Comment mode, where submit discards it', async () => {
    const onSubmit = vi.fn();
    const container = mount(onSubmit);
    const input = container.querySelector('input') as HTMLInputElement;

    // Comment mode is the default, and it is the mode the user lands in when
    // the inline input opens from a selection.
    await pasteImage(input);

    expect(attachmentChip(container)).toBeUndefined();
    // Hidden chip must not mean silence: the accepted paste says where it went.
    expect(container.querySelector('[aria-live]')?.textContent).toBe(
      'Image attached — switch to Ask to send it.',
    );

    input.value = 'why is this here?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onSubmit).toHaveBeenCalledWith('why is this here?', 'review', undefined);
  });

  it('keeps the pasted image across a switch to Ask mode and sends it', async () => {
    const onSubmit = vi.fn();
    const container = mount(onSubmit);
    const input = container.querySelector('input') as HTMLInputElement;

    await pasteImage(input);
    modeButton(container, 'Ask')?.click();

    expect(attachmentChip(container)?.textContent).toBe('1 image ×');
    // The chip now carries the state, so the notice stands down.
    expect(container.querySelector('[aria-live]')).toBeNull();

    input.value = 'what does this show?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onSubmit).toHaveBeenCalledWith('what does this show?', 'ask', ['/tmp/shot.png']);
  });
});
