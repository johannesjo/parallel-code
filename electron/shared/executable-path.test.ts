import { describe, expect, it } from 'vitest';
import { isExecutablePath } from './executable-path.js';

describe('isExecutablePath', () => {
  it('flags files the default app would run', () => {
    expect(isExecutablePath('/w/deploy.sh')).toBe(true);
    expect(isExecutablePath('/w/App.AppImage')).toBe(true);
    expect(isExecutablePath('/Applications/Foo.app/')).toBe(true);
  });

  it('passes documents and code', () => {
    expect(isExecutablePath('/w/README.md')).toBe(false);
    expect(isExecutablePath('/w/run.ts')).toBe(false);
  });
});
