// A worktree's changed files and tool-sized diff, shared by child and peer task views.

import {
  detectPreambleFiles,
  filterDiffSections,
  buildNormalizedPreambleFileDiff,
} from './preamble.js';
import { truncateDiffForTool } from './diff-format.js';
import { getChangedFiles, getAllFileDiffs, getDiffBaseSha } from '../ipc/git.js';
import type { ApiDiffResult } from './types.js';

/** Changed files and unified diff against the merge base, without app-injected preamble edits. */
export async function getWorktreeDiff(
  worktreePath: string,
  baseBranch?: string,
): Promise<ApiDiffResult> {
  // Compute baseSha first so detectDiffBase/pinHead results are cached.
  // getChangedFiles and getAllFileDiffs internally call the same helpers;
  // running all three concurrently causes three simultaneous cache misses.
  const baseSha = await getDiffBaseSha(worktreePath, baseBranch);
  const [files, diff] = await Promise.all([
    getChangedFiles(worktreePath, baseBranch),
    getAllFileDiffs(worktreePath, baseBranch),
  ]);

  // For preamble-bearing files: strip the injected block and show only real sub-task edits.
  // Files with no real changes beyond the preamble are excluded entirely.
  // Files with real changes (before or after the preamble block) include a normalized diff.
  const preambleFiles = await detectPreambleFiles(worktreePath);

  let filteredFiles = files;
  let filteredDiff = diff;
  if (preambleFiles.size > 0) {
    // Drop preamble file sections from the raw diff; we'll add normalized sections below.
    filteredDiff = filterDiffSections(diff, preambleFiles);
    // For each preamble file, generate a diff that excludes the injected block.
    const normalizedSections = await Promise.all(
      [...preambleFiles].map((f) => buildNormalizedPreambleFileDiff(f, worktreePath, baseSha)),
    );
    const preambleFilesWithChanges = new Set<string>();
    for (let i = 0; i < [...preambleFiles].length; i++) {
      if (normalizedSections[i]) preambleFilesWithChanges.add([...preambleFiles][i]);
    }
    filteredDiff += normalizedSections.filter(Boolean).join('');
    // Files list: exclude preamble-only files, keep files with real changes.
    filteredFiles = files.filter(
      (f) => !preambleFiles.has(f.path) || preambleFilesWithChanges.has(f.path),
    );
  }

  const truncatedDiff = truncateDiffForTool(filteredDiff);
  if (truncatedDiff.truncated) {
    return {
      files: filteredFiles,
      diff: truncatedDiff.diff,
      truncated: true,
      originalSizeBytes: truncatedDiff.originalSizeBytes,
    };
  }
  return { files: filteredFiles, diff: truncatedDiff.diff };
}
