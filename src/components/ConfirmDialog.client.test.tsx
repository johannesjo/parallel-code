import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
});

const confirmButton = () =>
  [...document.querySelectorAll('button')].find((button) => button.textContent === 'Merge');

describe('ConfirmDialog', () => {
  it('shows the confirm icon until loading replaces it with the spinner', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const [loading, setLoading] = createSignal(false);
    disposers.push(
      render(
        () => (
          <ConfirmDialog
            open={true}
            title="Merge"
            message="Merge the branch?"
            confirmLabel="Merge"
            confirmIcon={<svg data-testid="merge-icon" />}
            confirmLoading={loading()}
            onConfirm={vi.fn()}
            onCancel={vi.fn()}
          />
        ),
        host,
      ),
    );

    expect(confirmButton()?.querySelector('[data-testid="merge-icon"]')).not.toBeNull();
    expect(confirmButton()?.querySelector('.inline-spinner')).toBeNull();

    setLoading(true);
    expect(confirmButton()?.querySelector('[data-testid="merge-icon"]')).toBeNull();
    expect(confirmButton()?.querySelector('.inline-spinner')).not.toBeNull();
  });

  it('keeps a not-yet-ready confirm in the Tab order without acting on it', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const [disabled, setDisabled] = createSignal(true);
    const onConfirm = vi.fn();
    disposers.push(
      render(
        () => (
          <ConfirmDialog
            open={true}
            title="Merge"
            message="Merge the branch?"
            confirmLabel="Merge"
            confirmDisabled={disabled()}
            confirmFocusable
            onConfirm={onConfirm}
            onCancel={vi.fn()}
          />
        ),
        host,
      ),
    );

    // Natively disabled buttons drop out of the Tab order, shifting typed key sequences.
    expect(confirmButton()?.disabled).toBe(false);
    expect(confirmButton()?.getAttribute('aria-disabled')).toBe('true');
    confirmButton()?.click();
    expect(onConfirm).not.toHaveBeenCalled();

    setDisabled(false);
    expect(confirmButton()?.getAttribute('aria-disabled')).toBe('false');
    confirmButton()?.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
