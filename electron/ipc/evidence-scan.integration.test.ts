import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanEvidence } from './evidence-scan.js';

const directories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commit(root: string, message: string): void {
  git(root, 'add', '.');
  git(root, 'commit', '-m', message);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'evidence-scan-'));
  directories.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, 'package.json', '{"name":"x"}\n');
  write(root, 'src/calc.ts', 'export const add = (a: number, b: number) => a + b;\n');
  write(root, 'src/util.ts', 'export const id = <T>(x: T) => x;\n');
  write(
    root,
    'src/util.test.ts',
    "import { id } from './util';\nit('returns input', () => {\n  expect(id(1)).toBe(1);\n});\nit('keeps type', () => {\n  expect(id('a')).toBe('a');\n});\n",
  );
  write(root, 'src/other.test.ts', "import { add } from './calc';\nit('adds', () => {});\n");
  commit(root, 'base');
  git(root, 'checkout', '-b', 'feature');
  return root;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('scanEvidence', () => {
  it('reports the committed change, flags, tests and covering tests', async () => {
    const root = fixture();
    write(root, 'package.json', '{"name":"x","scripts":{}}\n');
    write(root, 'src/calc.ts', 'export const add = (a: number, b: number) => b + a;\n');
    write(root, 'src/fresh.ts', 'export const fresh = 1;\n');
    write(root, 'src/fresh.test.ts', "it('is fresh', () => {});\n");
    write(
      root,
      'src/util.test.ts',
      "import { id } from './util';\nit('returns input', () => {\n  expect(id(1)).toBe(1);\n});\n",
    );
    commit(root, 'change');
    write(root, 'uncommitted.txt', 'x\n');

    const scan = await scanEvidence(root, 'main');

    expect(scan.headSha).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(scan.baseSha).toBe(git(root, 'rev-parse', 'main'));
    expect(scan.dirty).toBe(true);
    expect(scan.files.map((f) => [f.path, f.status, f.role]).sort()).toEqual([
      ['package.json', 'M', 'execution-surface'],
      ['src/calc.ts', 'M', 'source'],
      ['src/fresh.test.ts', 'A', 'test'],
      ['src/fresh.ts', 'A', 'source'],
      ['src/util.test.ts', 'M', 'test'],
    ]);
    expect(scan.flags.map((f) => [f.rule, f.file])).toEqual([
      ['test-removed', 'src/util.test.ts'],
      ['execution-surface-changed', 'package.json'],
    ]);
    expect(scan.tests).toEqual(
      expect.arrayContaining([
        { file: 'src/fresh.test.ts', kind: 'unit', title: 'is fresh', change: 'added' },
        { file: 'src/util.test.ts', kind: 'unit', title: 'keeps type', change: 'removed' },
      ]),
    );
    expect(scan.coveringTests).toEqual(['src/other.test.ts']);
    expect(scan.sourceWithoutTests).toEqual([]);
  });

  it('reports a clean tree and handles deleted and renamed files', async () => {
    const root = fixture();
    git(root, 'rm', '-q', 'src/other.test.ts');
    git(root, 'mv', 'src/util.test.ts', 'src/util2.test.ts');
    commit(root, 'change');

    const scan = await scanEvidence(root, 'main');

    expect(scan.dirty).toBe(false);
    expect(scan.files.find((f) => f.status === 'R')).toMatchObject({
      path: 'src/util2.test.ts',
      oldPath: 'src/util.test.ts',
    });
    expect(scan.flags.map((f) => f.rule)).toEqual(['test-file-deleted']);
  });
});
