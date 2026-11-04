import { describe, expect, it } from 'vitest';
import { sanitizeRemotePr } from './task-context.js';

describe('sanitizeRemotePr', () => {
  const url = 'https://github.com/owner/repo/pull/42';

  it('keeps a GitHub pull request with its status and babysit flag', () => {
    expect(sanitizeRemotePr({ url, label: 'CI failed', kind: 'failed', babysit: true })).toEqual({
      url,
      label: 'CI failed',
      kind: 'failed',
      babysit: true,
    });
  });

  it('drops anything that is not a GitHub pull request link', () => {
    expect(sanitizeRemotePr({ url: 'javascript:alert(1)' })).toBeUndefined();
    expect(sanitizeRemotePr({ url: 'http://github.com/owner/repo/pull/1' })).toBeUndefined();
    expect(sanitizeRemotePr({ url: 'https://u:p@github.com/owner/repo/pull/1' })).toBeUndefined();
    expect(sanitizeRemotePr({ url: 'https://github.com/owner/repo/issues/1' })).toBeUndefined();
    expect(sanitizeRemotePr('nope')).toBeUndefined();
    expect(sanitizeRemotePr(undefined)).toBeUndefined();
  });

  it('accepts pull requests on enterprise hosts', () => {
    const enterprise = 'https://git.example.com/team/app/pull/7';
    expect(sanitizeRemotePr({ url: enterprise })).toEqual({ url: enterprise });
  });

  it('drops unknown kinds, empty labels and non-true babysit flags', () => {
    expect(sanitizeRemotePr({ url, label: '', kind: 'exploded', babysit: 'yes' })).toEqual({ url });
  });
});
