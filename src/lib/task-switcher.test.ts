import { describe, expect, it } from 'vitest';

import { filterSwitcherItems } from './task-switcher';

const items = [
  { id: '1', name: 'Fix login', detail: 'api · task/fix-login' },
  { id: '2', name: 'Add dark mode', detail: 'web · task/dark-mode' },
  { id: '3', name: 'Login copy', detail: 'web · task/login-copy' },
];

describe('filterSwitcherItems', () => {
  it('returns every item for an empty query', () => {
    expect(filterSwitcherItems(items, '  ')).toEqual(items);
  });

  it('matches case-insensitively across name and detail, keeping order', () => {
    expect(filterSwitcherItems(items, 'LOGIN').map((i) => i.id)).toEqual(['1', '3']);
  });

  it('requires every word to match', () => {
    expect(filterSwitcherItems(items, 'login web').map((i) => i.id)).toEqual(['3']);
    expect(filterSwitcherItems(items, 'login mobile')).toEqual([]);
  });
});
