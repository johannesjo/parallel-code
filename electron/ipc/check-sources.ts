import fs from 'fs';
import path from 'path';
import type { CheckSource } from '../shared/evidence.js';

/** Root files whose content names a project's commands. */
const CONTENT_FILES = [
  'package.json',
  'deno.json',
  'Makefile',
  'justfile',
  'Taskfile.yml',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'setup.cfg',
  'tox.ini',
  'noxfile.py',
  'composer.json',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'mix.exs',
  'AGENTS.md',
  'CLAUDE.md',
];
/** Root files whose presence alone tells the package manager or tool. */
const MARKER_FILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'uv.lock',
  'poetry.lock',
  'Pipfile.lock',
  'gradlew',
  'playwright.config.ts',
  'playwright.config.js',
  'cypress.config.ts',
  'cypress.config.js',
];
const WORKFLOW_DIR = '.github/workflows';
const MAX_WORKFLOWS = 4;
const MAX_FILE_CHARS = 24_000;
const MAX_TOTAL_CHARS = 150_000;

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Whether `full` is a real file or directory, not a symlink that could point out of the repository. */
async function isReal(full: string, kind: 'file' | 'dir'): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(full);
    return kind === 'file' ? stat.isFile() : stat.isDirectory();
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

/** Reads at most MAX_FILE_CHARS bytes, so a huge file is never loaded whole. */
async function readRegularFile(root: string, relative: string): Promise<string | undefined> {
  const full = path.join(root, relative);
  if (!(await isReal(full, 'file'))) return undefined;
  // O_NOFOLLOW closes the gap between the lstat above and this open.
  const handle = await fs.promises.open(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(MAX_FILE_CHARS + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, Math.min(bytesRead, MAX_FILE_CHARS)).toString('utf8');
    return bytesRead > MAX_FILE_CHARS ? `${text}\n[truncated]` : text;
  } finally {
    await handle.close();
  }
}

async function workflowFiles(root: string): Promise<string[]> {
  const github = path.join(root, '.github');
  const dir = path.join(root, WORKFLOW_DIR);
  if (!(await isReal(github, 'dir')) || !(await isReal(dir, 'dir'))) return [];
  try {
    const names = await fs.promises.readdir(dir);
    return names
      .filter((name) => /\.ya?ml$/i.test(name))
      .sort()
      .slice(0, MAX_WORKFLOWS)
      .map((name) => `${WORKFLOW_DIR}/${name}`);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/**
 * Reads the files a model needs to suggest a project's verify command and
 * evidence checks: manifests, task runners, CI workflows and agent guidance,
 * plus a list of lockfiles and test-runner configs that are present.
 */
export async function readCheckSources(projectRoot: string): Promise<CheckSource[]> {
  const sources: CheckSource[] = [];
  let total = 0;
  for (const relative of [...CONTENT_FILES, ...(await workflowFiles(projectRoot))]) {
    const text = await readRegularFile(projectRoot, relative);
    if (text === undefined || total + text.length > MAX_TOTAL_CHARS) continue;
    total += text.length;
    sources.push({ path: relative, text });
  }
  const present: string[] = [];
  for (const name of MARKER_FILES) {
    if (await isReal(path.join(projectRoot, name), 'file')) present.push(name);
  }
  if (present.length > 0) sources.push({ path: '(files present)', text: present.join('\n') });
  return sources;
}
