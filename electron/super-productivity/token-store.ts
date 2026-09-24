/**
 * The Super Productivity access token lives in its own 0600 file in the user
 * data dir, never in state.json: the renderer loads and saves that file, and
 * the token must stay in the main process.
 */
import fs from 'fs';
import path from 'path';
import { atomicWriteFileSync } from '../mcp/atomic.js';

const TOKEN_FILE = 'super-productivity-token';
/** Super Productivity issues 32 alphanumerics; accept any sane length of the same alphabet. */
const TOKEN_PATTERN = /^[A-Za-z0-9]{16,256}$/;

export function isValidSpToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function tokenPath(userDataDir: string): string {
  return path.join(userDataDir, TOKEN_FILE);
}

export function readSpToken(userDataDir: string): string | null {
  try {
    const token = fs.readFileSync(tokenPath(userDataDir), 'utf8').trim();
    return isValidSpToken(token) ? token : null;
  } catch {
    return null;
  }
}

export function writeSpToken(userDataDir: string, token: string): void {
  if (!isValidSpToken(token)) throw new Error('Invalid Super Productivity token');
  atomicWriteFileSync(tokenPath(userDataDir), token, { mode: 0o600 });
}

export function clearSpToken(userDataDir: string): void {
  try {
    fs.unlinkSync(tokenPath(userDataDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
