import { describe, expect, it } from 'vitest';
import { CHECK_SUITE_LIMITS } from '../shared/checks.js';
import { analyzeDiff, classifyPath, type DiffFileInput } from './change-scan-rules.js';

const file = (path: string, status: DiffFileInput['status'] = 'M'): DiffFileInput => ({
  path,
  status,
});

describe('classifyPath', () => {
  it.each([
    ['src/a.test.ts', 'test'],
    ['src/__tests__/helper.ts', 'test'],
    ['pkg/a_test.go', 'test'],
    ['tests/test_a.py', 'test'],
    ['e2e/login.spec.ts', 'test'],
    ['package.json', 'execution-surface'],
    ['yarn.lock', 'execution-surface'],
    ['vite.config.ts', 'execution-surface'],
    ['tsconfig.build.json', 'execution-surface'],
    ['src/__mocks__/fs.ts', 'execution-surface'],
    ['e2e/helpers.ts', 'execution-surface'],
    ['.github/workflows/ci.yml', 'execution-surface'],
    ['.env.test', 'execution-surface'],
    ['REVIEW.md', 'execution-surface'],
    ['src/a.snap', 'other'],
    ['src/a.tsx', 'source'],
    ['lib/a.py', 'source'],
    ['README.md', 'other'],
  ])('%s is %s', (path, role) => expect(classifyPath(path)).toBe(role));
});

describe('analyzeDiff', () => {
  it('flags every execution-surface file once', () => {
    const result = analyzeDiff([file('package.json'), file('vite.config.ts'), file('src/a.ts')]);
    expect(result.flags.map((f) => [f.rule, f.file])).toEqual([
      ['execution-surface-changed', 'package.json'],
      ['execution-surface-changed', 'vite.config.ts'],
    ]);
  });

  it('caps lists and reports truncation', () => {
    const many = Array.from({ length: CHECK_SUITE_LIMITS.maxFlags + 5 }, (_, i) =>
      file(`pkg${i}/package.json`),
    );
    const result = analyzeDiff(many);
    expect(result.flags).toHaveLength(CHECK_SUITE_LIMITS.maxFlags);
    expect(result.truncated).toBe(true);
    expect(analyzeDiff([file('package.json')]).truncated).toBeUndefined();
  });
});
