import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { discardDocumentEdits, readDocumentSnapshot } from './runs.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

describe('discardDocumentEdits', () => {
  it('restores committed content, staged or not, and leaves .parallel alone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-discard-'));
    roots.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(root, 'plan.md'), '# Plan\n');
    fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n');
    fs.mkdirSync(path.join(root, '.parallel'));
    fs.writeFileSync(path.join(root, '.parallel', 'annotations.json'), '{"version":1}');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'Initial');

    fs.writeFileSync(path.join(root, 'plan.md'), '# Plan\n\nEdited.\n');
    fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n\nStaged.\n');
    git(root, 'add', 'notes.md');
    fs.writeFileSync(path.join(root, '.parallel', 'annotations.json'), '{"version":1,"x":1}');
    expect((await readDocumentSnapshot(root, 'plan.md')).dirty).toBe(true);

    await discardDocumentEdits(root);

    expect(fs.readFileSync(path.join(root, 'plan.md'), 'utf8')).toBe('# Plan\n');
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('# Notes\n');
    expect(fs.readFileSync(path.join(root, '.parallel', 'annotations.json'), 'utf8')).toBe(
      '{"version":1,"x":1}',
    );
    expect((await readDocumentSnapshot(root, 'plan.md')).dirty).toBe(false);
  });
});
