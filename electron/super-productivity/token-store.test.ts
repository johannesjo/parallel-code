import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearSpToken, isValidSpToken, readSpToken, writeSpToken } from './token-store.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sp-token-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Super Productivity token store', () => {
  it('writes the token readable by the owner only and reads it back', () => {
    const dir = tempDir();
    writeSpToken(dir, TOKEN);
    const file = join(dir, 'super-productivity-token');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(TOKEN);
    expect(readSpToken(dir)).toBe(TOKEN);
  });

  it('rejects malformed tokens on write and ignores them on read', () => {
    const dir = tempDir();
    expect(() => writeSpToken(dir, 'short')).toThrow();
    expect(() => writeSpToken(dir, `${TOKEN}\n`)).toThrow();
    writeFileSync(join(dir, 'super-productivity-token'), 'not a token!');
    expect(readSpToken(dir)).toBeNull();
    expect(isValidSpToken(TOKEN)).toBe(true);
  });

  it('clears the token, and clearing twice is fine', () => {
    const dir = tempDir();
    writeSpToken(dir, TOKEN);
    clearSpToken(dir);
    clearSpToken(dir);
    expect(readSpToken(dir)).toBeNull();
  });
});
