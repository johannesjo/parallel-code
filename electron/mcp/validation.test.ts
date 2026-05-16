import { describe, it, expect } from 'vitest';
import { validateBranchName, validateUUID } from './validation.js';

describe('validateBranchName', () => {
  it('accepts a valid branch name', () => {
    expect(validateBranchName('feature/my-branch')).toBe('feature/my-branch');
  });

  it('accepts names with numbers and hyphens', () => {
    expect(validateBranchName('fix/issue-123')).toBe('fix/issue-123');
  });

  it('rejects non-string', () => {
    expect(() => validateBranchName(42)).toThrow('must be a string');
  });

  it('rejects empty string', () => {
    expect(() => validateBranchName('')).toThrow('non-empty');
  });

  it('accepts a normal branch name like main', () => {
    expect(validateBranchName('main')).toBe('main');
  });

  it('rejects HEAD', () => {
    expect(() => validateBranchName('HEAD')).toThrow('HEAD');
  });

  it('accepts FETCH_HEAD and other git pseudorefs (git allows them as branch names)', () => {
    expect(validateBranchName('FETCH_HEAD')).toBe('FETCH_HEAD');
    expect(validateBranchName('ORIG_HEAD')).toBe('ORIG_HEAD');
  });

  it('rejects leading hyphen', () => {
    expect(() => validateBranchName('-bad')).toThrow();
  });

  it('rejects leading dot', () => {
    expect(() => validateBranchName('.hidden')).toThrow();
  });

  it('rejects leading slash', () => {
    expect(() => validateBranchName('/bad')).toThrow();
  });

  it('rejects trailing slash', () => {
    expect(() => validateBranchName('bad/')).toThrow();
  });

  it('rejects trailing dot', () => {
    expect(() => validateBranchName('bad.')).toThrow();
  });

  it('rejects .lock suffix on full name', () => {
    expect(() => validateBranchName('foo.lock')).toThrow();
  });

  it('rejects .lock on a path component (not just the final segment)', () => {
    expect(() => validateBranchName('foo.lock/bar')).toThrow();
  });

  it('rejects double dot in middle', () => {
    expect(() => validateBranchName('foo..bar')).toThrow();
  });

  it('rejects double slash', () => {
    expect(() => validateBranchName('foo//bar')).toThrow();
  });

  it('rejects @{ sequence', () => {
    expect(() => validateBranchName('foo@{bar}')).toThrow();
  });

  it('rejects path component starting with dot', () => {
    expect(() => validateBranchName('feature/.hidden')).toThrow();
  });

  it('rejects colon', () => {
    expect(() => validateBranchName('foo:bar')).toThrow();
  });

  it('rejects caret', () => {
    expect(() => validateBranchName('foo^bar')).toThrow();
  });

  it('rejects tilde', () => {
    expect(() => validateBranchName('foo~bar')).toThrow();
  });

  it('rejects shell metacharacters', () => {
    for (const ch of [
      '`',
      '$',
      '(',
      ')',
      '{',
      '}',
      '<',
      '>',
      '\\',
      "'",
      '*',
      '?',
      '!',
      '#',
      ';',
      '|',
      '&',
      '"',
    ]) {
      expect(() => validateBranchName(`foo${ch}bar`)).toThrow();
    }
  });

  it('uses custom field name in error', () => {
    expect(() => validateBranchName(42, 'myField')).toThrow('myField');
  });
});

describe('validateUUID', () => {
  it('accepts a valid v4 UUID', () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    expect(validateUUID(id, 'id')).toBe(id);
  });

  it('accepts uppercase v4 UUID', () => {
    expect(validateUUID('F47AC10B-58CC-4372-A567-0E02B2C3D479', 'id')).toBe(
      'F47AC10B-58CC-4372-A567-0E02B2C3D479',
    );
  });

  it('rejects non-string', () => {
    expect(() => validateUUID(123, 'id')).toThrow('must be a string');
  });

  it('rejects non-v4 version nibble', () => {
    // version nibble = 1 (v1 UUID)
    expect(() => validateUUID('f47ac10b-58cc-1372-a567-0e02b2c3d479', 'id')).toThrow();
  });

  it('rejects invalid variant nibble', () => {
    // variant nibble = 4 (not 8/9/a/b)
    expect(() => validateUUID('f47ac10b-58cc-4372-4567-0e02b2c3d479', 'id')).toThrow();
  });

  it('rejects malformed UUID', () => {
    expect(() => validateUUID('not-a-uuid', 'id')).toThrow();
  });

  it('rejects UUID with path traversal attempt', () => {
    expect(() => validateUUID('../../tmp/x-0000-4000-8000-000000000000', 'id')).toThrow();
  });

  it('uses custom field name in error', () => {
    expect(() => validateUUID('bad', 'myField')).toThrow('myField');
  });
});
