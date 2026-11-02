import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findNestedRepos,
  getAllFileDiffsWithNested,
  getChangedFilesWithNested,
  getFileDiffWithNested,
  getUncommittedChangedFilesWithNested,
  getUncommittedFileDiffsWithNested,
} from './nested-repos.js';

const directories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.test');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

function commitFile(cwd: string, file: string, content: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-m', file);
}

/**
 * A parent repo with `api` symlinked from a sibling checkout on a feature
 * branch and `web` as a real ignored clone, as a workspace of repos looks.
 */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'nested-repos-'));
  directories.push(root);
  const parent = join(root, 'parent');
  initRepo(parent);
  commitFile(parent, '.gitignore', 'api\nweb/\n');
  commitFile(parent, 'readme.md', 'parent\n');

  const api = join(root, 'api-checkout');
  initRepo(api);
  commitFile(api, 'server.ts', 'one\n');
  git(api, 'checkout', '-b', 'feature/login');
  commitFile(api, 'login.ts', 'login\n');
  writeFileSync(join(api, 'server.ts'), 'one\ntwo\n');
  symlinkSync(api, join(parent, 'api'));

  const web = join(parent, 'web');
  initRepo(web);
  commitFile(web, 'app.ts', 'app\n');
  writeFileSync(join(web, 'draft.ts'), 'draft\n');

  writeFileSync(join(parent, 'readme.md'), 'parent\nedited\n');
  return { parent };
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('nested repositories', () => {
  it('finds untracked nested repos with their branch', async () => {
    const { parent } = workspace();
    expect(await findNestedRepos(parent)).toEqual([
      { name: 'api', branch: 'feature/login' },
      { name: 'web', branch: 'main' },
    ]);
  });

  it('ignores submodules, which the task diff already covers', async () => {
    const { parent } = workspace();
    const lib = join(parent, 'lib');
    initRepo(lib);
    commitFile(lib, 'lib.ts', 'lib\n');
    git(parent, 'add', 'lib');
    git(parent, 'commit', '-m', 'add gitlink');
    expect((await findNestedRepos(parent)).map((repo) => repo.name)).toEqual(['api', 'web']);
  });

  it('lists nested committed and uncommitted changes under their folder', async () => {
    const { parent } = workspace();
    const files = await getChangedFilesWithNested(parent);
    expect(files.map((file) => [file.path, file.committed])).toEqual([
      ['readme.md', false],
      ['api/login.ts', true],
      ['api/server.ts', false],
      ['web/draft.ts', false],
    ]);
  });

  it('lists only uncommitted nested changes in the uncommitted view', async () => {
    const { parent } = workspace();
    const files = await getUncommittedChangedFilesWithNested(parent);
    expect(files.map((file) => file.path)).toEqual(['readme.md', 'api/server.ts', 'web/draft.ts']);
  });

  it('prefixes nested paths in the combined diffs', async () => {
    const { parent } = workspace();
    const all = await getAllFileDiffsWithNested(parent);
    expect(all).toContain('diff --git a/readme.md b/readme.md');
    expect(all).toContain('diff --git a/api/login.ts b/api/login.ts');
    expect(all).toContain('+++ b/api/server.ts');
    expect(all).toContain('diff --git a/web/draft.ts b/web/draft.ts');

    const uncommitted = await getUncommittedFileDiffsWithNested(parent);
    expect(uncommitted).toContain('diff --git a/api/server.ts b/api/server.ts');
    expect(uncommitted).not.toContain('api/login.ts');
  });

  it('reads a nested file diff from the repo that owns it', async () => {
    const { parent } = workspace();
    const result = await getFileDiffWithNested(parent, 'api/server.ts');
    expect(result.oldContent).toBe('one\n');
    expect(result.newContent).toBe('one\ntwo\n');
  });

  it('leaves projects without nested repos unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nested-repos-'));
    directories.push(root);
    initRepo(root);
    commitFile(root, 'a.ts', 'a\n');
    writeFileSync(join(root, 'a.ts'), 'a\nb\n');
    expect(await findNestedRepos(root)).toEqual([]);
    expect((await getChangedFilesWithNested(root)).map((file) => file.path)).toEqual(['a.ts']);
  });
});
