import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { parseEnvFile, expandHome, loadEnvFile } from './env-file.js';

describe('parseEnvFile', () => {
  it('parses plain KEY=VALUE lines', () => {
    expect(parseEnvFile('ANTHROPIC_API_KEY=sk-ant-abc123')).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-abc123',
    });
  });

  it('ignores blank lines and comments', () => {
    const content = ['# credentials', '', 'CODEX_API_KEY=sk-1', '  # trailing note'].join('\n');
    expect(parseEnvFile(content)).toEqual({ CODEX_API_KEY: 'sk-1' });
  });

  it('strips an export prefix', () => {
    expect(parseEnvFile('export ANTHROPIC_API_KEY=sk-2')).toEqual({ ANTHROPIC_API_KEY: 'sk-2' });
  });

  it('expands \\n inside double quotes so multi-header values survive', () => {
    // ANTHROPIC_CUSTOM_HEADERS is newline-separated `Name: Value` pairs.
    const parsed = parseEnvFile('ANTHROPIC_CUSTOM_HEADERS="x-api-key: abc\\nx-tenant: acme"');
    expect(parsed.ANTHROPIC_CUSTOM_HEADERS).toBe('x-api-key: abc\nx-tenant: acme');
  });

  it('keeps a quoted value that really spans lines intact', () => {
    // The regression that motivated using Node's parser: a line-at-a-time
    // parser truncates this to `"x-api-key: abc` — quote included.
    const parsed = parseEnvFile('ANTHROPIC_CUSTOM_HEADERS="x-api-key: abc\nx-tenant: acme"\nB=2');
    expect(parsed.ANTHROPIC_CUSTOM_HEADERS).toBe('x-api-key: abc\nx-tenant: acme');
    expect(parsed.B).toBe('2');
  });

  it('keeps colons, spaces and equals signs in unquoted values', () => {
    expect(parseEnvFile('ANTHROPIC_CUSTOM_HEADERS=x-api-key: a=b:c')).toEqual({
      ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: a=b:c',
    });
  });

  it('preserves # inside a quoted value', () => {
    // Unquoted, `#` starts a comment (standard .env semantics), so credentials
    // containing one must be quoted — the settings help text says so.
    expect(parseEnvFile('ANTHROPIC_API_KEY="sk-ant#not-a-comment"')).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant#not-a-comment',
    });
  });

  it('skips lines whose key is not a usable shell identifier', () => {
    const content = ['no-equals-here', '1BAD_KEY=x', 'GOOD=1'].join('\n');
    expect(parseEnvFile(content)).toEqual({ GOOD: '1' });
  });

  it('ignores a UTF-8 BOM rather than folding it into the first key', () => {
    expect(parseEnvFile('﻿ANTHROPIC_API_KEY=sk-1')).toEqual({ ANTHROPIC_API_KEY: 'sk-1' });
  });

  it('handles CRLF line endings', () => {
    expect(parseEnvFile('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });

  it('allows empty values', () => {
    expect(parseEnvFile('EMPTY=')).toEqual({ EMPTY: '' });
  });

  it('lets a later line win over an earlier duplicate', () => {
    expect(parseEnvFile('K=first\nK=second')).toEqual({ K: 'second' });
  });
});

describe('expandHome', () => {
  it('expands a leading ~/', () => {
    expect(expandHome('~/creds.env')).toBe(path.join(os.homedir(), 'creds.env'));
  });

  it('leaves absolute paths untouched', () => {
    expect(expandHome('/etc/creds.env')).toBe('/etc/creds.env');
  });

  it('does not expand ~ inside a path', () => {
    expect(expandHome('/opt/~/creds.env')).toBe('/opt/~/creds.env');
  });
});

describe('loadEnvFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-file-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads and parses a file', () => {
    const file = path.join(dir, 'agent.env');
    fs.writeFileSync(file, 'ANTHROPIC_API_KEY=sk-ant-xyz\n');
    expect(loadEnvFile(file)).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-xyz' });
  });

  it('throws a descriptive error when the file is missing', () => {
    expect(() => loadEnvFile(path.join(dir, 'nope.env'))).toThrow(/Env file not found/);
  });

  it('throws when the path is a directory', () => {
    expect(() => loadEnvFile(dir)).toThrow(/directory, not a file/);
  });

  it('refuses a FIFO instead of blocking the main process forever', () => {
    const fifo = path.join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect(() => loadEnvFile(fifo)).toThrow(/not a regular file/);
  });

  it('refuses an oversized file', () => {
    const big = path.join(dir, 'big.env');
    fs.writeFileSync(big, `K=${'x'.repeat(300 * 1024)}`);
    expect(() => loadEnvFile(big)).toThrow(/too large/);
  });

  it('rejects relative paths', () => {
    expect(() => loadEnvFile('creds.env')).toThrow(/must be absolute/);
  });
});
