/** Context bundle for a file tour: the subject file plus its direct relative imports. */
export interface FileTourContext {
  /** Worktree-relative path of the subject file. */
  filePath: string;
  files: { path: string; content: string; truncated: boolean }[];
  /** Imports that were skipped because of caps or resolution failure. */
  omitted: string[];
}
