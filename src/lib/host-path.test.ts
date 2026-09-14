import { describe, expect, it } from 'vitest';
import { hostBasename, isAbsoluteHostPath } from './host-path';

describe('host paths', () => {
  it('accepts drive, UNC and POSIX roots', () => {
    expect(isAbsoluteHostPath('C:\\My Projects\\app')).toBe(true);
    expect(isAbsoluteHostPath('D:/code/app')).toBe(true);
    expect(isAbsoluteHostPath('\\\\server\\share\\app')).toBe(true);
    expect(isAbsoluteHostPath('/home/me/app')).toBe(true);
    expect(isAbsoluteHostPath('relative/app')).toBe(false);
  });

  it('extracts project names with either separator', () => {
    expect(hostBasename('C:\\My Projects\\app\\')).toBe('app');
    expect(hostBasename('/home/me/app/')).toBe('app');
  });
});
