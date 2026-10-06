import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCheckSources } from './check-sources.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-check-sources-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('readCheckSources', () => {
  it('reads manifests and workflows and lists lockfiles', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"vitest"}}');
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github/workflows/ci.yml'), 'run: pnpm test');

    expect(await readCheckSources(root)).toEqual([
      { path: 'package.json', text: '{"scripts":{"test":"vitest"}}' },
      { path: '.github/workflows/ci.yml', text: 'run: pnpm test' },
      { path: '(files present)', text: 'pnpm-lock.yaml' },
    ]);
  });

  it('does not follow symlinks out of the project', async () => {
    const root = tempDir();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, 'secret'), 'token');
    fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'Makefile'));

    expect(await readCheckSources(root)).toEqual([]);
  });

  it('does not follow a symlinked workflows directory', async () => {
    const root = tempDir();
    const outside = tempDir();
    fs.mkdirSync(path.join(outside, 'workflows'));
    fs.writeFileSync(path.join(outside, 'workflows/leak.yml'), 'secret');
    fs.symlinkSync(outside, path.join(root, '.github'));

    expect(await readCheckSources(root)).toEqual([]);
  });

  it('truncates large files', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'Makefile'), 'x'.repeat(30_000));

    const [source] = await readCheckSources(root);
    expect(source.text.length).toBeLessThan(25_000);
    expect(source.text.endsWith('[truncated]')).toBe(true);
  });
});
