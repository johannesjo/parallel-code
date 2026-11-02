import { describe, expect, it } from 'vitest';
import { isStaleBuildError } from './stale-build';

describe('isStaleBuildError', () => {
  it('recognises a lazy chunk that vanished after an in-place upgrade', () => {
    const err = new TypeError(
      'Failed to fetch dynamically imported module: file:///opt/Parallel%20Code/resources/app.asar/dist/assets/ThinkingSpace-BN5t-x4t.js',
    );
    expect(isStaleBuildError(err)).toBe(true);
  });

  it("recognises Vite's failure to preload a chunk's stylesheet", () => {
    expect(isStaleBuildError(new Error('Unable to preload CSS for /assets/Foo-abc.css'))).toBe(
      true,
    );
  });

  it('ignores ordinary errors and non-errors', () => {
    expect(isStaleBuildError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isStaleBuildError('Failed to fetch dynamically imported module')).toBe(false);
    expect(isStaleBuildError(undefined)).toBe(false);
  });
});
