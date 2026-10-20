import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapNode } from '../graph/model';
import { GraphSearch } from './GraphSearch';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  document.body.replaceChildren();
});

const note = (id: string): MapNode => ({ id, title: `Match ${id}`, detail: '' });

function mount(initial: MapNode[]) {
  const [records, setRecords] = createSignal(initial);
  const onPick = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  disposers.push(render(() => <GraphSearch records={records()} onPick={onPick} />, container));
  const input = container.querySelector<HTMLInputElement>('[aria-label="Find nodes"]');
  if (!input) throw new Error('search input not rendered');
  const search = (text: string) => {
    input.focus();
    input.value = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  };
  const arrow = (key: 'ArrowDown' | 'ArrowUp') =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  /** The row the combobox says is highlighted, by its label. */
  const highlighted = () => {
    const id = input.getAttribute('aria-activedescendant');
    return id ? (container.querySelector(`#${CSS.escape(id)}`)?.textContent ?? null) : null;
  };
  return { container, setRecords, search, arrow, highlighted, onPick };
}

describe('GraphSearch', () => {
  it('keeps arrow keys stepping after an agent update shrinks the results', () => {
    const { setRecords, search, arrow, highlighted } = mount(['a', 'b', 'c', 'd'].map(note));
    search('Match');
    arrow('ArrowDown');
    arrow('ArrowDown');
    arrow('ArrowDown');
    expect(highlighted()).toBe('Match d');

    // The agent drops the tail while the user is on the last row. The highlight falls back to
    // the last surviving row, so the next key must wrap to the top rather than jump backwards.
    setRecords(['a', 'b', 'c'].map(note));
    expect(highlighted()).toBe('Match c');
    arrow('ArrowDown');
    expect(highlighted()).toBe('Match a');
  });

  it('wraps upward from the row on screen, without skipping one', () => {
    const { setRecords, search, arrow, highlighted } = mount(['a', 'b', 'c', 'd'].map(note));
    search('Match');
    arrow('ArrowDown');
    arrow('ArrowDown');
    arrow('ArrowDown');
    setRecords(['a', 'b', 'c'].map(note));
    expect(highlighted()).toBe('Match c');
    arrow('ArrowUp');
    expect(highlighted()).toBe('Match b');
  });

  it('leaves Enter and arrows to the input method while composing', () => {
    const { container, search, highlighted, onPick } = mount(['a', 'b'].map(note));
    search('Match');
    const input = container.querySelector('input');
    const key = (name: string) =>
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, isComposing: true, bubbles: true }),
      );
    key('ArrowDown');
    key('ArrowDown');
    expect(highlighted()).toBe('Match a');
    key('Enter');
    expect(onPick).not.toHaveBeenCalled();
  });
});
