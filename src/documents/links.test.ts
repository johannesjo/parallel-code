import { describe, expect, it } from 'vitest';
import { headingSlug, resolveDocumentLink } from './links';

describe('resolveDocumentLink', () => {
  it('keeps web links external', () => {
    expect(resolveDocumentLink('https://example.com/x', 'docs/a.md')).toEqual({
      kind: 'external',
      url: 'https://example.com/x',
    });
    expect(resolveDocumentLink('mailto:me@example.com', 'a.md')).toEqual({
      kind: 'external',
      url: 'mailto:me@example.com',
    });
  });

  it('resolves relative paths against the document folder', () => {
    expect(resolveDocumentLink('./b.md', 'docs/a.md')).toEqual({ kind: 'file', path: 'docs/b.md' });
    expect(resolveDocumentLink('../readme.md#plan', 'docs/a.md')).toEqual({
      kind: 'file',
      path: 'readme.md',
      anchor: 'plan',
    });
    expect(resolveDocumentLink('/adr/0001.md', 'docs/deep/a.md')).toEqual({
      kind: 'file',
      path: 'adr/0001.md',
    });
    expect(resolveDocumentLink('my%20notes.md', 'a.md')).toEqual({
      kind: 'file',
      path: 'my notes.md',
    });
  });

  it('treats a bare hash as an anchor in the same document', () => {
    expect(resolveDocumentLink('#the-plan', 'a.md')).toEqual({ kind: 'anchor', id: 'the-plan' });
  });

  it('refuses what it cannot follow', () => {
    expect(resolveDocumentLink('../../etc/passwd', 'docs/a.md')).toBeNull();
    expect(resolveDocumentLink('file:///etc/passwd', 'a.md')).toBeNull();
    expect(resolveDocumentLink('javascript:alert(1)', 'a.md')).toBeNull();
    expect(resolveDocumentLink('', 'a.md')).toBeNull();
  });
});

describe('headingSlug', () => {
  it('matches the slugs Markdown anchors use', () => {
    expect(headingSlug('The Plan: Part 2!')).toBe('the-plan-part-2');
    expect(headingSlug('  Über uns ')).toBe('über-uns');
  });
});
