import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { DialogFooter } from './DialogFooter';

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
});

function mount(ui: () => ReturnType<typeof DialogFooter>) {
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(render(ui, host));
  return host;
}

describe('DialogFooter', () => {
  it('keeps the error slot in place before and after an error appears', () => {
    const [error, setError] = createSignal('');
    const host = mount(() => (
      <DialogFooter error={error()}>
        <button type="button">Save</button>
      </DialogFooter>
    ));
    const slot = host.querySelector('[role="alert"]');
    expect(slot).not.toBeNull();
    expect(slot?.textContent).toBe('');

    setError('Disk full');
    expect(host.querySelector('[role="alert"]')).toBe(slot);
    expect(slot?.textContent).toBe('Disk full');
  });

  it('shows a note while keeping the error slot ready', () => {
    const host = mount(() => (
      <DialogFooter note="Needs a name">
        <button type="button">Save</button>
      </DialogFooter>
    ));
    expect(host.textContent).toContain('Needs a name');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('');
  });

  it('places the start action before the buttons', () => {
    const host = mount(() => (
      <DialogFooter start={<button type="button">Delete</button>}>
        <button type="button">Save</button>
      </DialogFooter>
    ));
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['Delete', 'Save']);
  });
});
