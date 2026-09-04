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
const MARKDOWN_RE = /\.(md|markdown)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.parallel', '.worktrees']);

function isMarkdown(file: string): boolean {
  return MARKDOWN_RE.test(file);
}

async function repoToplevel(folder: string): Promise<string | null> {
  try {
    const out = await git(folder, ['rev-parse', '--show-toplevel']);
    return fs.realpathSync(out.trim());
  } catch {
    return null;
  }
}

/** Markdown in a folder that is not a repository yet, so the picker still has something to show. */
function scanMarkdown(folder: string): string[] {
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
      else if (entry.isFile() && isMarkdown(entry.name)) found.push(child);
    }
  };
  walk(folder, '', 0);
  return found.sort();
}

const MARKDOWN_PATHSPEC = ['--', '*.md', '*.markdown'];

async function listMarkdown(folder: string, lsFilesArgs: string[]): Promise<string[]> {
  const out = await git(folder, ['ls-files', '-z', ...lsFilesArgs, ...MARKDOWN_PATHSPEC]);
  return out
    .split('\0')
    .filter((p) => p && !p.startsWith('.parallel/') && !p.startsWith('.worktrees/'));
}

/**
 * What the picker needs to decide between "open this document" and "set this
 * folder up first". Untracked Markdown is listed too: `prepareDocumentProject`
 * commits whatever the user picks, so there is no reason to hide it.
 */
export async function inspectDocumentFolder(folder: string): Promise<DocumentFolderInfo> {
  const toplevel = await repoToplevel(folder);
  const isRepo = toplevel !== null && toplevel === fs.realpathSync(folder);
  if (!isRepo) {
    const files = scanMarkdown(folder).map(
      (p): DocumentFileInfo => ({ path: p, committed: false }),
    );
    return { isRepo: false, enclosingRepo: toplevel, hasCommits: false, files };
  }
  const hasCommits = await gitOk(folder, ['rev-parse', '--verify', 'HEAD']);
  const tracked = new Set(await listMarkdown(folder, []));
  const untracked = await listMarkdown(folder, ['--others', '--exclude-standard']);
  const files = [...tracked, ...untracked]
    .sort()
    .slice(0, MAX_FILES)
    .map((p): DocumentFileInfo => ({ path: p, committed: hasCommits && tracked.has(p) }));
  return { isRepo: true, enclosingRepo: null, hasCommits, files };
}

/** `notes.md` → `Notes`; the heading a brand-new document opens with. */
function starterContent(documentPath: string): string {
  const title = path.basename(documentPath).replace(MARKDOWN_RE, '').replace(/[-_]+/g, ' ').trim();
  return `# ${title.charAt(0).toUpperCase()}${title.slice(1)}\n\n`;
}

function withMarkdownExtension(documentPath: string): string {
  return isMarkdown(documentPath) ? documentPath : `${documentPath}.md`;
}

/**
 * Brings `folder` up to what the workspace assumes: a repository of its own,
 * with `requestedPath` committed. Every step is skipped when it is already
 * true, so re-running this on a ready project does nothing.
 */
export async function prepareDocumentProject(
  folder: string,
  requestedPath: string,
): Promise<DocumentProjectSetup> {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory())
    throw new Error('Pick a folder that exists.');
  const documentPath = withMarkdownExtension(validateDocumentPath(requestedPath));
  const actions: string[] = [];

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
    fs.writeFileSync(absolute, starterContent(documentPath));
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
