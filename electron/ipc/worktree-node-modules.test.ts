import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureNodeModulesEntryLinks, isManagedNodeModules } from './worktree-node-modules.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-nm-links-'));
  tempDirs.push(dir);
  return dir;
}

/** Build a fake main-checkout node_modules with the given entries. */
function makeSource(entries: Record<string, string | null>): string {
  const source = path.join(makeTempDir(), 'node_modules');
  fs.mkdirSync(source);
  for (const [name, fileContent] of Object.entries(entries)) {
    const p = path.join(source, name);
    if (fileContent === null) {
      fs.mkdirSync(p, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, fileContent, 'utf8');
    }
  }
  return source;
}

function makeTarget(): string {
  return path.join(makeTempDir(), 'node_modules');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ensureNodeModulesEntryLinks', () => {
  it('creates a real directory with one link per package, resolvable through the link', () => {
    const source = makeSource({
      'left-pad/index.js': 'module.exports = 1;\n',
      '@scope/pkg/index.js': 'module.exports = 2;\n',
    });
    const target = makeTarget();

    expect(ensureNodeModulesEntryLinks(source, target)).toBe(true);

    expect(fs.lstatSync(target).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(target, 'left-pad')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(target, '@scope')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(target, '@scope', 'pkg', 'index.js'), 'utf8')).toBe(
      'module.exports = 2;\n',
    );
  });

  it('creates relative links so the tree survives the repo being moved', () => {
    const source = makeSource({ 'pkg/index.js': 'x\n' });
    const target = makeTarget();

    ensureNodeModulesEntryLinks(source, target);

    expect(path.isAbsolute(fs.readlinkSync(path.join(target, 'pkg')))).toBe(false);
  });

  it('links package-manager metadata dot-entries but not tool caches', () => {
    const source = makeSource({
      '.bin/vitest': '#!/bin/sh\n',
      '.package-lock.json': '{}\n',
      '.pnpm/pkg@1.0.0/node_modules/pkg/index.js': 'x\n',
      '.vite': null,
      '.vite-temp': null,
      '.cache': null,
    });
    const target = makeTarget();

    ensureNodeModulesEntryLinks(source, target);

    expect(fs.lstatSync(path.join(target, '.bin')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(target, '.package-lock.json')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(target, '.pnpm')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(target, '.vite'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.vite-temp'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.cache'))).toBe(false);
  });

  it('replaces a legacy whole-dir symlink with per-entry links', () => {
    const source = makeSource({ 'pkg/index.js': 'x\n' });
    const target = makeTarget();
    fs.symlinkSync(source, target);

    ensureNodeModulesEntryLinks(source, target);

    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(target).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(target, 'pkg')).isSymbolicLink()).toBe(true);
  });

  it('tops up links for packages added to the source after the first run', () => {
    const source = makeSource({ 'pkg-a/index.js': 'a\n' });
    const target = makeTarget();
    ensureNodeModulesEntryLinks(source, target);

    fs.mkdirSync(path.join(source, 'pkg-b'));
    fs.writeFileSync(path.join(source, 'pkg-b', 'index.js'), 'b\n', 'utf8');
    ensureNodeModulesEntryLinks(source, target);

    expect(fs.lstatSync(path.join(target, 'pkg-b')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(target, 'pkg-a')).isSymbolicLink()).toBe(true);
  });

  it('prunes links left dangling by packages removed from the source', () => {
    const source = makeSource({ 'pkg-a/index.js': 'a\n', 'pkg-b/index.js': 'b\n' });
    const target = makeTarget();
    ensureNodeModulesEntryLinks(source, target);

    fs.rmSync(path.join(source, 'pkg-b'), { recursive: true });
    ensureNodeModulesEntryLinks(source, target);

    expect(fs.existsSync(path.join(target, 'pkg-a'))).toBe(true);
    expect(fs.lstatSync(path.join(target, 'pkg-a')).isSymbolicLink()).toBe(true);
    expect(() => fs.lstatSync(path.join(target, 'pkg-b'))).toThrow();
  });

  it('never touches real entries the worktree created', () => {
    const source = makeSource({ 'pkg/index.js': 'source\n' });
    const target = makeTarget();
    fs.mkdirSync(target, { recursive: true });
    // Worktree-local cache + a local install shadowing a source package.
    fs.mkdirSync(path.join(target, '.vite'));
    fs.writeFileSync(path.join(target, '.vite', 'results.json'), '{}\n', 'utf8');
    fs.mkdirSync(path.join(target, 'pkg'));
    fs.writeFileSync(path.join(target, 'pkg', 'index.js'), 'local\n', 'utf8');

    ensureNodeModulesEntryLinks(source, target);

    expect(fs.lstatSync(path.join(target, 'pkg')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(target, 'pkg', 'index.js'), 'utf8')).toBe('local\n');
    expect(fs.existsSync(path.join(target, '.vite', 'results.json'))).toBe(true);
  });

  it('keeps a dangling symlink it does not own', () => {
    const source = makeSource({ 'pkg/index.js': 'x\n' });
    const target = makeTarget();
    ensureNodeModulesEntryLinks(source, target);
    fs.symlinkSync('/nonexistent-user-dest', path.join(target, 'user-link'));

    ensureNodeModulesEntryLinks(source, target);

    expect(fs.lstatSync(path.join(target, 'user-link')).isSymbolicLink()).toBe(true);
  });

  it('keeps a link whose source entry still exists, even when it dangles', () => {
    const source = makeSource({ 'pkg/index.js': 'x\n' });
    // A dangling symlink in the source itself — the worktree link must mirror
    // it, not churn through prune-and-recreate on every refresh.
    fs.symlinkSync('/nonexistent-source-dest', path.join(source, 'flaky'));
    const target = makeTarget();
    ensureNodeModulesEntryLinks(source, target);
    const before = fs.lstatSync(path.join(target, 'flaky'));

    ensureNodeModulesEntryLinks(source, target);

    const after = fs.lstatSync(path.join(target, 'flaky'));
    expect(after.isSymbolicLink()).toBe(true);
    expect(after.ino).toBe(before.ino);
  });

  it('is a no-op when the source does not exist', () => {
    const target = makeTarget();

    expect(ensureNodeModulesEntryLinks(path.join(makeTempDir(), 'node_modules'), target)).toBe(
      false,
    );

    expect(fs.existsSync(target)).toBe(false);
  });

  it('prunes across a symlinked source-path alias', () => {
    const base = makeTempDir();
    fs.mkdirSync(path.join(base, 'real', 'node_modules', 'pkg'), { recursive: true });
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'alias'));
    const aliasSource = path.join(base, 'alias', 'node_modules');
    const canonicalSource = path.join(fs.realpathSync(path.join(base, 'real')), 'node_modules');
    const target = makeTarget();
    // Built through the alias; refreshed with the canonical path git reports.
    ensureNodeModulesEntryLinks(aliasSource, target);

    fs.rmSync(path.join(base, 'real', 'node_modules', 'pkg'), { recursive: true });
    ensureNodeModulesEntryLinks(canonicalSource, target);

    expect(() => fs.lstatSync(path.join(target, 'pkg'))).toThrow();
  });
});

describe('isManagedNodeModules', () => {
  it('recognizes the legacy whole-dir symlink to the source', () => {
    const source = makeSource({ 'pkg/index.js': 'x\n' });
    const target = makeTarget();
    fs.symlinkSync(source, target);

    expect(isManagedNodeModules(source, target)).toBe(true);
  });

  it('rejects a symlink pointing elsewhere', () => {
    const source = makeSource({ 'pkg/index.js': 'x\n' });
    const other = makeSource({ 'pkg/index.js': 'y\n' });
    const target = makeTarget();
    fs.symlinkSync(other, target);

    expect(isManagedNodeModules(source, target)).toBe(false);
  });

  it('recognizes a directory of entry links it created', () => {
    const source = makeSource({ 'pkg/index.js': 'x\n' });
    const target = makeTarget();
    ensureNodeModulesEntryLinks(source, target);

    expect(isManagedNodeModules(source, target)).toBe(true);
  });

  it('recognizes a tree built through a symlinked source-path alias', () => {
    // A repo opened via a symlinked path bakes the alias into the links,
    // while `git rev-parse` reports the canonical root at refresh time.
    const base = makeTempDir();
    fs.mkdirSync(path.join(base, 'real', 'node_modules', 'pkg'), { recursive: true });
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'alias'));
    const aliasSource = path.join(base, 'alias', 'node_modules');
    const canonicalSource = path.join(fs.realpathSync(path.join(base, 'real')), 'node_modules');

    const entryTree = makeTarget();
    ensureNodeModulesEntryLinks(aliasSource, entryTree);
    const legacyLink = makeTarget();
    fs.symlinkSync(aliasSource, legacyLink);

    expect(isManagedNodeModules(canonicalSource, entryTree)).toBe(true);
    expect(isManagedNodeModules(canonicalSource, legacyLink)).toBe(true);
  });

  it('rejects a real user-managed install with no entry links', () => {
    const source = makeSource({ 'pkg/index.js': 'x\n' });
    const target = makeTarget();
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(target, 'pkg'));
    fs.writeFileSync(path.join(target, 'pkg', 'index.js'), 'local\n', 'utf8');

    expect(isManagedNodeModules(source, target)).toBe(false);
  });

  it('rejects a pnpm-style install whose links point inside itself, not the source', () => {
    // The main checkout's own node_modules under pnpm: top-level entries are
    // relative links into ./.pnpm. Even when probed against itself it must not
    // be classified as managed — this is the backstop that keeps the refresh
    // from ever touching a real install.
    const source = makeSource({ '.pnpm/pkg@1.0.0/node_modules/pkg/index.js': 'x\n' });
    fs.symlinkSync(
      path.join('.pnpm', 'pkg@1.0.0', 'node_modules', 'pkg'),
      path.join(source, 'pkg'),
    );

    expect(isManagedNodeModules(source, source)).toBe(false);
  });

  it('rejects a missing target', () => {
    const source = makeSource({ 'pkg/index.js': 'x\n' });

    expect(isManagedNodeModules(source, makeTarget())).toBe(false);
  });
});
