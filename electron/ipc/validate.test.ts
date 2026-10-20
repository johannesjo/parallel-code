import os from 'os';
import { describe, expect, it } from 'vitest';
import { expandHome, validatePath } from './validate.js';

describe('expandHome', () => {
  it('expands a ~/ path that a terminal link passed through', () => {
    expect(expandHome('~/notes/plan.md')).toBe(`${os.homedir()}/notes/plan.md`);
    expect(expandHome('/abs/plan.md')).toBe('/abs/plan.md');
  });

  it('still lets validatePath refuse a ~/../ escape', () => {
    expect(() => validatePath(expandHome('~/../etc/passwd'), 'filePath')).toThrow('".."');
  });
});
