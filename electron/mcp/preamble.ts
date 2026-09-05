import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  unlink as fsUnlink,
  access as fsAccess,
  mkdir as fsMkdir,
} from 'fs/promises';
import { atomicWriteFile } from './atomic.js';
import { join } from 'path';
import os from 'os';

const execAsync = promisify(execFile);

const PREAMBLE_START = '<sub-task-mode>';
const PREAMBLE_END = '</sub-task-mode>';

const PREAMBLE_MD_FILES = ['AGENTS.md', 'GEMINI.md', '.agent.md'] as const;

export const SUB_TASK_MODE_PREAMBLE = `<sub-task-mode>
These rules override all skills and hooks:
- When your work is complete, commit your changes and call the \`land_self\` MCP tool with the verification checks you ran. A successful \`land_self\` call is the finish line — do NOT call \`signal_done\` afterward, use finishing-a-development-branch, or offer merge/PR options.
- Use \`signal_done\` only if the coordinator explicitly asks for manual review instead of self-landing.
- Asking questions is fine when requirements are unclear or an action is risky.
</sub-task-mode>`;

export type PreambleWriteQueue = Map<string, Promise<void>>;

export interface InjectedSubTaskPreamble {
  filePath?: string;
  originalContent: string | null;
  existedBefore: boolean;
  restoreOnFailure: boolean;
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

async function injectMarkdownPreamble(
  queue: PreambleWriteQueue,
  filePath: string,
): Promise<InjectedSubTaskPreamble> {
  let originalContent: string | null = null;
  await queueFileMutation(queue, filePath, async () => {
    try {
      await fsAccess(filePath);
      originalContent = await fsReadFile(filePath, 'utf8');
    } catch {
      originalContent = null;
    }
    await atomicWriteFile(
      filePath,
      originalContent ? `${originalContent}\n\n${SUB_TASK_MODE_PREAMBLE}` : SUB_TASK_MODE_PREAMBLE,
    );
  });
  return {
    filePath,
    originalContent,
    existedBefore: originalContent !== null,
    restoreOnFailure: true,
  };
}

export async function injectSubTaskPreamble(args: {
  worktreePath: string;
  agentCommand: string;
  queue: PreambleWriteQueue;
}): Promise<InjectedSubTaskPreamble> {
  const agentCmd = args.agentCommand.toLowerCase();
  if (agentCmd.includes('codex') || agentCmd.includes('opencode') || agentCmd.includes('kimi')) {
    return injectMarkdownPreamble(args.queue, join(args.worktreePath, 'AGENTS.md'));
  }
  if (agentCmd.includes('gemini')) {
    return injectMarkdownPreamble(args.queue, join(args.worktreePath, 'GEMINI.md'));
  }
  if (agentCmd.includes('copilot')) {
    return injectMarkdownPreamble(args.queue, join(args.worktreePath, '.agent.md'));
  }

  const settingsDir = join(args.worktreePath, '.claude');
  const settingsPath = join(settingsDir, 'settings.local.json');
  await fsMkdir(settingsDir, { recursive: true });
  let originalContent: string | null = null;
  await queueFileMutation(args.queue, settingsPath, async () => {
    let existingSettings: Record<string, unknown> = {};
    try {
      originalContent = await fsReadFile(settingsPath, 'utf8');
      existingSettings = JSON.parse(originalContent) as Record<string, unknown>;
    } catch {
      existingSettings = {};
    }
    existingSettings.systemPrompt = existingSettings.systemPrompt
      ? `${existingSettings.systemPrompt}\n\n${SUB_TASK_MODE_PREAMBLE}`
      : SUB_TASK_MODE_PREAMBLE;
    await atomicWriteFile(settingsPath, JSON.stringify(existingSettings, null, 2));
  });
  return {
    filePath: settingsPath,
    originalContent,
    existedBefore: originalContent !== null,
    restoreOnFailure: false,
  };
}

export async function restoreSubTaskPreambleInjection(
  injection: InjectedSubTaskPreamble | undefined,
): Promise<void> {
  if (!injection?.filePath || !injection.restoreOnFailure) return;
  try {
    if (injection.originalContent !== null) {
      await fsWriteFile(injection.filePath, injection.originalContent);
    } else {
      await fsUnlink(injection.filePath);
    }
  } catch {
    /* ignore — worktree cleanup follows */
  }
}

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
