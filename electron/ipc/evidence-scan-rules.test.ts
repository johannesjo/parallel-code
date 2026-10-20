import { describe, expect, it } from 'vitest';
import { EVIDENCE_LIMITS } from '../shared/evidence.js';
import {
  analyzeDiff,
  classifyPath,
  extractTitle,
  testKind,
  type DiffFileInput,
} from './evidence-scan-rules.js';

function patch(removed: string[], added: string[], start = 10): string {
  const body = [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join('\n');
  return `@@ -${start},${removed.length} +${start},${added.length} @@\n${body}\n`;
}

function file(
  path: string,
  status: DiffFileInput['status'],
  removed: string[] = [],
  added: string[] = [],
  oldPath?: string,
): DiffFileInput {
  return {
    path,
    status,
    ...(oldPath && { oldPath }),
    added: added.length,
    removed: removed.length,
    patch: patch(removed, added),
  };
}

const analyze = (
  files: DiffFileInput[],
  coveringTests = [] as { testFile: string; sources: string[] }[],
) => analyzeDiff({ files, coveringTests });
const rules = (files: DiffFileInput[]) => analyze(files).flags.map((f) => f.rule);

describe('classifyPath and testKind', () => {
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

  it('separates e2e from unit tests', () => {
    expect(testKind('e2e/a.spec.ts')).toBe('e2e');
    expect(testKind('src/a.e2e.test.ts')).toBe('e2e');
    expect(testKind('cypress/a.cy.ts')).toBe('e2e');
    expect(testKind('src/a.test.ts')).toBe('unit');
  });
});

it('changes execution flag identity when the reviewed patch changes', () => {
  const first = analyze([file('package.json', 'M', ['old'], ['reviewed'])]).flags[0];
  const again = analyze([file('package.json', 'M', ['old'], ['reviewed'])]).flags[0];
  const changed = analyze([file('package.json', 'M', ['old'], ['new command'])]).flags[0];
  expect(first.id).toBe(again.id);
  expect(changed.id).not.toBe(first.id);
});

describe('extractTitle', () => {
  it.each([
    ["it('does x', () => {", 'does x'],
    ['test.skip("a b", async () => {', 'a b'],
    ['  describe.only(`group`, () => {', 'group'],
    ["test.describe('suite', () => {", 'suite'],
  ])('%s', (line, title) => expect(extractTitle(line)).toBe(title));

  it('ignores computed titles and lookalikes', () => {
    expect(extractTitle('it(`a ${b}`, () => {})')).toBeUndefined();
    expect(extractTitle("submit('x')")).toBeUndefined();
    expect(extractTitle("foo.it('x')")).toBeUndefined();
  });
});

describe('test-weakened rules', () => {
  it('flags a deleted test file whose subject remains', () => {
    const result = analyze([file('src/a.test.ts', 'D', ["it('x', () => {"])]);
    expect(result.flags).toMatchObject([
      { rule: 'test-file-deleted', category: 'test-weakened', file: 'src/a.test.ts' },
    ]);
  });

  it('downgrades a deletion together with its source to info', () => {
    const result = analyze([file('src/a.test.ts', 'D'), file('src/a.tsx', 'D')]);
    expect(result.flags).toMatchObject([{ rule: 'test-deleted-with-source', category: 'info' }]);
  });

  it('flags a removed title with its old line number', () => {
    const result = analyze([file('src/a.test.ts', 'M', ["it('keeps x', () => {"])]);
    expect(result.flags).toMatchObject([
      { rule: 'test-removed', category: 'test-weakened', line: 10 },
    ]);
    expect(result.tests).toEqual([
      { file: 'src/a.test.ts', kind: 'unit', title: 'keeps x', change: 'removed' },
    ]);
  });

  it('treats a title removed and re-added in one file as changed', () => {
    const result = analyze([
      file(
        'src/a.test.ts',
        'M',
        ["it('x', () => {", '  expect(1)'],
        ["it('x', () => {", '  expect(2)'],
      ),
    ]);
    expect(result.flags).toEqual([]);
    expect(result.tests).toMatchObject([{ title: 'x', change: 'changed' }]);
  });

  it('does not flag a rename that preserves titles', () => {
    const result = analyze([
      file('src/b.test.ts', 'R', ["it('x', () => {"], ["it('x', () => {"], 'src/a.test.ts'),
    ]);
    expect(result.flags).toEqual([]);
  });

  it('does not flag a title moved to another file', () => {
    const result = analyze([
      file('src/a.test.ts', 'M', ["it('x', () => {"]),
      file('src/b.test.ts', 'M', [], ["it('x', () => {"]),
    ]);
    expect(result.flags).toEqual([]);
  });

  it.each([
    "it.skip('x', () => {",
    "describe.only('x', () => {",
    "xit('x', () => {",
    "it.todo('x')",
    "test.fixme('x', () => {",
    '@pytest.mark.skip(reason="no")',
    '\tt.Skip("later")',
  ])('flags %s as test-disabled', (line) => {
    expect(rules([file('src/a.test.ts', 'M', [], [line])])).toContain('test-disabled');
  });
});

describe('needs-decision rules', () => {
  it('flags every execution-surface file once', () => {
    const result = analyze([
      file('package.json', 'M'),
      file('vite.config.ts', 'M'),
      file('src/a.ts', 'M'),
    ]);
    expect(result.flags.map((f) => [f.rule, f.file])).toEqual([
      ['execution-surface-changed', 'package.json'],
      ['execution-surface-changed', 'vite.config.ts'],
    ]);
  });

  it('flags snapshot updates', () => {
    expect(rules([file('src/__snapshots__/a.test.ts.snap', 'M', ['a'], ['b'])])).toEqual([
      'snapshot-updated',
    ]);
  });

  it('flags test-environment branches in source only', () => {
    const line = "if (process.env.NODE_ENV === 'test') return;";
    const result = analyze([
      file('src/a.ts', 'M', [], [line]),
      file('src/a.test.ts', 'M', [], [line]),
    ]);
    expect(result.flags).toMatchObject([{ rule: 'test-env-branch', file: 'src/a.ts', line: 10 }]);
  });
});

describe('info rules', () => {
  it('flags mocks of changed modules but not unrelated ones', () => {
    const result = analyze([
      file('src/store.ts', 'M', [], ['x']),
      file('src/a.test.ts', 'M', [], ["vi.mock('./store.js', () => ({}))", "vi.mock('./other')"]),
    ]);
    expect(result.flags.filter((f) => f.rule === 'mock-of-changed-module')).toHaveLength(1);
  });

  it('flags spies once per test file', () => {
    const result = analyze([
      file('src/a.test.ts', 'M', [], ["vi.spyOn(a, 'b')", "vi.spyOn(a, 'c')"]),
    ]);
    expect(result.flags.filter((f) => f.rule === 'mock-of-changed-module')).toHaveLength(1);
  });

  it('flags a drop of two or more assertions', () => {
    const result = analyze([
      file('src/a.test.ts', 'M', ['expect(1)', 'expect(2)', 'expect(3)'], ['expect(1)']),
    ]);
    expect(result.flags.map((f) => f.rule)).toContain('assertion-count-dropped');
  });

  it('flags broad catches added in source', () => {
    expect(rules([file('src/a.ts', 'M', [], ['} catch {', '  x', '} catch (e) {}'])])).toEqual([
      'broad-catch-added',
      'broad-catch-added',
    ]);
    expect(rules([file('lib/a.py', 'M', [], ['except:'])])).toEqual(['broad-catch-added']);
  });
});

describe('flag ids', () => {
  const make = (line: string) => analyze([file('src/a.test.ts', 'M', [], [line])]).flags[0].id;

  it('is stable for identical input and prefixed by rule', () => {
    expect(make("it.skip('x')")).toBe(make("it.skip('x')"));
    expect(make("it.skip('x')")).toMatch(/^test-disabled:[0-9a-f]+$/);
  });

  it('changes with the flagged content', () => {
    expect(make("it.skip('x')")).not.toBe(make("it.skip('y')"));
  });
});

describe('coverage and caps', () => {
  it('lists source files lacking a changed or covering test', () => {
    const result = analyze(
      [
        file('src/a.ts', 'M', [], ['x']),
        file('src/a.test.ts', 'M', [], ['x']),
        file('src/b.ts', 'M', [], ['x']),
        file('src/c.ts', 'A', [], ['x']),
        file('README.md', 'M'),
      ],
      [{ testFile: 'src/other.test.ts', sources: ['src/b.ts'] }],
    );
    expect(result.sourceWithoutTests).toEqual(['src/c.ts']);
    expect(result.coveringTests).toEqual(['src/other.test.ts']);
  });

  it('caps lists and reports truncation', () => {
    const many = Array.from({ length: EVIDENCE_LIMITS.maxFlags + 5 }, (_, i) =>
      file(`pkg${i}/package.json`, 'M'),
    );
    const result = analyze(many);
    expect(result.flags).toHaveLength(EVIDENCE_LIMITS.maxFlags);
    expect(result.truncated).toBe(true);
    expect(analyze([file('package.json', 'M')]).truncated).toBeUndefined();
  });
});
