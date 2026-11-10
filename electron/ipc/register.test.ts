import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  branchNameArg,
  openExternalHttpUrl,
  optionalBaseBranch,
  projectRootArg,
  selectMcpJsonDir,
  selectMcpJsonFile,
  shouldWriteMcpJson,
  validateExternalHttpUrl,
  worktreePathArg,
} from './register.js';

describe('selectMcpJsonDir', () => {
  it('returns worktreePath when defined', () => {
    expect(selectMcpJsonDir('/worktrees/my-task', '/project')).toBe('/worktrees/my-task');
  });

  it('returns projectRoot when worktreePath is undefined', () => {
    expect(selectMcpJsonDir(undefined, '/project')).toBe('/project');
  });

  it('returns empty string when worktreePath is empty string (nullish coalescing only catches null/undefined)', () => {
    expect(selectMcpJsonDir('', '/project')).toBe('');
  });
});

describe('selectMcpJsonFile', () => {
  it('uses the workspace file Antigravity discovers, by executable name', () => {
    expect(selectMcpJsonFile('agy')).toBe('.agents/mcp_config.json');
    expect(selectMcpJsonFile('/usr/local/bin/agy')).toBe('.agents/mcp_config.json');
  });

  it('keeps .mcp.json for other agents', () => {
    expect(selectMcpJsonFile('claude')).toBe('.mcp.json');
    expect(selectMcpJsonFile(undefined)).toBe('.mcp.json');
  });
});

describe('shouldWriteMcpJson', () => {
  function withRepo(tracked: boolean, run: (root: string) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-json-tracked-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      fs.writeFileSync(path.join(root, '.mcp.json'), '{}');
      if (tracked) execFileSync('git', ['add', '.mcp.json'], { cwd: root });
      run(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('writes an untracked .mcp.json', () => {
    withRepo(false, (root) => {
      expect(shouldWriteMcpJson(root, false)).toBe(true);
      expect(shouldWriteMcpJson(root, true)).toBe(true);
    });
  });

  it('skips a tracked .mcp.json when a launch flag already carries the config', () => {
    withRepo(true, (root) => expect(shouldWriteMcpJson(root, false)).toBe(false));
  });

  it('refuses a tracked .mcp.json the agent needs, whose token a commit would publish', () => {
    withRepo(true, (root) => expect(() => shouldWriteMcpJson(root, true)).toThrow(/tracked/));
  });

  it('skips the file outside a repository unless the agent needs it, then refuses', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-json-no-repo-'));
    // A TMPDIR inside a checkout would otherwise make Git find that repository.
    vi.stubEnv('GIT_CEILING_DIRECTORIES', path.dirname(plain));
    try {
      expect(shouldWriteMcpJson(plain, false)).toBe(false);
      expect(() => shouldWriteMcpJson(plain, true)).toThrow(/tracked/);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('validateExternalHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(validateExternalHttpUrl('https://example.com/path?q=1')).toBe(
      'https://example.com/path?q=1',
    );
    expect(validateExternalHttpUrl('http://example.com/')).toBe('http://example.com/');
  });

  it('normalizes protocol and host casing', () => {
    expect(validateExternalHttpUrl('HTTPS://EXAMPLE.COM/pr/1')).toBe('https://example.com/pr/1');
  });

  it('rejects non-web protocols', () => {
    expect(() => validateExternalHttpUrl('file:///etc/passwd')).toThrow(
      'url must use http or https',
    );
    expect(() => validateExternalHttpUrl('javascript:alert(1)')).toThrow(
      'url must use http or https',
    );
  });

  it('rejects invalid and non-string values', () => {
    expect(() => validateExternalHttpUrl('not a url')).toThrow('url must be a valid URL');
    expect(() => validateExternalHttpUrl(undefined)).toThrow('url must be a string');
  });
});

describe('Git IPC argument helpers', () => {
  it('returns validated absolute paths', () => {
    expect(projectRootArg({ projectRoot: '/repo' })).toBe('/repo');
    expect(worktreePathArg({ worktreePath: '/repo/.worktrees/task' })).toBe(
      '/repo/.worktrees/task',
    );
  });

  it('rejects invalid absolute path fields', () => {
    expect(() => projectRootArg({ projectRoot: 'relative' })).toThrow(
      'projectRoot must be absolute',
    );
    expect(() => worktreePathArg({ worktreePath: '/tmp/../repo' })).toThrow(
      'worktreePath must not contain ".."',
    );
  });

  it('normalizes optional baseBranch using existing Git handler semantics', () => {
    expect(optionalBaseBranch({})).toBeUndefined();
    expect(optionalBaseBranch({ baseBranch: '' })).toBeUndefined();
    expect(optionalBaseBranch({ baseBranch: 'feature/base' })).toBe('feature/base');
  });

  it('rejects invalid branch fields', () => {
    expect(() => branchNameArg({ branchName: '../main' })).toThrow('branchName');
    expect(() => optionalBaseBranch({ baseBranch: '../main' })).toThrow('baseBranch');
  });
});

describe('openExternalHttpUrl', () => {
  it('opens the normalized URL', async () => {
    const opened: string[] = [];

    await openExternalHttpUrl('HTTPS://EXAMPLE.COM/pr/1', async (url) => {
      opened.push(url);
    });

    expect(opened).toEqual(['https://example.com/pr/1']);
  });

  it('does not call the opener for invalid URLs', async () => {
    const opened: string[] = [];

    await expect(
      openExternalHttpUrl('file:///etc/passwd', async (url) => {
        opened.push(url);
      }),
    ).rejects.toThrow('url must use http or https');

    expect(opened).toEqual([]);
  });

  it('does not include the URL in opener failure errors', async () => {
    await expect(
      openExternalHttpUrl('https://example.com/?token=secret', async (url) => {
        throw new Error(`OS refused ${url}`);
      }),
    ).rejects.toThrow('Failed to open external URL');
  });
});
