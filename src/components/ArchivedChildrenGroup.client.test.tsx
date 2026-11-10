import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setStore, store } from '../store/core';
import type { Task } from '../store/types';
import { ArchivedChildrenGroup } from './ArchivedChildrenGroup';

const disposers: (() => void)[] = [];

beforeEach(() => {
  setStore('tasks', { coord: { id: 'coord' } as Task });
});

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  document.body.replaceChildren();
  setStore('tasks', {});
});

function mount(count: number): HTMLButtonElement {
  const host = document.createElement('div');
  document.body.append(host);
  disposers.push(
    render(
      () => (
        <ArchivedChildrenGroup coordinatorId="coord" count={count}>
          <div data-testid="archived-row">Old child</div>
        </ArchivedChildrenGroup>
      ),
      host,
    ),
  );
  const toggle = host.querySelector('button');
  if (!toggle) throw new Error('toggle not rendered');
  return toggle;
}

describe('ArchivedChildrenGroup', () => {
  it('folds archived children behind one row until the user opens it', () => {
    const toggle = mount(2);
    expect(toggle.textContent).toContain('2 archived');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-testid="archived-row"]')).toBeNull();

    toggle.click();

    expect(store.tasks.coord?.archivedChildrenShown).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-testid="archived-row"]')).not.toBeNull();

    toggle.click();

    expect(document.querySelector('[data-testid="archived-row"]')).toBeNull();
  });

  it('renders nothing without archived children', () => {
    const host = document.createElement('div');
    document.body.append(host);
    disposers.push(
      render(
        () => (
          <ArchivedChildrenGroup coordinatorId="coord" count={0}>
            <div />
          </ArchivedChildrenGroup>
        ),
        host,
      ),
    );
    expect(host.querySelector('button')).toBeNull();
  });
});
