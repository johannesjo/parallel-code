import { describe, expect, it } from 'vitest';
import { withLinkScheme } from './dropped-link';

describe('withLinkScheme', () => {
  it('restores the scheme that address-bar text drags leave out', () => {
    expect(withLinkScheme(' claude.ai/code/session_01Rqkmg7Ud1rm7NQg3bP5xsf\n')).toBe(
      'https://claude.ai/code/session_01Rqkmg7Ud1rm7NQg3bP5xsf',
    );
    expect(withLinkScheme('github.com/acme/web/pull/12')).toBe(
      'https://github.com/acme/web/pull/12',
    );
    expect(withLinkScheme('www.github.com/acme/web/issues/3')).toBe(
      'https://www.github.com/acme/web/issues/3',
    );
  });

  it('leaves links with a scheme and other text alone', () => {
    expect(withLinkScheme('https://github.com/acme/web')).toBe('https://github.com/acme/web');
    expect(withLinkScheme('evil.example/github.com/acme/web')).toBe(
      'evil.example/github.com/acme/web',
    );
    expect(withLinkScheme('evil.example/claude.ai/code/session_01Ab')).toBe(
      'evil.example/claude.ai/code/session_01Ab',
    );
    expect(withLinkScheme('github.com.evil.example/acme/web')).toBe(
      'github.com.evil.example/acme/web',
    );
  });
});
