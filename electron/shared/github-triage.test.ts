import { describe, expect, it } from 'vitest';
import { issueCategories, issueCategory } from './github-triage.js';

describe('triage classification', () => {
  it.each([
    ['🐛 bug', 'bug'],
    ['type: bug', 'bug'],
    ['kind/feature', 'feature'],
    ['Type: Enhancement', 'feature'],
    ['question', 'discussion'],
    ['RFC', 'discussion'],
    ['debugging', null],
    ['feature-complete', null],
    ['needs discussion', null],
  ])('classifies the explicit label %s without matching unrelated words', (label, kind) => {
    expect(issueCategory(label)).toBe(kind);
  });
  it('keeps native issue types, multiple classifications, and PRs distinct', () => {
    expect(issueCategories({ kind: 'issue', issueType: 'Bug', labels: ['enhancement'] })).toEqual([
      'bug',
      'feature',
    ]);
    expect(issueCategories({ kind: 'pr', labels: ['bug'] })).toEqual(['pr']);
    expect(issueCategories({ kind: 'issue', labels: ['urgent'] })).toEqual(['issue']);
  });
});
