import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { inspectDocumentFolder, prepareDocumentProject } from './setup.js';

const made: string[] = [];

function tmpFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-docsetup-'));
  made.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
}

afterEach(() => {
  while (made.length) fs.rmSync(made.pop() as string, { recursive: true, force: true });
});

describe('inspectDocumentFolder', () => {
  it('finds markdown in a folder that is not a repository yet', async () => {
    const dir = tmpFolder();
    fs.mkdirSync(path.join(dir, 'notes'));
    fs.writeFileSync(path.join(dir, 'notes', 'plan.md'), '# Plan\n');
    fs.writeFileSync(path.join(dir, 'ignore.txt'), 'x');

    expect(await inspectDocumentFolder(dir)).toEqual({
      isRepo: false,
      enclosingRepo: null,
      hasCommits: false,
      files: [{ path: 'notes/plan.md', committed: false }],
    });
  });

  it('reports untracked markdown alongside committed markdown', async () => {
    const dir = tmpFolder();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'committed.md'), '# One\n');
    git(dir, 'add', 'committed.md');
    git(dir, 'commit', '-q', '-m', 'initial');
    fs.writeFileSync(path.join(dir, 'loose.md'), '# Two\n');

    expect(await inspectDocumentFolder(dir)).toEqual({
      isRepo: true,
      enclosingRepo: null,
      hasCommits: true,
      files: [
        { path: 'committed.md', committed: true },
        { path: 'loose.md', committed: false },
      ],
    });
  });

  it('names the enclosing repository instead of claiming a subfolder is one', async () => {
    const dir = tmpFolder();
    initRepo(dir);
    fs.mkdirSync(path.join(dir, 'sub'));

    const info = await inspectDocumentFolder(path.join(dir, 'sub'));
    expect(info.isRepo).toBe(false);
    expect(info.enclosingRepo).toBe(fs.realpathSync(dir));
  });
});

describe('prepareDocumentProject', () => {
  it('turns a plain folder into a repository with the document committed', async () => {
    const dir = tmpFolder();
    fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan\n');

    const result = await prepareDocumentProject(dir, 'plan.md');

    expect(result.documentPath).toBe('plan.md');
    expect(result.actions).toEqual(['Initialised a Git repository', 'Committed plan.md']);
    expect(git(dir, 'show', '--format=', '--name-only', 'HEAD').trim()).toBe('plan.md');
  });

  it('creates a starter document when the name is new, adding the extension', async () => {
    const dir = tmpFolder();

    const result = await prepareDocumentProject(dir, 'release-notes');

    expect(result.documentPath).toBe('release-notes.md');
    expect(result.actions).toEqual([
      'Initialised a Git repository',
      'Created release-notes.md',
      'Committed release-notes.md',
    ]);
    expect(fs.readFileSync(path.join(dir, 'release-notes.md'), 'utf8')).toBe('# Release notes\n\n');
  });

  it('does nothing to a repository whose document is already committed', async () => {
    const dir = tmpFolder();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'spec.md'), '# Spec\n');
    git(dir, 'add', 'spec.md');
    git(dir, 'commit', '-q', '-m', 'initial');
    const before = git(dir, 'rev-parse', 'HEAD').trim();

    expect((await prepareDocumentProject(dir, 'spec.md')).actions).toEqual([]);
    expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(before);
  });

  it('commits an untracked document without disturbing what the user staged', async () => {
    const dir = tmpFolder();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'seed.md'), '# Seed\n');
    git(dir, 'add', 'seed.md');
    git(dir, 'commit', '-q', '-m', 'initial');
    fs.writeFileSync(path.join(dir, 'spec.md'), '# Spec\n');
    fs.writeFileSync(path.join(dir, 'staged-by-user.txt'), 'mine\n');
    git(dir, 'add', 'staged-by-user.txt');

    expect((await prepareDocumentProject(dir, 'spec.md')).actions).toEqual(['Committed spec.md']);
    expect(git(dir, 'show', '--format=', '--name-only', 'HEAD').trim()).toBe('spec.md');
    expect(git(dir, 'status', '--porcelain', '--', 'staged-by-user.txt').trim()).toBe(
      'A  staged-by-user.txt',
    );
  });

  it('refuses to nest a new repository inside an existing one', async () => {
    const dir = tmpFolder();
    initRepo(dir);
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);

    await expect(prepareDocumentProject(sub, 'plan.md')).rejects.toThrow(/sits inside/);
    expect(fs.existsSync(path.join(sub, '.git'))).toBe(false);
  });
});
