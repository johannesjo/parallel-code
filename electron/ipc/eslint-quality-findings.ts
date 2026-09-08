import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { EslintQualityFinding, EslintQualityResult } from './shared-types.js';

type EslintExec = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const exec: EslintExec = async (file, args, options) => {
  const result = await promisify(execFile)(file, args, options);
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr),
  };
};
const ESLINT_TIMEOUT_MS = 30_000;
const ESLINT_MAX_BUFFER = 8 * 1024 * 1024;
const ESLINT_BINARY_SEARCH_DEPTH = 3;
const LINTABLE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const ESLINT_CONFIG_NAMES = [
  'eslint.config.js',
  'eslint.config.cjs',
  'eslint.config.mjs',
  'eslint.config.ts',
  'eslint.config.cts',
  'eslint.config.mts',
] as const;

interface EslintMessage {
  ruleId?: unknown;
  severity?: unknown;
  message?: unknown;
  line?: unknown;
  column?: unknown;
  endLine?: unknown;
  endColumn?: unknown;
}

interface EslintFileResult {
  filePath?: unknown;
  messages?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function parseJson(stdout: string): unknown[] {
  if (!stdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('ESLint returned malformed JSON output.');
  }
  if (!Array.isArray(parsed)) throw new Error('ESLint returned an unexpected JSON shape.');
  return parsed;
}

function parseFilePath(rawPath: unknown, worktreePath: string): string | undefined {
  const filePath = nonEmptyString(rawPath);
  if (!filePath) return undefined;
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(worktreePath, filePath);
  const relativePath = path.relative(worktreePath, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined;
  }
  return normalizePath(relativePath);
}

function parseMessage(filePath: string, rawMessage: unknown): EslintQualityFinding | undefined {
  const message = record(rawMessage) as EslintMessage | null;
  const ruleId = nonEmptyString(message?.ruleId);
  const explanation = nonEmptyString(message?.message);
  const startLine = positiveInteger(message?.line);
  const severity =
    message?.severity === 2 ? 'error' : message?.severity === 1 ? 'warning' : undefined;

  // ESLint parse errors have no ruleId. The issue mapping intentionally leaves
  // those out because they do not identify a stable rule-backed finding.
  if (!ruleId || !explanation || !startLine || !severity) return undefined;

  const startColumn = positiveInteger(message?.column);
  const endLine = positiveInteger(message?.endLine);
  const endColumn = positiveInteger(message?.endColumn);
  return {
    id: `eslint:${filePath}:${startLine}:${startColumn ?? 0}:${ruleId}`,
    source: 'eslint',
    ruleId,
    category: 'maintainability',
    severity,
    location: {
      filePath,
      startLine,
      ...(startColumn ? { startColumn } : {}),
      ...(endLine ? { endLine } : {}),
      ...(endColumn ? { endColumn } : {}),
    },
    explanation,
  };
}

export function isLintablePath(filePath: string): boolean {
  return LINTABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function parseEslintFindings(
  stdout: string,
  worktreePath: string,
  changedPaths: readonly string[],
): EslintQualityFinding[] {
  const changed = new Set(
    changedPaths.filter(isLintablePath).map((filePath) => normalizePath(filePath)),
  );
  const findings: EslintQualityFinding[] = [];
  for (const rawFile of parseJson(stdout)) {
    const file = record(rawFile) as EslintFileResult | null;
    const filePath = parseFilePath(file?.filePath, worktreePath);
    if (!filePath || !changed.has(filePath) || !Array.isArray(file?.messages)) continue;
    for (const rawMessage of file.messages) {
      const finding = parseMessage(filePath, rawMessage);
      if (finding) findings.push(finding);
    }
  }
  return findings;
}

function hasEslintConfig(worktreePath: string): boolean {
  if (ESLINT_CONFIG_NAMES.some((name) => fs.existsSync(path.join(worktreePath, name)))) {
    return true;
  }
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(worktreePath, 'package.json'), 'utf8'),
    ) as {
      eslintConfig?: unknown;
    };
    return record(packageJson.eslintConfig) !== null;
  } catch {
    return false;
  }
}

function findLocalEslintBinary(worktreePath: string): string | undefined {
  let currentPath = path.resolve(worktreePath);
  for (let depth = 0; depth <= ESLINT_BINARY_SEARCH_DEPTH; depth += 1) {
    const binaryNames =
      process.platform === 'win32' ? ['eslint.cmd', 'eslint.exe', 'eslint'] : ['eslint'];
    for (const binaryName of binaryNames) {
      const binaryPath = path.join(currentPath, 'node_modules', '.bin', binaryName);
      if (fs.existsSync(binaryPath)) return binaryPath;
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) break;
    currentPath = parentPath;
  }
  return undefined;
}

function errorText(error: unknown): string {
  const value = record(error);
  return [value?.message, value?.stderr, value?.stdout]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
}

function unavailable(message: string): EslintQualityResult {
  return { status: 'unavailable', message };
}

export function classifyEslintError(error: unknown): EslintQualityResult {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const text = errorText(error);
  if (
    code === 'ENOENT' ||
    /eslint.*not found|could not determine executable|no such file|couldn't find an eslint\.config\./i.test(
      text,
    )
  ) {
    return { status: 'not-applicable' };
  }
  if (/configuration.*invalid|failed to load config|cannot find module/i.test(text)) {
    return unavailable('ESLint could not load this project configuration.');
  }
  return unavailable(
    'ESLint findings could not be loaded. Try again after checking the project lint command.',
  );
}

export async function loadEslintQualityFindings(
  worktreePath: string,
  changedPaths: readonly string[],
  execImpl: EslintExec = exec,
): Promise<EslintQualityResult> {
  if (!hasEslintConfig(worktreePath)) return { status: 'not-applicable' };
  const lintablePaths = changedPaths.filter(isLintablePath);
  if (lintablePaths.length === 0) return { status: 'available', findings: [] };
  const eslintBinary = findLocalEslintBinary(worktreePath);
  if (!eslintBinary) return { status: 'not-applicable' };

  try {
    const { stdout } = await execImpl(
      eslintBinary,
      ['--format', 'json', '--no-error-on-unmatched-pattern', '--', ...lintablePaths],
      { cwd: worktreePath, timeout: ESLINT_TIMEOUT_MS, maxBuffer: ESLINT_MAX_BUFFER },
    );
    return {
      status: 'available',
      findings: parseEslintFindings(stdout, worktreePath, lintablePaths),
    };
  } catch (error) {
    const stdout = (error as { stdout?: unknown })?.stdout;
    if (typeof stdout === 'string' && stdout.trim()) {
      try {
        return {
          status: 'available',
          findings: parseEslintFindings(stdout, worktreePath, lintablePaths),
        };
      } catch (parseError) {
        return unavailable(
          parseError instanceof Error ? parseError.message : 'ESLint output could not be parsed.',
        );
      }
    }
    return classifyEslintError(error);
  }
}
