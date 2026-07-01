import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { readFile as fsReadFile, unlink as fsUnlink } from 'fs/promises';
import { atomicWriteFile } from './atomic.js';
import { join } from 'path';
import os from 'os';

const execAsync = promisify(execFile);

const PREAMBLE_START = '<sub-task-mode>';
const PREAMBLE_END = '</sub-task-mode>';

const PREAMBLE_MD_FILES = ['AGENTS.md', 'GEMINI.md', '.agent.md'] as const;

/** Remove the injected `<sub-task-mode>…</sub-task-mode>` block and its surrounding
 *  blank-line separators. Content before and after the block is preserved. */
export function removePreambleBlock(content: string): string {
  const startIdx = content.indexOf(PREAMBLE_START);
  if (startIdx === -1) return content;
  const endIdx = content.indexOf(PREAMBLE_END, startIdx);
  if (endIdx === -1) {
    // END marker missing — preamble was not properly closed (likely a truncated write).
    // Drop everything from the start marker to EOF; returning unchanged would commit
    // the injected instructions into branch history.
    console.warn('[preamble] removePreambleBlock: missing END marker, dropping to EOF');
    return content.slice(0, startIdx).replace(/\n\n$/, '');
  }
  const blockEnd = endIdx + PREAMBLE_END.length;
  const before = content.slice(0, startIdx).replace(/\n\n$/, '');
  const after = content.slice(blockEnd).replace(/^\n\n/, '');
  if (!before && !after) return '';
  if (!before) return after.replace(/^\n/, '');
  if (!after) return before;
  return `${before}\n\n${after}`;
}

export function normalizePreambleFileContent(
  filename: string,
  content: string,
  removePreamble: (value: string) => string = removePreambleBlock,
): string | null {
  if (filename !== '.claude/settings.local.json') return removePreamble(content);
  try {
    const settings = JSON.parse(content) as Record<string, unknown>;
    if (typeof settings.systemPrompt === 'string') {
      const stripped = removePreamble(settings.systemPrompt);
      if (stripped.trim()) settings.systemPrompt = stripped;
      else delete settings.systemPrompt;
    }
    return Object.keys(settings).length === 0 ? '' : JSON.stringify(settings, null, 2);
  } catch {
    return null;
  }
}

/** Return the set of filenames (relative to worktreePath) that contain a preamble block. */
export async function detectPreambleFiles(worktreePath: string): Promise<Set<string>> {
  const result = new Set<string>();
  await Promise.all(
    PREAMBLE_MD_FILES.map(async (filename) => {
      try {
        const content = await fsReadFile(join(worktreePath, filename), 'utf8');
        if (content.includes(PREAMBLE_START)) result.add(filename);
      } catch {
        /* file absent or unreadable */
      }
    }),
  );
  const settingsRelPath = '.claude/settings.local.json';
  try {
    const raw = await fsReadFile(join(worktreePath, settingsRelPath), 'utf8');
    const s = JSON.parse(raw) as Record<string, unknown>;
    if (typeof s.systemPrompt === 'string' && s.systemPrompt.includes(PREAMBLE_START)) {
      result.add(settingsRelPath);
    }
  } catch {
    /* file absent, unreadable, or malformed */
  }
  return result;
}

/** Split diff on unified-diff section boundaries and drop sections whose
 *  file path is in `excludeFiles`. */
export function filterDiffSections(diff: string, excludeFiles: Set<string>): string {
  const sections = diff.split(/(?=^diff --git )/m);
  return sections
    .filter((section) => {
      const match = /^diff --git a\/(.+?) b\//.exec(section);
      return !match || !excludeFiles.has(match[1]);
    })
    .join('');
}

/** Generate a git diff section showing only non-preamble changes to a preamble-bearing file.
 *  Returns empty string if the file has no real changes beyond the injected block. */
export async function buildNormalizedPreambleFileDiff(
  filename: string,
  worktreePath: string,
  baseSha: string,
  removePreamble: (content: string) => string = removePreambleBlock,
): Promise<string> {
  const filePath = join(worktreePath, filename);
  if (!existsSync(filePath)) return '';
  let worktreeContent: string;
  try {
    worktreeContent = readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }

  const normalizedContent = normalizePreambleFileContent(filename, worktreeContent, removePreamble);
  if (normalizedContent === null) return '';

  let baseContent = '';
  try {
    const result = await execAsync('git', ['show', `${baseSha}:${filename}`], {
      cwd: worktreePath,
    });
    const stdout = typeof result === 'string' ? result : result.stdout;
    baseContent = typeof stdout === 'string' ? stdout : '';
  } catch {
    baseContent = '';
  }

  const normalizedBaseContent = normalizePreambleFileContent(filename, baseContent, removePreamble);
  if (normalizedBaseContent === null || normalizedContent === normalizedBaseContent) return '';

  const id = randomUUID();
  const tmpBase = join(os.tmpdir(), `parallel-code-base-${id}`);
  const tmpNorm = join(os.tmpdir(), `parallel-code-norm-${id}`);
  try {
    writeFileSync(tmpBase, normalizedBaseContent);
    writeFileSync(tmpNorm, normalizedContent);
    let diffOut = '';
    try {
      const { stdout } = await execAsync('git', ['diff', '--no-index', '-U3', tmpBase, tmpNorm]);
      diffOut = stdout;
    } catch (e: unknown) {
      const err = e as { stdout?: string; code?: number };
      if (err.code === 1 && typeof err.stdout === 'string') diffOut = err.stdout;
    }
    if (!diffOut) return '';
    // Replace tmp paths only in diff header lines to avoid false substitutions
    // if the tmpdir path happened to appear in the file content itself.
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const basePath = tmpBase.replace(/^\//, '');
    const normPath = tmpNorm.replace(/^\//, '');
    return diffOut
      .replace(new RegExp(`^(diff --git a/)${esc(basePath)}`, 'mg'), `$1${filename}`)
      .replace(new RegExp(`^(diff --git [^ ]+ b/)${esc(normPath)}`, 'mg'), `$1${filename}`)
      .replace(new RegExp(`^(--- a/)${esc(basePath)}`, 'mg'), `$1${filename}`)
      .replace(new RegExp(`^(\\+\\+\\+ b/)${esc(normPath)}`, 'mg'), `$1${filename}`);
  } finally {
    try {
      unlinkSync(tmpBase);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(tmpNorm);
    } catch {
      /* ignore */
    }
  }
}

export interface StripPreambleTask {
  worktreePath: string;
  preambleFileExistedBefore?: boolean;
}

/** Remove preamble injections from all preamble-bearing files in the worktree. */
export async function stripPreambleFromBranch(task: StripPreambleTask): Promise<void> {
  await Promise.all(
    PREAMBLE_MD_FILES.map(async (filename) => {
      const filePath = join(task.worktreePath, filename);
      let content: string;
      try {
        content = await fsReadFile(filePath, 'utf8');
      } catch {
        return;
      }
      if (!content.includes(PREAMBLE_START)) return;
      const stripped = removePreambleBlock(content);
      if (stripped.trim() || task.preambleFileExistedBefore) {
        await atomicWriteFile(filePath, stripped);
      } else {
        await fsUnlink(filePath);
      }
    }),
  );

  const settingsPath = join(task.worktreePath, '.claude', 'settings.local.json');
  try {
    const settings = JSON.parse(await fsReadFile(settingsPath, 'utf8')) as Record<string, unknown>;
    if (
      typeof settings.systemPrompt === 'string' &&
      settings.systemPrompt.includes(PREAMBLE_START)
    ) {
      const stripped = removePreambleBlock(settings.systemPrompt);
      if (stripped.trim()) {
        settings.systemPrompt = stripped;
      } else {
        delete settings.systemPrompt;
      }
      if (Object.keys(settings).length === 0) {
        await fsUnlink(settingsPath);
      } else {
        await atomicWriteFile(settingsPath, JSON.stringify(settings, null, 2));
      }
    }
  } catch {
    /* file absent, unreadable, or malformed */
  }
}
