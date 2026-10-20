/**
 * Onboarding for document projects: what a folder already offers, and the
 * smallest set of steps that turns it into something the workspace can run
 * against — a Git repository whose chosen document is committed.
 */
import fs from 'fs';
import path from 'path';
import { ensureWorktreeContainerExclude } from '../ipc/git.js';
import { git, gitOk } from './git.js';
import { errMessage, warn } from '../log.js';
import { validateDocumentPath } from './runs.js';
import type { DocumentFileInfo, DocumentFolderInfo, DocumentProjectSetup } from './types.js';

const MAX_FILES = 1000;
/** Entries the pre-repository scan reads at most, so a picked home folder answers quickly. */
const MAX_ENTRIES = 20_000;
/** How far the pre-repository scan walks before it stops looking. */
const SCAN_DEPTH = 4;
const DOCUMENT_RE = /\.(md|markdown|html?)$/i;
const HTML_RE = /\.html?$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.parallel', '.worktrees']);
/** Source files and build manifests: what makes a folder a code project rather than a writing one. */
const CODE_EXTENSIONS =
  'c cc cpp cs go h hpp java js jsx kt mjs php py rb rs svelte swift ts tsx vue'.split(' ');
const CODE_RE = new RegExp(`\\.(${CODE_EXTENSIONS.join('|')})$`, 'i');
const CODE_MARKERS = new Set([
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'Makefile',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
]);

export function isDocument(file: string): boolean {
  return DOCUMENT_RE.test(file);
}

function isCodeFile(file: string): boolean {
  const base = path.basename(file);
  return CODE_MARKERS.has(base) || CODE_RE.test(base);
}

export async function repoToplevel(folder: string): Promise<string | null> {
  try {
    const out = await git(folder, ['rev-parse', '--show-toplevel']);
    return fs.realpathSync(out.trim());
  } catch {
    return null;
  }
}

/**
 * Documents in a folder that is not a repository of its own, so the picker
 * still has something to show, and whether any code sits beside them.
 */
function scanFolder(folder: string): { documents: string[]; looksLikeCode: boolean } {
  const found: string[] = [];
  let looksLikeCode = false;
  let visited = 0;
  // Past MAX_FILES documents the walk goes on only to learn whether code sits beside them.
  const done = () => visited >= MAX_ENTRIES || (found.length >= MAX_FILES && looksLikeCode);
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > SCAN_DEPTH || done()) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (done()) return;
      visited++;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), child, depth + 1);
      else if (!entry.isFile()) continue;
      else if (isDocument(entry.name)) {
        if (found.length < MAX_FILES) found.push(child);
      } else if (isCodeFile(entry.name)) looksLikeCode = true;
    }
  };
  walk(folder, '', 0);
  return { documents: found.sort(), looksLikeCode };
}

const DOCUMENT_PATHSPEC = ['--', '*.md', '*.markdown', '*.html', '*.htm'];
/** Asks git for code files only, rather than listing a whole repository to look for one. */
const CODE_PATHSPEC = [
  '--',
  ...CODE_EXTENSIONS.map((ext) => `:(icase)*.${ext}`),
  ...[...CODE_MARKERS].map((marker) => `:(glob)**/${marker}`),
  // Dot-folders hold tool settings (an Obsidian vault's plugins), not the project's code;
  // the scan of a folder that is not a repository skips them too.
  ':(exclude,glob)**/.*/**',
];

/** Whether the repository holds code; unknown (an error) reads as no, so the picker still works. */
async function repoHasCode(folder: string): Promise<boolean> {
  try {
    const out = await git(folder, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      ...CODE_PATHSPEC,
    ]);
    return out.length > 0;
  } catch (err) {
    warn('documents', 'Could not tell whether the repository holds code', {
      folder,
      error: errMessage(err),
    });
    return false;
  }
}

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
    return {
      exists: false,
      isRepo: false,
      enclosingRepo: null,
      hasCommits: false,
      looksLikeCode: false,
      files: [],
    };
  const toplevel = await repoToplevel(folder);
  const isRepo = toplevel !== null && toplevel === fs.realpathSync(folder);
  if (!isRepo) {
    const scan = scanFolder(folder);
    const files = scan.documents.map((p): DocumentFileInfo => ({ path: p, committed: false }));
    return {
      exists: true,
      isRepo: false,
      enclosingRepo: toplevel,
      hasCommits: false,
      looksLikeCode: scan.looksLikeCode,
      files,
    };
  }
  const hasCommits = await gitOk(folder, ['rev-parse', '--verify', 'HEAD']);
  const tracked = new Set(await listDocuments(folder, []));
  const untracked = await listDocuments(folder, ['--others', '--exclude-standard']);
  const files = [...tracked, ...untracked]
    .sort()
    .slice(0, MAX_FILES)
    .map((p): DocumentFileInfo => ({ path: p, committed: hasCommits && tracked.has(p) }));
  const looksLikeCode = await repoHasCode(folder);
  return { exists: true, isRepo: true, enclosingRepo: null, hasCommits, looksLikeCode, files };
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

export function starterContent(documentPath: string, title?: string): string {
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
