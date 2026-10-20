import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FILE_TOUR_MAX_FILE_CHARS,
  FILE_TOUR_MAX_IMPORTS,
  FILE_TOUR_MAX_TOTAL_CHARS,
} from '../shared/understanding-limits.js';
import { readFileTourContext } from './understanding-context.js';
import { parseRelativeImports } from './understanding-imports.js';

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-file-tour-'));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('readFileTourContext', () => {
  it('returns the subject plus its resolvable direct imports in source order', async () => {
    const root = makeDir();
    write(
      root,
      'src/subject.ts',
      [
        "import { helper } from './helper.js';",
        "import Widget from './widget';",
        "import { deep } from './sub';",
        "import './subject.css';",
        "import { unrelated } from 'solid-js';",
        "const lazy = () => import('./lazy');",
        "const legacy = require('../legacy');",
        "export { reexported } from './missing.js';",
      ].join('\n'),
    );
    write(root, 'src/helper.ts', 'export const helper = 1;');
    write(root, 'src/widget.tsx', 'export default () => null;');
    write(root, 'src/sub/index.ts', 'export const deep = 2;');
    write(root, 'src/subject.css', '.a { color: red; }');
    write(root, 'src/lazy.mjs', 'export const lazy = 3;');
    write(root, 'legacy.cjs', 'module.exports = {};');

    const context = await readFileTourContext(root, 'src/subject.ts');

    expect(context.filePath).toBe('src/subject.ts');
    expect(context.files.map((file) => file.path)).toEqual([
      'src/subject.ts',
      'src/helper.ts',
      'src/widget.tsx',
      'src/sub/index.ts',
      'src/subject.css',
      'src/lazy.mjs',
      'legacy.cjs',
    ]);
    expect(context.files[1].content).toBe('export const helper = 1;');
    expect(context.files.every((file) => file.truncated === false)).toBe(true);
    expect(context.omitted).toEqual(['./missing.js']);
  });

  it('normalizes a leading ./ and reads from a nested worktree path', async () => {
    const root = makeDir();
    write(root, 'a/b/file.ts', 'export const x = 1;');

    const context = await readFileTourContext(root, './a/b/file.ts');

    expect(context.filePath).toBe('a/b/file.ts');
    expect(context.files).toEqual([
      { path: 'a/b/file.ts', content: 'export const x = 1;', truncated: false },
    ]);
  });

  it.each([
    ['../outside.ts', /must not contain/],
    ['a/../../outside.ts', /must not contain/],
    ['/etc/passwd', /must be relative/],
    ['', /must not be empty/],
    ['   ', /must not be empty/],
  ])('rejects %s before touching the filesystem', async (filePath, message) => {
    // A worktree path that cannot be stat'ed proves validation ran first.
    await expect(
      readFileTourContext(path.join(os.tmpdir(), 'parallel-code-missing-worktree'), filePath),
    ).rejects.toThrow(message);
  });

  it('fails clearly when the subject file is missing', async () => {
    const root = makeDir();

    await expect(readFileTourContext(root, 'src/nope.ts')).rejects.toThrow(
      'Cannot read src/nope.ts inside this worktree',
    );
  });

  it('omits an import whose symlink leaves the worktree instead of following it', async () => {
    const root = makeDir();
    const outside = makeDir();
    write(outside, 'secret.ts', 'export const SECRET = "leaked";');
    fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'link.ts'));
    write(root, 'subject.ts', "import { SECRET } from './link.js';");

    const context = await readFileTourContext(root, 'subject.ts');

    expect(context.files.map((file) => file.path)).toEqual(['subject.ts']);
    expect(context.omitted).toEqual(['./link.js']);
    expect(JSON.stringify(context)).not.toContain('leaked');
  });

  it('rejects a subject file that escapes the worktree through a symlink', async () => {
    const root = makeDir();
    const outside = makeDir();
    write(outside, 'secret.ts', 'export const SECRET = 1;');
    fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'link.ts'));

    await expect(readFileTourContext(root, 'link.ts')).rejects.toThrow('Cannot read link.ts');
  });

  it('truncates a file above the per-file cap', async () => {
    const root = makeDir();
    write(root, 'big.ts', 'x'.repeat(FILE_TOUR_MAX_FILE_CHARS + 500));

    const context = await readFileTourContext(root, 'big.ts');

    expect(context.files[0].truncated).toBe(true);
    expect(context.files[0].content).toHaveLength(FILE_TOUR_MAX_FILE_CHARS);
  });

  it('omits imports that would push the bundle past the total cap', async () => {
    const root = makeDir();
    const perFile = FILE_TOUR_MAX_FILE_CHARS;
    const names = ['a', 'b', 'c', 'd'];
    write(root, 'subject.ts', names.map((n) => `import './${n}.js';`).join('\n'));
    for (const name of names) write(root, `${name}.ts`, 'y'.repeat(perFile + 10));

    const context = await readFileTourContext(root, 'subject.ts');

    const total = context.files.reduce((sum, file) => sum + file.content.length, 0);
    expect(total).toBeLessThanOrEqual(FILE_TOUR_MAX_TOTAL_CHARS);
    expect(context.files.map((file) => file.path)).toEqual(['subject.ts', 'a.ts', 'b.ts', 'c.ts']);
    expect(context.omitted).toEqual(['./d.js']);
  });

  it('keeps at most the import cap and omits the rest', async () => {
    const root = makeDir();
    const names = Array.from({ length: FILE_TOUR_MAX_IMPORTS + 2 }, (_, i) => `m${i}`);
    write(root, 'subject.ts', names.map((n) => `import './${n}.js';`).join('\n'));
    for (const name of names) write(root, `${name}.ts`, `export const ${name} = 1;`);

    const context = await readFileTourContext(root, 'subject.ts');

    expect(context.files).toHaveLength(FILE_TOUR_MAX_IMPORTS + 1);
    expect(context.omitted).toEqual(['./m12.js', './m13.js']);
  });

  it('rejects a binary subject file and omits binary imports', async () => {
    const root = makeDir();
    write(root, 'binary.ts', 'abc\0def');
    write(root, 'subject.ts', "import './binary.js';");

    await expect(readFileTourContext(root, 'binary.ts')).rejects.toThrow('File looks binary');

    const context = await readFileTourContext(root, 'subject.ts');
    expect(context.files.map((file) => file.path)).toEqual(['subject.ts']);
    expect(context.omitted).toEqual(['./binary.js']);
  });

  it('does not inline a directory or a duplicated import twice', async () => {
    const root = makeDir();
    write(root, 'subject.ts', "import './dep.js';\nconst again = require('./dep.js');");
    write(root, 'dep.ts', 'export const dep = 1;');
    fs.mkdirSync(path.join(root, 'dep'), { recursive: true });

    const context = await readFileTourContext(root, 'subject.ts');

    expect(context.files.map((file) => file.path)).toEqual(['subject.ts', 'dep.ts']);
    expect(context.omitted).toEqual([]);
  });
});

describe('parseRelativeImports', () => {
  it('collects every relative specifier once, in source order', () => {
    const source = [
      "import a from './a';",
      "import type { B } from '../b.js';",
      "export * from './c';",
      "import './d.css';",
      "await import('./e');",
      "const f = require('./f');",
      "import a2 from './a';",
    ].join('\n');

    expect(parseRelativeImports(source)).toEqual([
      './a',
      '../b.js',
      './c',
      './d.css',
      './e',
      './f',
    ]);
  });

  it('ignores package specifiers and multi-line imports keep their order', () => {
    const source = "import { x } from 'solid-js';\nimport {\n  y,\n} from './y.js';";

    expect(parseRelativeImports(source)).toEqual(['./y.js']);
  });
});
