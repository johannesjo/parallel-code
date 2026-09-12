import * as childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendGitInfoExcludeBlocks } from './git-exclude.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

describe('batched Git exclusions', () => {
  let dir: string;
  let excludePath: string;
  const patterns = ['/.kimi-code/mcp.json', '/.kimi-code/.parallel-code-atomic-*.tmp'];
  const blocks = patterns.map((marker) => ({ marker, block: `${marker}\n` }));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-exclude-batch-'));
    childProcess.execFileSync('git', ['init', '-q', dir]);
    excludePath = path.join(dir, '.git/info/exclude');
    vi.mocked(childProcess.execFileSync).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(['', '/.kimi-code/mcp.json\n', '/.kimi-code/.parallel-code-atomic-*.tmp\n'])(
    'resolves and reads once and appends only missing patterns after %j',
    (existing) => {
      fs.writeFileSync(excludePath, existing);
      const read = vi.spyOn(fs, 'readFileSync');
      const append = vi.spyOn(fs, 'appendFileSync');
      expect(appendGitInfoExcludeBlocks(dir, blocks)).toBe('appended');
      expect(childProcess.execFileSync).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledTimes(1);
      expect(append).toHaveBeenCalledTimes(1);
      const written = append.mock.calls[0][1];
      for (const pattern of patterns) {
        expect(String(written).includes(pattern)).toBe(!existing.includes(pattern));
      }
      for (const file of ['.kimi-code/mcp.json', '.kimi-code/.parallel-code-atomic-test.tmp']) {
        expect(() =>
          childProcess.execFileSync('git', ['check-ignore', '-q', file], { cwd: dir }),
        ).not.toThrow();
      }
      append.mockClear();
      expect(appendGitInfoExcludeBlocks(dir, blocks)).toBe('present');
      expect(append).not.toHaveBeenCalled();
    },
  );

  it('recognizes Git-normalized existing lines without rewriting them', () => {
    const existing = `${patterns[0]}  \r\n${patterns[1]}\r\n# user rule\n/user-data\n`;
    fs.writeFileSync(excludePath, existing);
    const append = vi.spyOn(fs, 'appendFileSync');
    expect(appendGitInfoExcludeBlocks(dir, blocks)).toBe('present');
    expect(append).not.toHaveBeenCalled();
    expect(fs.readFileSync(excludePath, 'utf8')).toBe(existing);
  });

  it('creates a missing exclude file with both entries', () => {
    fs.unlinkSync(excludePath);
    expect(appendGitInfoExcludeBlocks(dir, blocks)).toBe('appended');
    expect(fs.readFileSync(excludePath, 'utf8')).toBe(patterns.join('\n') + '\n');
  });

  it.each(['', '.kimi-code/'])('keeps %j exclusions root-anchored in real Git', (prefix) => {
    const files = [`${prefix}mcp.json`, `${prefix}.parallel-code-atomic-test.tmp`];
    if (!prefix) files[0] = '.mcp.json';
    const rules = [`/${files[0]}`, `/${prefix}.parallel-code-atomic-*.tmp`];
    expect(
      appendGitInfoExcludeBlocks(
        dir,
        rules.map((marker) => ({ marker, block: marker })),
      ),
    ).toBe('appended');
    for (const file of files) {
      expect(childProcess.spawnSync('git', ['check-ignore', '-q', file], { cwd: dir }).status).toBe(
        0,
      );
      expect(
        childProcess.spawnSync('git', ['check-ignore', '-q', `nested/${file}`], { cwd: dir })
          .status,
      ).toBe(1);
    }
  });

  it('reports only the missing pattern when its append fails', () => {
    fs.writeFileSync(excludePath, blocks[0].block);
    const error = new Error('append denied');
    vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => {
      throw error;
    });
    const onError = vi.fn();
    expect(appendGitInfoExcludeBlocks(dir, blocks, onError)).toBe('failed');
    expect(onError).toHaveBeenCalledWith(error, [patterns[1]]);
    expect(fs.readFileSync(excludePath, 'utf8')).toBe(blocks[0].block);
  });

  it('fails without writing when the exclude file cannot be read', () => {
    const error = Object.assign(new Error('read denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw error;
    });
    const append = vi.spyOn(fs, 'appendFileSync');
    const onError = vi.fn();
    expect(appendGitInfoExcludeBlocks(dir, blocks, onError)).toBe('failed');
    expect(onError).toHaveBeenCalledWith(error, patterns);
    expect(append).not.toHaveBeenCalled();
  });

  it('does not read or write if Git cannot resolve the common directory', () => {
    vi.mocked(childProcess.execFileSync).mockImplementationOnce(() => {
      throw new Error('git timeout');
    });
    const read = vi.spyOn(fs, 'readFileSync');
    const append = vi.spyOn(fs, 'appendFileSync');
    expect(appendGitInfoExcludeBlocks(dir, blocks)).toBe('missing');
    expect(read).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});
