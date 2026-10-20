import fs from 'fs';
import path from 'path';

import { TOUR_FILE_MAX_CHARS, TOUR_FILE_SUFFIX } from '../shared/understanding-limits.js';
import { warn as logWarn } from '../log.js';

/** Enough for a list to pick from; older tours stay on disk. */
const MAX_LISTED = 50;

export interface ThinkingTourEntry {
  /** The file's name inside the thinking folder, as tours save to it. */
  path: string;
  content: string;
  modifiedAt: number;
}

/**
 * The tours the reader wrote outside any task, newest first, with their text so
 * the list needs no further reads. Creates the folder on first use, so the
 * folder returned can be saved into straight away. Only regular files count:
 * a symlink could otherwise show a file from anywhere on the disk.
 */
export function listThinkingTours(dir: string): { dir: string; tours: ThinkingTourEntry[] } {
  fs.mkdirSync(dir, { recursive: true });
  const tours = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(TOUR_FILE_SUFFIX))
    .flatMap((entry) =>
      readable(dir, entry.name, (file) => ({ name: entry.name, stat: fs.lstatSync(file) })),
    )
    // Bytes bound the characters from above, so this never drops a tour that fits.
    .filter(({ stat }) => stat.isFile() && stat.size <= TOUR_FILE_MAX_CHARS * 4)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(0, MAX_LISTED)
    .flatMap(({ name, stat }) =>
      readable(dir, name, (file) => ({
        path: name,
        content: fs.readFileSync(file, 'utf8'),
        modifiedAt: stat.mtimeMs,
      })),
    )
    .filter((tour) => tour.content.length <= TOUR_FILE_MAX_CHARS);
  return { dir, tours };
}

/**
 * One file's result, or none when it cannot be read: a file gone since the
 * folder was listed, or one without read access, must not hide the other tours.
 */
function readable<T>(dir: string, name: string, read: (file: string) => T): T[] {
  try {
    return [read(path.join(dir, name))];
  } catch (error) {
    logWarn('thinkingTours', 'Could not read a thinking tour', { name, error: String(error) });
    return [];
  }
}
