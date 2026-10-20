import { describe, expect, it } from 'vitest';
import { parseGitHubList } from './github-list.js';

const item = { url: 'https://github.com/o/r/issues/2', title: 'Two', reason: 'Fix first' };
const list = { name: 'Quick wins', groups: [{ name: 'Bugs', items: [item] }] };
const withItems = (items: unknown[]) => ({ ...list, groups: [{ name: 'Group', items }] });

describe('parseGitHubList', () => {
  it('preserves group and item order and reports the repository', () => {
    const ordered = {
      ...list,
      groups: [
        list.groups[0],
        { name: 'Features', items: [{ ...item, url: 'https://github.com/O/R/pull/1' }] },
      ],
    };
    expect(parseGitHubList(ordered)).toEqual({ repository: 'o/r', list: ordered });
  });
  it.each([
    'http://github.com/o/r/issues/2',
    'https://github.com/o/r/issues/2?x=1',
    'https://github.com/o/r/discussions/2',
    'https://github.com/o/r/issues/0',
    'https://github.com@evil.test/o/r/issues/2',
    'https://github.com/../r/issues/2',
    'https://github.com/o/../issues/2',
    'https://github.com/o/r/issues/2/',
  ])('rejects untrusted URLs: %s', (url) => {
    expect(() => parseGitHubList(withItems([{ ...item, url }]))).toThrow();
  });
  it('rejects items from more than one repository', () => {
    const other = { ...item, url: 'https://github.com/other/repo/issues/3' };
    expect(() => parseGitHubList(withItems([item, other]))).toThrow('one repository');
  });
  it('rejects duplicate identities even with case or kind changes', () => {
    const duplicate = { ...item, url: 'https://github.com/O/R/pull/2' };
    expect(() => parseGitHubList(withItems([item, duplicate]))).toThrow('only once');
  });
  it.each([
    null,
    {},
    { name: 'Empty', groups: [] },
    { name: 'Empty', groups: [{ name: 'Bugs', items: [] }] },
    { name: '', groups: list.groups },
  ])('rejects malformed data', (value) => {
    expect(() => parseGitHubList(value)).toThrow();
  });
  it('accepts up to 100 items', () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      ...item,
      url: `https://github.com/o/r/issues/${i + 1}`,
    }));
    expect(parseGitHubList(withItems(items.slice(0, 100))).list.groups[0].items).toHaveLength(100);
    expect(() => parseGitHubList(withItems(items))).toThrow('100 items');
  });
});
