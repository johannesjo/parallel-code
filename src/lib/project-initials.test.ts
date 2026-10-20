import { describe, expect, it } from 'vitest';
import { projectInitials } from './project-initials';

describe('projectInitials', () => {
  it.each([
    ['parallel-code', 'PC'],
    ['Super Productivity', 'SP'],
    ['acme_web.api', 'AW'],
    ['superproductivity', 'Su'],
    ['X', 'X'],
    ['  spaced   name  ', 'SN'],
    ['3d-viewer', '3V'],
  ])('abbreviates %j to %j', (name, expected) => {
    expect(projectInitials(name)).toBe(expected);
  });

  it('falls back when a name carries no letters or digits', () => {
    expect(projectInitials('///')).toBe('?');
  });

  it('keeps whole code points for non-latin names', () => {
    expect(projectInitials('日本語プロジェクト')).toBe('日本');
  });
});
