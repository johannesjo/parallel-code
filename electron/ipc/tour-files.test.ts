import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOUR_FILE_MAX_CHARS } from '../shared/understanding-limits.js';
import { saveTourFile } from './tour-files.js';

let worktree: string;
let outside: string;

beforeEach(() => {
  worktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tour-worktree-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tour-outside-')));
});

afterEach(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const save = (relative: unknown, content: unknown = '# Tour\n', replace = false) =>
  saveTourFile(worktree, { path: relative, content, replace });
/** Replaces a saved tour that should still hold `expected`. */
const update = (relative: string, content: string, expected: string) =>
  saveTourFile(worktree, { path: relative, content, replace: true, expected });

describe('saveTourFile', () => {
  it('writes a new tour and never overwrites another file of that name', () => {
    expect(save('cache.tour.md', 'one')).toBe('cache.tour.md');
    expect(save('cache.tour.md', 'two')).toBe('cache-2.tour.md');
    expect(fs.readFileSync(path.join(worktree, 'cache.tour.md'), 'utf8')).toBe('one');
    expect(fs.readFileSync(path.join(worktree, 'cache-2.tour.md'), 'utf8')).toBe('two');
  });

  it('updates its own file when asked to replace it', () => {
    save('cache.tour.md', 'one');
    expect(update('cache.tour.md', 'updated', 'one')).toBe('cache.tour.md');
    expect(fs.readFileSync(path.join(worktree, 'cache.tour.md'), 'utf8')).toBe('updated');
  });

  it('refuses to replace a file without knowing what it should still hold', () => {
    save('cache.tour.md', 'one');
    expect(() => save('cache.tour.md', 'two', true)).toThrow('expected');
    expect(fs.readFileSync(path.join(worktree, 'cache.tour.md'), 'utf8')).toBe('one');
  });

  it('refuses to replace a file that changed since it was last written', () => {
    save('cache.tour.md', 'one');
    fs.writeFileSync(path.join(worktree, 'cache.tour.md'), 'edited by hand');
    expect(() =>
      saveTourFile(worktree, {
        path: 'cache.tour.md',
        content: 'two',
        replace: true,
        expected: 'one',
      }),
    ).toThrow('changed on disk');
    expect(fs.readFileSync(path.join(worktree, 'cache.tour.md'), 'utf8')).toBe('edited by hand');
    expect(
      saveTourFile(worktree, {
        path: 'cache.tour.md',
        content: 'three',
        replace: true,
        expected: 'edited by hand',
      }),
    ).toBe('cache.tour.md');
  });

  it('does not bring back a saved tour that was removed', () => {
    save('cache.tour.md', 'one');
    fs.rmSync(path.join(worktree, 'cache.tour.md'));
    expect(() => update('cache.tour.md', 'two', 'one')).toThrow('changed on disk');
    expect(fs.existsSync(path.join(worktree, 'cache.tour.md'))).toBe(false);
  });

  it('saves into an existing folder of the worktree', () => {
    fs.mkdirSync(path.join(worktree, 'docs'));
    expect(save('./docs//plan.tour.md')).toBe('docs/plan.tour.md');
    expect(() => save('missing/plan.tour.md')).toThrow('does not exist');
  });

  it.each([
    ['../escape.tour.md', '".."'],
    ['/tmp/abs.tour.md', 'relative'],
    ['notes.md', 'Only .tour.md'],
    ['.git/x.tour.md', '.git'],
    ['.GIT/x.tour.md', '.git'],
    ['sub/.git/x.tour.md', '.git'],
    ['', 'relative'],
    [42, 'must be a string'],
  ])('rejects the path %s', (relative, message) => {
    expect(() => save(relative)).toThrow(message);
  });

  it('rejects content that is not a tour-sized string', () => {
    expect(() => save('a.tour.md', 7)).toThrow('content must be a string');
    expect(() => save('a.tour.md', 'x'.repeat(TOUR_FILE_MAX_CHARS + 1))).toThrow('too large');
  });

  it('never follows a symlinked folder out of the worktree', () => {
    fs.symlinkSync(outside, path.join(worktree, 'linked'));
    expect(() => save('linked/a.tour.md')).toThrow('inside the worktree');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('never writes through a symlink in place of the file', () => {
    const victim = path.join(outside, 'victim.md');
    fs.writeFileSync(victim, 'keep');
    fs.symlinkSync(victim, path.join(worktree, 'a.tour.md'));
    expect(() => save('a.tour.md', 'pwned', true)).toThrow('no longer a regular file');
    // A first save steps past the link to a free name instead.
    expect(save('a.tour.md', 'fresh')).toBe('a-2.tour.md');
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
  });
});
