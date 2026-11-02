import { describe, expect, it } from 'vitest';
import { sanitizeProjectIcon } from './project-icon';

describe('sanitizeProjectIcon', () => {
  it('keeps a known icon id', () => {
    expect(sanitizeProjectIcon('terminal')).toBe('terminal');
  });

  it('still accepts the ids of the first icon set, so saved choices survive', () => {
    for (const id of ['folder', 'github', 'target', 'activity', 'layers', 'kanban', 'clock']) {
      expect(sanitizeProjectIcon(id)).toBe(id);
    }
  });

  it('drops unknown ids and non-strings so the project falls back to its square', () => {
    expect(sanitizeProjectIcon('🚀')).toBeUndefined();
    expect(sanitizeProjectIcon('not-an-icon')).toBeUndefined();
    expect(sanitizeProjectIcon(undefined)).toBeUndefined();
    expect(sanitizeProjectIcon(42)).toBeUndefined();
  });
});
