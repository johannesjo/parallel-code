import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TourNotes } from './TourNotes';

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
});

function mount(props: { value: string; onSend?: () => void }) {
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(render(() => <TourNotes onInput={() => undefined} {...props} />, host));
  const field = host.querySelector('textarea');
  if (!field) throw new Error('Notes field is missing');
  return { host, field };
}

const ctrlEnter = (extra: KeyboardEventInit = {}) =>
  new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, ...extra });

describe('TourNotes', () => {
  it('is a plain scratchpad where there is no agent to send to', () => {
    const { host, field } = mount({ value: '' });
    expect(field.placeholder).toBe('Notes');
    expect(host.querySelector('button')).toBeNull();
  });

  it('sends on Ctrl+Enter, but not when empty or while composing', () => {
    const onSend = vi.fn();
    const { field } = mount({ value: '  ', onSend });
    expect(field.placeholder).toBe('Send to main agent');
    field.dispatchEvent(ctrlEnter());
    expect(onSend).not.toHaveBeenCalled();

    document.body.replaceChildren();
    const filled = mount({ value: 'Learned', onSend }).field;
    filled.dispatchEvent(ctrlEnter({ isComposing: true }));
    expect(onSend).not.toHaveBeenCalled();
    filled.dispatchEvent(ctrlEnter());
    expect(onSend).toHaveBeenCalledOnce();
  });
});
