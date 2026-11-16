/**
 * Task content made ready for a model prompt: a diff fingerprint, a diff
 * excerpt that fits a budget, and fenced prompts. Pure helpers.
 */

import { diffStats } from './app-facts';
import { repoContent } from './repo-content';

const DIFF_EXCERPT_LIMITS = {
  diffChars: 20_000,
  promptsChars: 6_000,
} as const;

/** Cheap, stable fingerprint of a diff (FNV-1a), to tell whether the code moved on. */
export function diffFingerprint(rawDiff: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < rawDiff.length; i++) {
    hash ^= rawDiff.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${rawDiff.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

const TRUNCATED = '\n[… truncated]';

function excerpt(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}${TRUNCATED}`;
}

/** Long and machine-written: they would crowd real code out of the diff budget. */
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
]);
/** A file cut shorter than this shows too little to be worth its header. */
const MIN_FILE_CHARS = 200;
/** Share of the diff budget the file list may take on a branch touching very many files. */
const FILE_LIST_SHARE = 0.2;

interface DiffFile {
  path: string;
  text: string;
  added: number;
  removed: number;
}

function isLockfile(path: string): boolean {
  return LOCKFILES.has(path.slice(path.lastIndexOf('/') + 1)) || /\.min\.(js|css)$/.test(path);
}

function splitDiffFiles(rawDiff: string): DiffFile[] {
  return rawDiff
    .split(/^(?=diff --git )/m)
    .filter((text) => text.trim())
    .map((text) => {
      const { added, removed } = diffStats(text);
      // Git quotes paths with unusual characters: diff --git "a/…" "b/…".
      const path = /^diff --git "?a\/.+?"? "?b\/(.+?)"?$/m.exec(text)?.[1] ?? '';
      return { path, text: text.trimEnd(), added, removed };
    });
}

/** Small files fit whole; large ones share what is left evenly. */
function allotBudgets(sizes: readonly number[], budget: number): number[] {
  const allot = sizes.map(() => 0);
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b]);
  let left = budget;
  order.forEach((index, n) => {
    allot[index] = Math.min(sizes[index], Math.floor(left / (order.length - n)));
    left -= allot[index];
  });
  return allot;
}

/**
 * The diff as a model reads it: a list of every changed file first, then
 * each file's diff without lockfiles, cut per file rather than at the end, so a
 * large early file cannot push later ones out. Stays within `budget` characters.
 */
export function prepareDiffExcerpt(
  rawDiff: string,
  budget: number = DIFF_EXCERPT_LIMITS.diffChars,
) {
  const files = splitDiffFiles(rawDiff);
  const list = files
    .filter((file) => file.path)
    .map((f) => `${f.path} +${f.added} -${f.removed}${isLockfile(f.path) ? ' (left out)' : ''}`)
    .join('\n');
  const header = `Changed files:\n${excerpt(list, Math.floor(budget * FILE_LIST_SHARE))}\n\n`;
  const kept = files.filter((file) => !isLockfile(file.path));
  const allot = allotBudgets(
    kept.map((file) => file.text.length + 1),
    budget - header.length,
  );
  const bodies = kept.map((file, i) => {
    if (file.text.length < allot[i]) return file.text;
    // The list above still names a file left out here.
    if (allot[i] < MIN_FILE_CHARS) return '';
    return `${file.text.slice(0, allot[i] - TRUNCATED.length - 1)}${TRUNCATED}`;
  });
  return header + bodies.filter(Boolean).join('\n');
}

/**
 * Fences each prompt on its own, newest kept first: when they exceed the budget
 * the oldest are dropped, and each is truncated before fencing so its fence closes.
 */
export function fencePrompts(
  prompts: readonly string[],
  limit: number = DIFF_EXCERPT_LIMITS.promptsChars,
): string {
  const kept: string[] = [];
  let budget = limit;
  for (let i = prompts.length - 1; i >= 0 && budget > 0; i--) {
    const text = excerpt(prompts[i], budget);
    budget -= text.length;
    kept.unshift(repoContent(text));
  }
  const dropped = prompts.length - kept.length;
  return [...(dropped ? [`(${dropped} older prompt(s) left out)`] : []), ...kept].join('\n');
}
