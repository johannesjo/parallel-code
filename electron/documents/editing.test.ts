import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readDocumentSnapshot, writeDocumentBlock } from './runs.js';

const roots: string[] = [];
function folder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-doc-edit-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('writeDocumentBlock', () => {
  it('changes only the selected source range and preserves file permissions', async () => {
    const root = folder();
    const expectedContent = '# Plan\r\n\r\nA typo.\r\n\r\nOther.\r\n';
    const file = path.join(root, 'plan.md');
    fs.writeFileSync(file, expectedContent, { mode: 0o640 });
    const startOffset = expectedContent.indexOf('A typo.');
    await writeDocumentBlock(root, {
      documentPath: 'plan.md',
      expectedContent,
      startOffset,
      endOffset: startOffset + 7,
      replacement: 'A correction.',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(expectedContent.replace('A typo.', 'A correction.'));
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  it('rejects an outdated editor without losing external changes', async () => {
    const root = folder();
    const file = path.join(root, 'plan.md');
    fs.writeFileSync(file, 'Newer content');
    await expect(
      writeDocumentBlock(root, {
        documentPath: 'plan.md',
        expectedContent: 'Old content',
        startOffset: 0,
        endOffset: 3,
        replacement: 'My',
      }),
    ).rejects.toThrow(/changed/);
    expect(fs.readFileSync(file, 'utf8')).toBe('Newer content');
  });

  it('rejects invalid ranges, traversal, metadata paths, and symbolic links', async () => {
    const root = folder();
    const outside = folder();
    fs.writeFileSync(path.join(root, 'plan.md'), 'Plan');
    fs.writeFileSync(path.join(outside, 'plan.md'), 'Outside');
    fs.symlinkSync(outside, path.join(root, 'linked'));
    const args = {
      documentPath: 'plan.md',
      expectedContent: 'Plan',
      startOffset: 0,
      endOffset: 4,
      replacement: 'Edit',
    };
    for (const documentPath of ['../plan.md', '.parallel/runs/test.json', 'linked/plan.md']) {
      await expect(writeDocumentBlock(root, { ...args, documentPath })).rejects.toThrow();
    }
    for (const [startOffset, endOffset] of [
      [-1, 1],
      [2, 1],
      [0, 5],
      [0.5, 2],
    ]) {
      await expect(writeDocumentBlock(root, { ...args, startOffset, endOffset })).rejects.toThrow(
        /range/,
      );
    }
    expect(fs.readFileSync(path.join(root, 'plan.md'), 'utf8')).toBe('Plan');
    expect(fs.readFileSync(path.join(outside, 'plan.md'), 'utf8')).toBe('Outside');
  });
});

describe('readDocumentSnapshot', () => {
  it('does not read a document through a symbolic link', async () => {
    const root = folder();
    const outside = folder();
    fs.writeFileSync(path.join(outside, 'secret.md'), 'Not for the viewer');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'linked.md'));
    const snapshot = await readDocumentSnapshot(root, 'linked.md');
    expect(snapshot.content).toBe('');
    expect(snapshot.missing).toBe(true);
  });

  it('reads a plain document under a project root that is itself a symlink', async () => {
    const root = folder();
    fs.writeFileSync(path.join(root, 'plan.md'), 'Real content');
    const snapshot = await readDocumentSnapshot(root, 'plan.md');
    expect(snapshot.content).toBe('Real content');
    expect(snapshot.missing).toBe(false);
  });
});
