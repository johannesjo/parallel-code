import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleMenuKeyDown } from './menu-keys';

afterEach(() => document.body.replaceChildren());

function mountMenu() {
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  for (const label of ['one', 'two', 'three']) {
    const item = document.createElement('button');
    item.setAttribute('role', 'menuitem');
    item.textContent = label;
    menu.append(item);
  }
  document.body.append(menu);
  const close = vi.fn();
  menu.addEventListener('keydown', (e) => handleMenuKeyDown(e, close));
  const press = (key: string) =>
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  return { menu, close, press };
}

describe('handleMenuKeyDown', () => {
  it('moves through items with arrows, wrapping, and jumps with Home/End', () => {
    const { menu, press } = mountMenu();
    (menu.firstElementChild as HTMLElement).focus();
    press('ArrowUp');
    expect(document.activeElement?.textContent).toBe('three');
    press('ArrowDown');
    expect(document.activeElement?.textContent).toBe('one');
    press('End');
    expect(document.activeElement?.textContent).toBe('three');
    press('Home');
    expect(document.activeElement?.textContent).toBe('one');
  });

  it('closes on Escape and marks the press handled', () => {
    const { menu, close } = mountMenu();
    (menu.firstElementChild as HTMLElement).focus();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.activeElement?.dispatchEvent(escape);
    expect(close).toHaveBeenCalledOnce();
    expect(escape.defaultPrevented).toBe(true);
  });
});
