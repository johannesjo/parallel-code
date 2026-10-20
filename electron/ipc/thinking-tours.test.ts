import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({ warn: vi.fn() }));
import { TOUR_FILE_MAX_CHARS } from '../shared/understanding-limits.js';
import { listThinkingTours } from './thinking-tours.js';

let root: string;
let dir: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-')));
  dir = path.join(root, 'thinking');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('listThinkingTours', () => {
  it('creates the folder on first use and lists nothing', () => {
    expect(listThinkingTours(dir)).toEqual({ dir, tours: [] });
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('lists saved tours newest first with their text', () => {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'old.tour.md'), 'old');
    fs.utimesSync(path.join(dir, 'old.tour.md'), 1000, 1000);
    fs.writeFileSync(path.join(dir, 'new.tour.md'), 'new');
    const { tours } = listThinkingTours(dir);
    expect(tours.map((tour) => [tour.path, tour.content])).toEqual([
      ['new.tour.md', 'new'],
      ['old.tour.md', 'old'],
    ]);
  });

  // Root reads any file, so the unreadable one cannot be made there.
  it.skipIf(process.getuid?.() === 0)('skips a tour it cannot read and lists the rest', () => {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'locked.tour.md'), 'locked');
    fs.chmodSync(path.join(dir, 'locked.tour.md'), 0o000);
    fs.writeFileSync(path.join(dir, 'open.tour.md'), 'open');
    expect(listThinkingTours(dir).tours.map((tour) => tour.path)).toEqual(['open.tour.md']);
  });

  it('skips other files, folders, symlinks and files too large to be tours', () => {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'notes.md'), 'x');
    fs.mkdirSync(path.join(dir, 'folder.tour.md'));
    fs.writeFileSync(path.join(root, 'outside.tour.md'), 'secret');
    fs.symlinkSync(path.join(root, 'outside.tour.md'), path.join(dir, 'link.tour.md'));
    fs.writeFileSync(path.join(dir, 'big.tour.md'), 'x'.repeat(TOUR_FILE_MAX_CHARS + 1));
    expect(listThinkingTours(dir).tours).toEqual([]);
  });
});
