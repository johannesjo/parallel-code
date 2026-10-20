import { describe, expect, it } from 'vitest';
import {
  parseGitHubUrl,
  extractGitHubUrl,
  sameGitHubIssue,
  taskNameFromGitHubUrl,
} from './github-url';

describe('enterprise PR URLs', () => {
  it('recognizes PRs on arbitrary hosts for task naming', () => {
    const parsed = parseGitHubUrl('https://code.acme.test/team/repo/pull/42/files');
    expect(parsed).toEqual({ org: 'team', repo: 'repo', type: 'pull', number: '42' });
    expect(parsed && taskNameFromGitHubUrl(parsed)).toBe('pr 42');
  });

  it('extracts enterprise PR links after unrelated URLs', () => {
    expect(
      extractGitHubUrl('See https://example.com/docs/page then https://code.acme.test/o/r/pull/42'),
    ).toBe('https://code.acme.test/o/r/pull/42');
  });

  it.each([
    'https://example.com/docs/page',
    'https://code.acme.test/o/r/pull/no',
    'https://user:pass@code.acme.test/o/r/pull/42',
    'http://code.acme.test/o/r/pull/42',
  ])('rejects %s', (url) => expect(parseGitHubUrl(url)).toBeNull());

  it('keeps public GitHub repository and issue parsing', () => {
    expect(parseGitHubUrl('https://github.com/o/r')).toEqual({ org: 'o', repo: 'r' });
    expect(parseGitHubUrl('https://github.com/o/r/issues/4')?.number).toBe('4');
  });
});

describe('issue task identity', () => {
  it('matches repository case and decorated issue links', () => {
    expect(
      sameGitHubIssue(
        'https://github.com/Owner/Repo/issues/7#comment-1',
        'https://github.com/owner/repo/issues/7',
      ),
    ).toBe(true);
  });
  it.each([
    undefined,
    'https://github.com/other/repo/issues/7',
    'https://github.com/owner/other/issues/7',
    'https://github.com/owner/repo/issues/8',
    'https://github.com/owner/repo/pull/7',
    'https://evil.test/owner/repo/issues/7',
  ])('does not link %s to another issue', (url) => {
    expect(sameGitHubIssue(url, 'https://github.com/owner/repo/issues/7')).toBe(false);
  });
});
