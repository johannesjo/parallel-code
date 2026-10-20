import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInputHistory } from './input-history';

function setup(initialEntries: string[], initial = '') {
  const entries = [...initialEntries];
  const state = { draft: initial };
  const history = createInputHistory({
    entries: () => entries,
    draft: () => state.draft,
    onDraft: (text) => (state.draft = text),
  });
  const area = document.createElement('textarea');
  const press = (key: string, caret = state.draft.length) => {
    area.value = state.draft;
    area.setSelectionRange(caret, caret);
    let handled = false;
    area.addEventListener('keydown', (e) => (handled = history.onKeyDown(e)), { once: true });
    area.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
    return handled;
  };
  return { state, press, entries, area };
}

describe('createInputHistory', () => {
  afterEach(() => vi.restoreAllMocks());
  it('cycles back through earlier messages and restores the draft', () => {
    const { state, press } = setup(['one', 'two'], 'typing');
    press('ArrowUp');
    expect(state.draft).toBe('two');
    press('ArrowUp');
    expect(state.draft).toBe('one');
    press('ArrowUp');
    expect(state.draft).toBe('one');
    press('ArrowDown');
    press('ArrowDown');
    expect(state.draft).toBe('typing');
    expect(press('ArrowDown')).toBe(false);
  });

  it('leaves the key alone with no history', () => {
    expect(setup([]).press('ArrowUp')).toBe(false);
  });

  it('stops browsing once the user edits the recalled text', () => {
    const { state, press } = setup(['one', 'two']);
    press('ArrowUp');
    state.draft = 'two!';
    expect(press('ArrowDown')).toBe(false);
  });

  it('starts from the newest entry again after a send grows the list', () => {
    const { state, entries, press } = setup(['one']);
    press('ArrowUp');
    entries.push('one');
    state.draft = '';
    press('ArrowUp');
    expect(state.draft).toBe('one');
    press('ArrowUp');
    expect(state.draft).toBe('one');
  });

  it('does not recall while the caret is inside a multi-line draft', () => {
    const { state, press } = setup(['one'], 'a\nb');
    expect(press('ArrowUp')).toBe(false);
    expect(state.draft).toBe('a\nb');
  });
});

// happy-dom has no layout; supply visual line positions for the Range API.
describe('wrapped input history', () => {
  afterEach(() => vi.restoreAllMocks());

  it('moves through visual lines before recalling and restoring history', () => {
    const message = 'a long message wrapping onto three lines';
    const { area, state, press } = setup([message], 'draft');
    Object.defineProperty(area, 'clientWidth', { value: 120 });
    area.style.padding = '0px';
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
      return { top: Math.floor(this.startOffset / 15) * 22 } as DOMRect;
    });

    expect(press('ArrowUp')).toBe(true);
    expect(state.draft).toBe(message);
    expect(press('ArrowUp', 20)).toBe(false);
    expect(press('ArrowDown', 20)).toBe(false);
    expect(press('ArrowDown', 5)).toBe(false);
    expect(state.draft).toBe(message);
    expect(press('ArrowDown', 35)).toBe(true);
    expect(state.draft).toBe('draft');

    state.draft = message;
    expect(press('ArrowUp', 20)).toBe(false);
    expect(press('ArrowUp', 5)).toBe(true);
    expect(document.body.children).toHaveLength(0);
  });

  it('navigates explicit lines in recalled messages before restoring the draft', () => {
    const { state, press } = setup(['first\nmiddle\nlast'], 'draft');
    expect(press('ArrowUp')).toBe(true);
    expect(press('ArrowDown', 2)).toBe(false);
    expect(press('ArrowDown', 8)).toBe(false);
    expect(press('ArrowUp', 8)).toBe(false);
    expect(press('ArrowDown', 15)).toBe(true);
    expect(state.draft).toBe('draft');
  });
});
