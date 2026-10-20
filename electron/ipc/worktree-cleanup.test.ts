import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { findForeignOwnedEntries, foreignOwnedRemovalError } from './worktree-cleanup.js';

const tempDirs: string[] = [];
const OWN_UID = process.getuid?.() ?? 0;
/** A uid nothing on disk can match — stands in for the container user we cannot become in a test. */
const FOREIGN_UID = OWN_UID + 1;

function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-code-worktree-cleanup-'));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('findForeignOwnedEntries', () => {
  it('returns nothing when every entry belongs to the current user', () => {
    const root = makeTree();
    fs.mkdirSync(path.join(root, 'packages/app/node_modules/.cache'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/app/node_modules/.cache/x'), 'y');

    expect(findForeignOwnedEntries(root, OWN_UID)).toEqual([]);
  });

  it('reports entries owned by another uid without descending into them', () => {
    const root = makeTree();
    fs.mkdirSync(path.join(root, 'packages/app/node_modules/.cache/jiti'), { recursive: true });

    const found = findForeignOwnedEntries(root, FOREIGN_UID);

    // `packages` is itself a blocker, so its children add nothing to the report.
    expect(found).toEqual([
      { path: root, uid: OWN_UID },
      { path: path.join(root, 'packages'), uid: OWN_UID },
    ]);
  });

  it('caps the number of reported entries', () => {
    const root = makeTree();
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, `file-${i}`), 'x');

    expect(findForeignOwnedEntries(root, FOREIGN_UID, 3)).toHaveLength(3);
  });

  it('does not follow symlinked directories out of the worktree', () => {
    const root = makeTree();
    const outside = makeTree();
    fs.writeFileSync(path.join(outside, 'deep-file'), 'x');
    fs.symlinkSync(outside, path.join(root, 'node_modules'));

    const found = findForeignOwnedEntries(root, FOREIGN_UID, 10);

    expect(found.map((e) => e.path)).not.toContain(path.join(outside, 'deep-file'));
  });

  it('returns nothing when the worktree is already gone', () => {
    expect(findForeignOwnedEntries('/definitely/not/here', OWN_UID)).toEqual([]);
  });
});

describe('foreignOwnedRemovalError', () => {
  it('names the offending uid, an example path, and the manual command', () => {
    const error = foreignOwnedRemovalError(
      '/repo/.worktrees/feat/x',
      [
        { path: '/repo/.worktrees/feat/x/node_modules/.cache', uid: 65534 },
        { path: '/repo/.worktrees/feat/x/node_modules/.cache/jiti', uid: 65534 },
      ],
      'docker: command not found',
    );

    expect(error.message).toContain('uid 65534');
    expect(error.message).toContain('node_modules/.cache');
    expect(error.message).toContain('docker: command not found');
    expect(error.message).toContain('sudo rm -rf "/repo/.worktrees/feat/x"');
  });
});
