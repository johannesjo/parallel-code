import { describe, expect, it } from 'vitest';

import { filterSwitcherItems, parseSwitcherQuery } from './task-switcher';

const items = [
  { id: '1', name: 'Fix login', detail: 'api · task/fix-login' },
  { id: '2', name: 'Add dark mode', detail: 'web · task/dark-mode' },
  { id: '3', name: 'Login copy', detail: 'web · task/login-copy' },
];

const ids = (list: { id: string }[]) => list.map((i) => i.id);

describe('filterSwitcherItems', () => {
  it('returns every item for an empty query', () => {
    expect(filterSwitcherItems(items, '  ')).toEqual(items);
  });

  it('matches case-insensitively across name and detail', () => {
    expect(ids(filterSwitcherItems(items, 'LOGIN')).sort()).toEqual(['1', '3']);
    expect(ids(filterSwitcherItems(items, 'api'))).toEqual(['1']);
  });

  it('requires every word to match', () => {
    expect(ids(filterSwitcherItems(items, 'login web'))).toEqual(['3']);
    expect(filterSwitcherItems(items, 'login mobile')).toEqual([]);
  });

  it('ranks a name prefix first, then word starts, then substrings, else keeping order', () => {
    const list = [
      { id: 'inside', name: 'Hotfix', detail: '' },
      { id: 'word', name: 'Quick fix', detail: '' },
      { id: 'prefix', name: 'Fix login', detail: '' },
      { id: 'word2', name: 'Another fix', detail: '' },
    ];
    expect(ids(filterSwitcherItems(list, 'fix'))).toEqual(['prefix', 'word', 'word2', 'inside']);
  });

  it('searches hidden keywords, and the detail only when asked to', () => {
    const actions = [
      { id: 'finish', name: 'Finish task', detail: 'Dark mode', keywords: 'merge push' },
      { id: 'zoom', name: 'Zoom in', detail: '' },
    ];
    expect(ids(filterSwitcherItems(actions, 'merge'))).toEqual(['finish']);
    expect(filterSwitcherItems(actions, 'dark', { searchDetail: false })).toEqual([]);
    expect(ids(filterSwitcherItems(actions, 'dark'))).toEqual(['finish']);
  });
});

describe('parseSwitcherQuery', () => {
  it('narrows to actions on a leading ">"', () => {
    expect(parseSwitcherQuery(' >zoom')).toEqual({ actionsOnly: true, text: 'zoom' });
    expect(parseSwitcherQuery('zoom > in')).toEqual({ actionsOnly: false, text: 'zoom > in' });
  });
});
