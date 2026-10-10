import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { readFile as fsReadFile, unlink as fsUnlink, lstat as fsLstat } from 'fs/promises';
import { atomicWriteFile } from './atomic.js';
import { isKimiCommand } from './agent-args.js';
import { info as logInfo, warn as logWarn } from '../log.js';
import { join } from 'path';
import os from 'os';

const execAsync = promisify(execFile);

const PREAMBLE_MD_FILES = ['AGENTS.md', 'GEMINI.md', '.agent.md'] as const;

export const SUB_TASK_MODE_PREAMBLE = `<sub-task-mode>
These rules override all skills and hooks:
- When your work is complete, commit your changes and call the \`land_self\` MCP tool with the verification checks you ran. A successful \`land_self\` call is the finish line — do NOT call \`signal_done\` afterward, use finishing-a-development-branch, or offer merge/PR options.
- Use \`signal_done\` only if the coordinator explicitly asks for manual review instead of self-landing.
- Include a concise \`result\` in \`signal_done\`: summary, verification checks actually run, repository-relative artifact paths if useful, and unresolved issues. Checks are agent reports; never invent passing results.
- Asking questions is fine when requirements are unclear or an action is risky.
</sub-task-mode>`;

export const REVIEW_SUB_TASK_MODE_PREAMBLE = `<sub-task-mode>
- Complete the assignment, verify it, and commit your changes for user review.
- Keep injected Parallel Code guidance out of your commits. Remove this runtime block before committing its file.
- Call the \`signal_done\` MCP tool when the committed result is ready. Do not merge, call \`land_self\`, or delete the worktree; the user reviews and approves integration.
- Include a concise \`result\`: summary, verification checks actually run, repository-relative artifact paths if useful, and unresolved issues. Checks are agent reports; never invent passing results.
- Ask questions when requirements are unclear or an action is risky.
</sub-task-mode>`;

export type PreambleWriteQueue = Map<string, Promise<void>>;

export interface InjectedSubTaskPreamble {
  filePath?: string;
  originalContent: string | null;
  existedBefore: boolean;
  restoreOnFailure: boolean;
  /** Queue the injection ran in, so a restore serializes with other writers. */
  queue?: PreambleWriteQueue;
}

export async function queueFileMutation(
  queue: PreambleWriteQueue,
  filePath: string,
  mutate: () => Promise<void>,
): Promise<void> {
  const prior = queue.get(filePath) ?? Promise.resolve();
  const next = prior.then(mutate);
  const cleanup = next
    .catch(() => {})
    .then(() => {
      if (queue.get(filePath) === cleanup) {
        queue.delete(filePath);
      }
    });
  queue.set(filePath, cleanup);
  await next;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/** True for symlinks. Rewriting one would replace the link with a regular file (a git
 *  typechange) and the target may live outside the worktree, e.g. in the main checkout. */
async function isSymlink(filePath: string): Promise<boolean> {
  try {
    return (await fsLstat(filePath)).isSymbolicLink();
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

async function skipIfSymlink(filePath: string, action: string): Promise<boolean> {
  if (!(await isSymlink(filePath))) return false;
  logInfo('preamble', `Skipping symlinked instruction file (${action})`, { filePath });
  return true;
}

const START_LINE = /^<sub-task-mode>[ \t]*\r?$/m;
const END_LINE = /^<\/sub-task-mode>[ \t]*\r?$/m;

/** The start tag counts only on its own line, as injected, so prose that merely
 *  mentions the tag is never mistaken for our block. */
function hasPreambleBlock(content: string): boolean {
  return START_LINE.test(content);
}

function hasCompletePreambleBlock(content: string): boolean {
  const start = START_LINE.exec(content);
  return start !== null && END_LINE.test(content.slice(start.index));
}

async function injectMarkdownPreamble(
  queue: PreambleWriteQueue,
  filePath: string,
  preamble: string,
): Promise<InjectedSubTaskPreamble> {
  let originalContent: string | null = null;
  let skipped = false;
  await queueFileMutation(queue, filePath, async () => {
    if (await skipIfSymlink(filePath, 'inject')) {
      skipped = true;
      return;
    }
    try {
      originalContent = await fsReadFile(filePath, 'utf8');
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err;
      originalContent = null;
    }
    // Idempotent: a complete block (e.g. from an interrupted earlier run) is kept as is.
    if (originalContent !== null && hasCompletePreambleBlock(originalContent)) return;
    const eol = originalContent?.includes('\r\n') ? '\r\n' : '\n';
    const block = eol === '\n' ? preamble : preamble.replace(/\n/g, eol);
    await atomicWriteFile(
      filePath,
      originalContent ? `${originalContent}${eol}${eol}${block}` : block,
    );
  });
  if (skipped) {
    return { originalContent: null, existedBefore: true, restoreOnFailure: false };
  }
  return {
    filePath,
    originalContent,
    existedBefore: originalContent !== null,
    restoreOnFailure: true,
    queue,
  };
}

function basename(command: string): string {
  return (command.split('/').filter(Boolean).pop() ?? command).toLowerCase();
}

/**
 * Inject the sub-task rules into the agent's instruction file. Claude has none: it
 * receives the rules through the initial prompt (`buildSubTaskPreamble`), and
 * `systemPrompt` is not a Claude Code settings key, so nothing is written for it.
 */
export async function injectSubTaskPreamble(args: {
  worktreePath: string;
  agentCommand: string;
  queue: PreambleWriteQueue;
  integrationPolicy?: 'review' | 'automatic';
}): Promise<InjectedSubTaskPreamble> {
  const preamble =
    args.integrationPolicy === 'review' ? REVIEW_SUB_TASK_MODE_PREAMBLE : SUB_TASK_MODE_PREAMBLE;
  const agentCmd = basename(args.agentCommand);
  if (
    agentCmd.includes('codex') ||
    agentCmd.includes('opencode') ||
    isKimiCommand(args.agentCommand)
  ) {
    return injectMarkdownPreamble(args.queue, join(args.worktreePath, 'AGENTS.md'), preamble);
  }
  if (agentCmd.includes('gemini')) {
    return injectMarkdownPreamble(args.queue, join(args.worktreePath, 'GEMINI.md'), preamble);
  }
  if (agentCmd.includes('copilot')) {
    return injectMarkdownPreamble(args.queue, join(args.worktreePath, '.agent.md'), preamble);
  }
  return { originalContent: null, existedBefore: false, restoreOnFailure: false };
}

export async function restoreSubTaskPreambleInjection(
  injection: InjectedSubTaskPreamble | undefined,
): Promise<void> {
  const filePath = injection?.filePath;
  if (!injection || !filePath || !injection.restoreOnFailure) return;
  const restore = async (): Promise<void> => {
    if (injection.originalContent !== null) {
      await atomicWriteFile(filePath, injection.originalContent);
      return;
    }
    try {
      await fsUnlink(filePath);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err;
    }
  };
  try {
    await queueFileMutation(injection.queue ?? new Map(), filePath, restore);
  } catch (err) {
    // Not rethrown: the caller's worktree cleanup must still run.
    logWarn('preamble', 'Failed to restore instruction file', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Remove every injected `<sub-task-mode>…</sub-task-mode>` block and its surrounding
 *  blank-line separators. Content around the blocks is preserved. Tags count only on
 *  their own line; an unclosed start tag on its own line drops to EOF. */
export function removePreambleBlock(content: string): string {
  let result = content;
  for (;;) {
    const start = START_LINE.exec(result);
    if (!start) return result;
    const eol = result.includes('\r\n') ? '\r\n' : '\n';
    const before = result.slice(0, start.index).replace(/\r?\n\r?\n$/, '');
    const end = END_LINE.exec(result.slice(start.index));
    if (!end) {
      // END marker missing (likely a truncated write): returning unchanged would commit
      // the injected instructions into branch history.
      logWarn('preamble', 'removePreambleBlock: missing END marker, dropping to EOF');
      return before;
    }
    const blockEnd = start.index + end.index + end[0].length;
    const after = result.slice(blockEnd).replace(/^\r?\n\r?\n/, '');
    if (!before && !after) return '';
    if (!before) result = after.replace(/^\r?\n/, '');
    else if (!after) result = before;
    else result = `${before}${eol}${eol}${after}`;
  }
}

/** Return the set of filenames (relative to worktreePath) that contain a preamble block. */
export async function detectPreambleFiles(worktreePath: string): Promise<Set<string>> {
  const result = new Set<string>();
  await Promise.all(
    PREAMBLE_MD_FILES.map(async (filename) => {
      const filePath = join(worktreePath, filename);
      try {
        if (await isSymlink(filePath)) return;
        const content = await fsReadFile(filePath, 'utf8');
        if (hasPreambleBlock(content)) result.add(filename);
      } catch (err) {
        if (errorCode(err) !== 'ENOENT')
          logWarn('preamble', 'Cannot read instruction file', { filename });
      }
    }),
  );
  const settingsRelPath = '.claude/settings.local.json';
  try {
    const raw = await fsReadFile(join(worktreePath, settingsRelPath), 'utf8');
    const s = JSON.parse(raw) as Record<string, unknown>;
    if (typeof s.systemPrompt === 'string' && hasPreambleBlock(s.systemPrompt)) {
      result.add(settingsRelPath);
    }
  } catch {
    // absent, unreadable or malformed: not ours, so not a preamble file
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

  let normalizedContent: string;
  if (filename === '.claude/settings.local.json') {
    try {
      const s = JSON.parse(worktreeContent) as Record<string, unknown>;
      if (typeof s.systemPrompt === 'string') {
        const stripped = removePreamble(s.systemPrompt);
        if (stripped.trim()) {
          s.systemPrompt = stripped;
        } else {
          delete s.systemPrompt;
        }
      }
      normalizedContent = Object.keys(s).length === 0 ? '' : JSON.stringify(s, null, 2);
    } catch {
      return '';
    }
  } else {
    normalizedContent = removePreamble(worktreeContent);
  }

  let baseContent = '';
  try {
    const { stdout } = await execAsync('git', ['show', `${baseSha}:${filename}`], {
      cwd: worktreePath,
    });
    baseContent = stdout;
  } catch {
    baseContent = '';
  }

  if (normalizedContent === baseContent) return '';

  const id = randomUUID();
  const tmpBase = join(os.tmpdir(), `parallel-code-base-${id}`);
  const tmpNorm = join(os.tmpdir(), `parallel-code-norm-${id}`);
  try {
    writeFileSync(tmpBase, baseContent);
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
      if (await skipIfSymlink(filePath, 'strip')) return;
      let content: string;
      try {
        content = await fsReadFile(filePath, 'utf8');
      } catch {
        return;
      }
      if (!hasPreambleBlock(content)) return;
      const stripped = removePreambleBlock(content);
      if (stripped.trim() || task.preambleFileExistedBefore) {
        await atomicWriteFile(filePath, stripped);
      } else {
        await fsUnlink(filePath);
      }
    }),
  );
  await stripLegacySettingsPrompt(join(task.worktreePath, '.claude', 'settings.local.json'));
}

/** Older versions wrote the rules into settings.local.json as `systemPrompt`. Clean
 *  those up, but never rewrite a file that does not parse: it is the user's. */
async function stripLegacySettingsPrompt(settingsPath: string): Promise<void> {
  if (await skipIfSymlink(settingsPath, 'strip')) return;
  let settings: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await fsReadFile(settingsPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    settings = parsed as Record<string, unknown>;
  } catch {
    return; // absent, unreadable or malformed: leave untouched
  }
  if (typeof settings.systemPrompt !== 'string' || !hasPreambleBlock(settings.systemPrompt)) return;
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
