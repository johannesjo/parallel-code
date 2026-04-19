import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from './unified-diff-parser';

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------
describe('parseUnifiedDiff', () => {
  it('returns empty array for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(parseUnifiedDiff('   \n  \n')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Modified file detection (status 'M')
  // -------------------------------------------------------------------------
  describe('modified file', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index abc1234..def5678 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,4 +1,5 @@',
      ' import { foo } from "bar";',
      '-const old = 1;',
      '+const updated = 2;',
      '+const extra = 3;',
      ' ',
    ].join('\n');

    it('detects status M', () => {
      const result = parseUnifiedDiff(diff);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('M');
    });

    it('extracts file path', () => {
      const result = parseUnifiedDiff(diff);
      expect(result[0].path).toBe('src/app.ts');
    });

    it('is not binary', () => {
      const result = parseUnifiedDiff(diff);
      expect(result[0].binary).toBe(false);
    });

    it('parses hunk header', () => {
      const result = parseUnifiedDiff(diff);
      expect(result[0].hunks).toHaveLength(1);
      const hunk = result[0].hunks[0];
      expect(hunk.oldStart).toBe(1);
      expect(hunk.oldCount).toBe(4);
      expect(hunk.newStart).toBe(1);
      expect(hunk.newCount).toBe(5);
    });

    it('parses line types and content', () => {
      const result = parseUnifiedDiff(diff);
      const lines = result[0].hunks[0].lines;

      expect(lines[0]).toEqual({
        type: 'context',
        content: 'import { foo } from "bar";',
        oldLine: 1,
        newLine: 1,
      });
      expect(lines[1]).toEqual({
        type: 'remove',
        content: 'const old = 1;',
        oldLine: 2,
        newLine: null,
      });
      expect(lines[2]).toEqual({
        type: 'add',
        content: 'const updated = 2;',
        oldLine: null,
        newLine: 2,
      });
      expect(lines[3]).toEqual({
        type: 'add',
        content: 'const extra = 3;',
        oldLine: null,
        newLine: 3,
      });
      expect(lines[4]).toEqual({
        type: 'context',
        content: '',
        oldLine: 3,
        newLine: 4,
      });
    });
  });

  // -------------------------------------------------------------------------
  // New file detection (status 'A')
  // -------------------------------------------------------------------------
  describe('new file', () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,3 @@',
      '+line one',
      '+line two',
      '+line three',
    ].join('\n');

    it('detects status A', () => {
      const result = parseUnifiedDiff(diff);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('A');
    });

    it('extracts file path', () => {
      const result = parseUnifiedDiff(diff);
      expect(result[0].path).toBe('src/new.ts');
    });

    it('tracks line numbers for added lines', () => {
      const result = parseUnifiedDiff(diff);
      const lines = result[0].hunks[0].lines;
      expect(lines[0]).toEqual({
        type: 'add',
        content: 'line one',
        oldLine: null,
        newLine: 1,
      });
      expect(lines[2]).toEqual({
        type: 'add',
        content: 'line three',
        oldLine: null,
        newLine: 3,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Deleted file detection (status 'D')
  // -------------------------------------------------------------------------
  describe('deleted file', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/old.ts',
      'deleted file mode 100644',
      'index abc1234..0000000',
      '--- a/src/old.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line one',
      '-line two',
    ].join('\n');

    it('detects status D', () => {
      const result = parseUnifiedDiff(diff);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('D');
    });

    it('tracks line numbers for removed lines', () => {
      const result = parseUnifiedDiff(diff);
      const lines = result[0].hunks[0].lines;
      expect(lines[0]).toEqual({
        type: 'remove',
        content: 'line one',
        oldLine: 1,
        newLine: null,
      });
      expect(lines[1]).toEqual({
        type: 'remove',
        content: 'line two',
        oldLine: 2,
        newLine: null,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Binary file handling
  // -------------------------------------------------------------------------
  describe('binary file', () => {
    const diff = [
      'diff --git a/image.png b/image.png',
      'index abc1234..def5678 100644',
      'Binary files a/image.png and b/image.png differ',
    ].join('\n');

    it('sets binary to true', () => {
      const result = parseUnifiedDiff(diff);
      expect(result).toHaveLength(1);
      expect(result[0].binary).toBe(true);
    });

    it('has empty hunks', () => {
      const result = parseUnifiedDiff(diff);
      expect(result[0].hunks).toEqual([]);
    });

    it('extracts file path', () => {
      const result = parseUnifiedDiff(diff);
      expect(result[0].path).toBe('image.png');
    });
  });

  // -------------------------------------------------------------------------
  // New (untracked) binary file — pseudo-diff from backend
  // -------------------------------------------------------------------------
  describe('new binary file (untracked)', () => {
    const diff = [
      'diff --git a/assets/logo.png b/assets/logo.png',
      'new file mode 100644',
      'Binary files /dev/null and b/assets/logo.png differ',
    ].join('\n');

    it('detects as added binary', () => {
      const result = parseUnifiedDiff(diff);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('A');
      expect(result[0].binary).toBe(true);
      expect(result[0].hunks).toEqual([]);
    });

    it('extracts file path', () => {
      const result = parseUnifiedDiff(diff);
      expect(result[0].path).toBe('assets/logo.png');
    });
  });

  // -------------------------------------------------------------------------
  // Multiple files in one diff
  // -------------------------------------------------------------------------
  describe('multiple files', () => {
    const diff = [
      'diff --git a/file1.ts b/file1.ts',
      'index abc1234..def5678 100644',
      '--- a/file1.ts',
      '+++ b/file1.ts',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-old',
      '+new',
      ' line3',
      'diff --git a/file2.ts b/file2.ts',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/file2.ts',
      '@@ -0,0 +1,1 @@',
      '+hello',
    ].join('\n');

    it('parses both files', () => {
      const result = parseUnifiedDiff(diff);
      expect(result).toHaveLength(2);
    });

    it('first file is modified', () => {
      const result = parseUnifiedDiff(diff);
      expect(result[0].path).toBe('file1.ts');
      expect(result[0].status).toBe('M');
    });

    it('second file is added', () => {
      const result = parseUnifiedDiff(diff);
      expect(result[1].path).toBe('file2.ts');
      expect(result[1].status).toBe('A');
    });
  });

  // -------------------------------------------------------------------------
  // Multiple hunks in one file
  // -------------------------------------------------------------------------
  describe('multiple hunks', () => {
    const diff = [
      'diff --git a/big.ts b/big.ts',
      'index abc1234..def5678 100644',
      '--- a/big.ts',
      '+++ b/big.ts',
      '@@ -1,3 +1,3 @@',
      ' first',
      '-old1',
      '+new1',
      ' third',
      '@@ -10,3 +10,4 @@',
      ' context',
      '-old2',
      '+new2',
      '+added',
      ' end',
    ].join('\n');

    it('parses two hunks', () => {
      const result = parseUnifiedDiff(diff);
      expect(result[0].hunks).toHaveLength(2);
    });

    it('second hunk has correct header', () => {
      const result = parseUnifiedDiff(diff);
      const hunk = result[0].hunks[1];
      expect(hunk.oldStart).toBe(10);
      expect(hunk.oldCount).toBe(3);
      expect(hunk.newStart).toBe(10);
      expect(hunk.newCount).toBe(4);
    });

    it('second hunk tracks line numbers from hunk start', () => {
      const result = parseUnifiedDiff(diff);
      const lines = result[0].hunks[1].lines;
      expect(lines[0]).toEqual({
        type: 'context',
        content: 'context',
        oldLine: 10,
        newLine: 10,
      });
      expect(lines[3]).toEqual({
        type: 'add',
        content: 'added',
        oldLine: null,
        newLine: 12,
      });
    });
  });

  // -------------------------------------------------------------------------
  // No newline at end of file
  // -------------------------------------------------------------------------
  describe('no newline at end of file marker', () => {
    const diff = [
      'diff --git a/file.ts b/file.ts',
      'index abc1234..def5678 100644',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,2 +1,2 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ].join('\n');

    it('skips no-newline markers', () => {
      const result = parseUnifiedDiff(diff);
      const lines = result[0].hunks[0].lines;
      expect(lines).toHaveLength(2);
      expect(lines[0].type).toBe('remove');
      expect(lines[1].type).toBe('add');
    });
  });

  // -------------------------------------------------------------------------
  // Hunk line ranges with count omitted (count defaults to 1)
  // -------------------------------------------------------------------------
  describe('hunk with omitted count', () => {
    const diff = [
      'diff --git a/single.ts b/single.ts',
      'index abc1234..def5678 100644',
      '--- a/single.ts',
      '+++ b/single.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');

    it('defaults omitted count to 1', () => {
      const result = parseUnifiedDiff(diff);
      const hunk = result[0].hunks[0];
      expect(hunk.oldCount).toBe(1);
      expect(hunk.newCount).toBe(1);
    });
  });
});
