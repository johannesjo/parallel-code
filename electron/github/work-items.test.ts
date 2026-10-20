import { describe, expect, it } from 'vitest';
import { parseWorkItems, scopeToRepo } from './work-items.js';

describe('scopeToRepo', () => {
  it('strips qualifiers that widen the search beyond the project repo', () => {
    expect(scopeToRepo('crash repo:other/x is:open org:acme -user:bob')).toBe('crash is:open');
    expect(scopeToRepo('label:bug login')).toBe('label:bug login');
  });
});

describe('parseWorkItems', () => {
  it('maps gh list output and skips malformed entries', () => {
    const raw = [
      {
        number: 5,
        title: 'Fix login',
        url: 'https://github.com/o/r/pull/5',
        updatedAt: '2026-10-01T00:00:00Z',
        author: { login: 'dev' },
        labels: [{ name: 'bug' }, {}],
        isDraft: true,
        baseRefName: 'main',
        isCrossRepository: true,
      },
      { number: 'x', title: 'bad' },
    ];
    expect(parseWorkItems(raw, 'pr')).toEqual([
      {
        kind: 'pr',
        number: 5,
        title: 'Fix login',
        url: 'https://github.com/o/r/pull/5',
        author: 'dev',
        updatedAt: '2026-10-01T00:00:00Z',
        labels: ['bug'],
        isDraft: true,
        baseRefName: 'main',
        isCrossRepository: true,
      },
    ]);
  });

  it('omits isDraft for issues and handles non-arrays', () => {
    const [issue] = parseWorkItems([{ number: 1, title: 't', url: 'u', author: null }], 'issue');
    expect(issue).not.toHaveProperty('isDraft');
    expect(issue.author).toBe('unknown');
    expect(parseWorkItems(null, 'issue')).toEqual([]);
  });
});
