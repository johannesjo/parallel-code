import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAntigravityMcpConfig } from './antigravity-config.js';
import type { ParallelCodeMcpConfig } from './agent-args.js';

const config: ParallelCodeMcpConfig = {
  mcpServers: {
    'parallel-code': {
      command: 'node',
      args: ['server.js'],
      env: { PARALLEL_CODE_MCP_TOKEN: 't' },
    },
  },
};

let repo: string;
const configFile = () => path.join(repo, '.agents', 'mcp_config.json');
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-config-test-'));
  git('init', '-q');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('writeAntigravityMcpConfig', () => {
  it('writes the server where agy discovers it, private and out of git status', () => {
    writeAntigravityMcpConfig(repo, config);

    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8'))).toEqual(config);
    // Windows has no Unix permission bits; stat reports only 0o666 or 0o444.
    if (process.platform !== 'win32') expect(fs.statSync(configFile()).mode & 0o777).toBe(0o600);
    expect(git('status', '--porcelain')).toBe('');
  });

  it('keeps other servers in an existing untracked file', () => {
    fs.mkdirSync(path.join(repo, '.agents'));
    fs.writeFileSync(configFile(), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));

    writeAntigravityMcpConfig(repo, config);

    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).mcpServers).toEqual({
      other: { command: 'x' },
      ...config.mcpServers,
    });
  });

  it('refuses a tracked config, whose token a commit would publish', () => {
    fs.mkdirSync(path.join(repo, '.agents'));
    fs.writeFileSync(configFile(), '{}');
    git('add', '.agents/mcp_config.json');

    expect(() => writeAntigravityMcpConfig(repo, config)).toThrow(/tracked/);
    expect(fs.readFileSync(configFile(), 'utf8')).toBe('{}');
  });

  it('refuses to write when Git cannot say whether the file is tracked', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-config-nogit-'));
    try {
      expect(() => writeAntigravityMcpConfig(plain, config)).toThrow(/tracked/);
      expect(fs.existsSync(path.join(plain, '.agents'))).toBe(false);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('refuses a linked .agents directory', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-config-outside-'));
    try {
      fs.symlinkSync(outside, path.join(repo, '.agents'));
      expect(() => writeAntigravityMcpConfig(repo, config)).toThrow(/symbolic link/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
