import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseEnv } from 'util';

/**
 * Agent env files let users supply credentials (ANTHROPIC_API_KEY, CODEX_API_KEY,
 * ANTHROPIC_CUSTOM_HEADERS, …) that are not exported from their login shell, so the
 * app never has to store secrets in its own settings JSON. The file is re-read on
 * every spawn — editing it takes effect on the next terminal, with no app restart.
 */

const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Refuse to read anything larger than this — an env file holds a handful of
 *  credentials, so a big file means the path is wrong, and parsing it would
 *  stall the main process. */
const MAX_ENV_FILE_BYTES = 256 * 1024;

/**
 * Parses `KEY=VALUE` lines using Node's own `.env` parser — the one behind
 * `node --env-file` — so the syntax matches what users already expect from
 * dotenv: `export ` prefixes, `#` comments, quoted values, and values that span
 * lines. That last case is why we don't hand-roll this: `ANTHROPIC_CUSTOM_HEADERS`
 * holds newline-separated `Name: Value` pairs, and a line-at-a-time parser
 * silently truncates it to the first header.
 *
 * Keys that aren't valid shell identifiers are dropped — `parseEnv` keeps them,
 * but they cannot be passed to a child process.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  // Strip a UTF-8 BOM; parseEnv would otherwise fold it into the first key.
  for (const [key, value] of Object.entries(parseEnv(content.replace(/^\uFEFF/, '')))) {
    if (value !== undefined && VALID_KEY.test(key)) env[key] = value;
  }
  return env;
}

/** Expands a leading `~` to the user's home directory. */
export function expandHome(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

/**
 * Reads and parses an agent env file. Throws a descriptive error when the file is
 * missing or unreadable — a silent fallback would spawn the agent without its
 * credentials, which is the exact failure this feature exists to prevent.
 */
export function loadEnvFile(filePath: string): Record<string, string> {
  const resolved = expandHome(filePath.trim());
  if (!path.isAbsolute(resolved)) {
    throw new Error(`Env file path must be absolute or start with "~": ${filePath}`);
  }

  // stat before reading: this runs on the main thread inside the SpawnAgent
  // handler, and readFileSync on a FIFO or character device never returns —
  // that would freeze every terminal and every IPC channel with no recovery.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`Env file not found: ${resolved}`);
    if (code === 'EACCES') {
      throw new Error(`Env file is not readable (permission denied): ${resolved}`);
    }
    throw new Error(`Could not read env file ${resolved}: ${String(err)}`);
  }

  if (stat.isDirectory()) {
    throw new Error(`Env file path is a directory, not a file: ${resolved}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Env file path is not a regular file: ${resolved}`);
  }
  if (stat.size > MAX_ENV_FILE_BYTES) {
    throw new Error(`Env file is too large (${stat.size} bytes, max ${MAX_ENV_FILE_BYTES})`);
  }

  let content: string;
  try {
    content = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES') {
      throw new Error(`Env file is not readable (permission denied): ${resolved}`);
    }
    throw new Error(`Could not read env file ${resolved}: ${String(err)}`);
  }

  return parseEnvFile(content);
}
