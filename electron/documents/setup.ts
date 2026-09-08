/**
 * Onboarding for document projects: what a folder already offers, and the
 * smallest set of steps that turns it into something the workspace can run
 * against — a Git repository whose chosen document is committed.
 */
import fs from 'fs';
import path from 'path';
import { ensureWorktreeContainerExclude } from '../ipc/git.js';
import { git, gitOk } from './git.js';
import { validateDocumentPath } from './runs.js';
import type { DocumentFileInfo, DocumentFolderInfo, DocumentProjectSetup } from './types.js';

const MAX_FILES = 1000;
/** How far the pre-repository scan walks before it stops looking. */
const SCAN_DEPTH = 4;
const DOCUMENT_RE = /\.(md|markdown|html?)$/i;
const HTML_RE = /\.html?$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.parallel', '.worktrees']);

function isDocument(file: string): boolean {
  return DOCUMENT_RE.test(file);
}

async function repoToplevel(folder: string): Promise<string | null> {
  try {
    const out = await git(folder, ['rev-parse', '--show-toplevel']);
    return fs.realpathSync(out.trim());
  } catch {
    return null;
  }
}

/** Documents in a folder that is not a repository yet, so the picker still has something to show. */
function scanDocuments(folder: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > SCAN_DEPTH || found.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), child, depth + 1);
      else if (entry.isFile() && isDocument(entry.name)) found.push(child);
    }
  };
  walk(folder, '', 0);
  return found.sort();
}

const DOCUMENT_PATHSPEC = ['--', '*.md', '*.markdown', '*.html', '*.htm'];

async function listDocuments(folder: string, lsFilesArgs: string[]): Promise<string[]> {
  const out = await git(folder, ['ls-files', '-z', ...lsFilesArgs, ...DOCUMENT_PATHSPEC]);
  return out
    .split('\0')
    .filter((p) => p && !p.startsWith('.parallel/') && !p.startsWith('.worktrees/'));
}

/**
 * What the picker needs to decide between "open this document" and "set this
 * folder up first". Untracked files are listed too: `prepareDocumentProject`
 * commits whatever the user picks, so there is no reason to hide it.
 */
export async function inspectDocumentFolder(folder: string): Promise<DocumentFolderInfo> {
  // The folder is allowed not to exist: the picker inspects what the user is
  // still typing, and setup creates whatever is missing.
  if (!fs.existsSync(folder))
    return { exists: false, isRepo: false, enclosingRepo: null, hasCommits: false, files: [] };
  const toplevel = await repoToplevel(folder);
  const isRepo = toplevel !== null && toplevel === fs.realpathSync(folder);
  if (!isRepo) {
    const files = scanDocuments(folder).map(
      (p): DocumentFileInfo => ({ path: p, committed: false }),
    );
    return { exists: true, isRepo: false, enclosingRepo: toplevel, hasCommits: false, files };
  }
  const hasCommits = await gitOk(folder, ['rev-parse', '--verify', 'HEAD']);
  const tracked = new Set(await listDocuments(folder, []));
  const untracked = await listDocuments(folder, ['--others', '--exclude-standard']);
  const files = [...tracked, ...untracked]
    .sort()
    .slice(0, MAX_FILES)
    .map((p): DocumentFileInfo => ({ path: p, committed: hasCommits && tracked.has(p) }));
  return { exists: true, isRepo: true, enclosingRepo: null, hasCommits, files };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `notes.md` → `Notes`; the heading a brand-new document opens with. */
function starterTitle(documentPath: string, title?: string): string {
  const given = title?.replace(/\s+/g, ' ').trim();
  if (given) return given;
  const name = path.basename(documentPath).replace(DOCUMENT_RE, '').replace(/[-_]+/g, ' ').trim();
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function starterContent(documentPath: string, title?: string): string {
  const heading = starterTitle(documentPath, title);
  if (!HTML_RE.test(documentPath)) return `# ${heading}\n\n`;
  const safe = escapeHtml(heading);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>${safe}</title>`,
    '</head>',
    '<body>',
    `  <h1>${safe}</h1>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** A name without a document extension becomes markdown. */
function withDocumentExtension(documentPath: string): string {
  return isDocument(documentPath) ? documentPath : `${documentPath}.md`;
}

/**
 * Brings `folder` up to what the workspace assumes: a folder that exists, is a
 * repository of its own, and holds `requestedPath` as a commit. Every step is
 * skipped when it is already true, so re-running this on a ready project does
 * nothing. `title` is the heading a document created here opens with; without
 * it the file name serves.
 */
export async function prepareDocumentProject(
  folder: string,
  requestedPath: string,
  title?: string,
): Promise<DocumentProjectSetup> {
  if (fs.existsSync(folder) && !fs.statSync(folder).isDirectory())
    throw new Error(`${folder} is a file, not a folder.`);
  const documentPath = withDocumentExtension(validateDocumentPath(requestedPath));
  const actions: string[] = [];

  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
    actions.push('Created the folder');
  }

  const toplevel = await repoToplevel(folder);
  if (toplevel !== null && toplevel !== fs.realpathSync(folder))
    throw new Error(
      `That folder sits inside the Git repository at ${toplevel}. Pick that repository instead, ` +
        'so proposals and history stay in one place.',
    );
  if (toplevel === null) {
    await git(folder, ['init', '-b', 'main']);
    actions.push('Initialised a Git repository');
  }
  ensureWorktreeContainerExclude(folder);

  const absolute = path.join(folder, documentPath);
  if (!fs.existsSync(absolute)) {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, starterContent(documentPath, title));
    actions.push(`Created ${documentPath}`);
  }

  // Runs need a commit to branch from, so an uncommitted document is the one
  // gap setup always closes. `--only` commits the document alone and leaves
  // anything the user had staged staged; the `add` before it is what makes an
  // untracked path committable, and is required at all in a repo with no HEAD.
  if (!(await gitOk(folder, ['cat-file', '-e', `HEAD:${documentPath}`]))) {
    await git(folder, ['add', '-f', '--', documentPath]);
    await git(folder, ['commit', '-q', '--only', '-m', `Add ${documentPath}`, '--', documentPath]);
    actions.push(`Committed ${documentPath}`);
  }
  return { documentPath, actions };
}
