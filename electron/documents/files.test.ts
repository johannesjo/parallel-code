import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listProjectFiles } from './files.js';

const made: string[] = [];

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-docfiles-'));
  made.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return dir;
}

function write(dir: string, rel: string, content = 'x\n'): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

afterEach(() => {
  while (made.length) fs.rmSync(made.pop() as string, { recursive: true, force: true });
});

describe('listProjectFiles', () => {
  it('lists tracked and untracked files, sorted, without ignored or app-owned paths', async () => {
    const dir = tmpRepo();
    write(dir, 'notes.md');
    write(dir, 'src/plan.md');
    write(dir, 'build/out.txt');
    write(dir, '.gitignore', 'build/\n');
    write(dir, '.parallel/runs/r.json', '{}');
    write(dir, '.worktrees/x/notes.md');
    execFileSync('git', ['add', 'notes.md'], { cwd: dir });

    expect(await listProjectFiles(dir)).toEqual(['.gitignore', 'notes.md', 'src/plan.md']);
  });
});
