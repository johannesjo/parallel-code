import type { DocumentFolderInfo } from './types';

/** How a folder opens: task terminals, or the document workspace. */
export type AddProjectKind = 'code' | 'document';

/**
 * What a folder most likely is. Anything without source files or a build
 * manifest — including a folder that does not exist yet — reads as writing.
 */
export function guessProjectKind(info: DocumentFolderInfo | null | undefined): AddProjectKind {
  return info?.exists && info.looksLikeCode ? 'code' : 'document';
}

/**
 * Where documents open as quick edits rather than a project of their own: the
 * repository the folder sits inside, or the folder itself when it holds code.
 * Committing there would sweep the user's work in progress into the app's
 * commits, and a code folder that is not a repository yet should not become one.
 */
export function quickEditRepo(
  folder: string,
  info: DocumentFolderInfo | null | undefined,
): string | null {
  if (!info) return null;
  if (info.enclosingRepo) return info.enclosingRepo;
  return info.looksLikeCode ? folder : null;
}

/** `/repo/docs/` + `spec.md` → `/repo/docs/spec.md` */
export function joinFolderPath(folder: string, file: string): string {
  return `${folder.replace(/\/+$/, '')}/${file}`;
}

/** `/notes/design/` → `design`; the root names itself. */
export function folderName(folder: string): string {
  return folder.replace(/\/+$/, '').split('/').pop() || folder;
}
