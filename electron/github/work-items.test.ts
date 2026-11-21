import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runGhJson } from './gh.js';
import {
  listGitHubWorkItems,
  parseWorkItemRef,
  parseWorkItems,
  scopeToRepo,
} from './work-items.js';

vi.mock('./gh.js', async (original) => ({
  ...(await original<typeof import('./gh.js')>()),
  runGhJson: vi.fn(),
}));

const item = (number: number, url: string) => ({
  number,
  title: `Item ${number}`,
  url,
  updatedAt: '2026-10-01T00:00:00Z',
  author: { login: 'dev' },
  labels: [],
});

describe('listGitHubWorkItems', () => {
  beforeEach(() => vi.mocked(runGhJson).mockReset());

  it('finds a pasted issue or PR URL through its number', async () => {
    vi.mocked(runGhJson)
      .mockResolvedValueOnce([item(120, 'https://github.com/o/r/issues/120')])
      .mockResolvedValueOnce([
        item(12, 'https://github.com/o/r/pull/12'),
        item(13, 'https://github.com/o/r/pull/13'),
      ]);
    const items = await listGitHubWorkItems('/p', 'https://github.com/O/R/pull/12/files');
    expect(items.map((i) => i.number)).toEqual([12]);
    for (const [args] of vi.mocked(runGhJson).mock.calls) {
      expect(args[args.indexOf('--search') + 1]).toBe('12');
    }
  });

  it('lists nothing for a URL of another repository', async () => {
    vi.mocked(runGhJson)
      .mockResolvedValueOnce([item(12, 'https://github.com/o/r/issues/12')])
      .mockResolvedValueOnce([]);
    expect(await listGitHubWorkItems('/p', 'https://github.com/other/r/issues/12')).toEqual([]);
  });
});

describe('parseWorkItemRef', () => {
  it('reads issue and PR URLs, with or without a scheme', () => {
    const ref = { host: 'github.com', repo: 'o/r', number: 12 };
    expect(parseWorkItemRef('https://github.com/o/r/issues/12')).toEqual(ref);
    expect(parseWorkItemRef(' https://www.github.com/o/r/pull/12#discussion_r1 ')).toEqual(ref);
    expect(parseWorkItemRef('github.com/o/r/pull/12/files')).toEqual(ref);
    expect(parseWorkItemRef('https://ghe.example.com/o/r/issues/12')?.host).toBe('ghe.example.com');
  });

  it('leaves ordinary searches alone', () => {
    expect(parseWorkItemRef('12')).toBeNull();
    expect(parseWorkItemRef('crash on save')).toBeNull();
    expect(parseWorkItemRef('https://github.com/o/r')).toBeNull();
    expect(parseWorkItemRef('https://github.com/o/r/issues/new')).toBeNull();
    expect(parseWorkItemRef('https://u:p@github.com/o/r/issues/12')).toBeNull();
  });
});

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
