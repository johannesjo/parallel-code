import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { appendCandidateLog, readCandidateLog } from './logs.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-document-logs-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('readCandidateLog', () => {
  it('reads a small log including Unicode and appended newlines', async () => {
    appendCandidateLog(root, 'run', 'candidate', 'Hello € 😀');
    appendCandidateLog(root, 'run', 'candidate', 'Next line\n');
    await expect(readCandidateLog(root, 'run', 'candidate')).resolves.toBe(
      'Hello € 😀\nNext line\n',
    );
  });

  it('reads only a bounded tail of a large file without corrupting Unicode', async () => {
    appendCandidateLog(root, 'run', 'candidate', '');
    const file = path.join(root, '.parallel', 'logs', 'run', 'candidate.log');
    const content = '😀'.repeat(1_600_000) + '!';
    const bytes = Buffer.from(content);
    const prefixBytes = 24_000_000;
    const writer = await fs.open(file, 'w');
    await writer.write(bytes, 0, bytes.length, prefixBytes);
    await writer.close();

    const handle = await fs.open(file, 'r');
    vi.spyOn(fs, 'open').mockResolvedValueOnce(handle);
    const read = vi.spyOn(handle, 'read');
    const readFile = vi.spyOn(handle, 'readFile');
    const close = vi.spyOn(handle, 'close');

    const result = await readCandidateLog(root, 'run', 'candidate');
    // An odd cap would begin on the low surrogate of the first retained emoji.
    expect(result).toBe('😀'.repeat(999_999) + '!');
    expect(result.length).toBeLessThanOrEqual(2_000_000);
    expect(result).not.toContain('\ufffd');
    expect(read).toHaveBeenCalledWith(
      expect.any(Buffer),
      0,
      6_000_003,
      prefixBytes + bytes.length - 6_000_003,
    );
    expect(readFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves the full character cap for three-byte characters', async () => {
    appendCandidateLog(root, 'run', 'candidate', '€'.repeat(2_000_100));
    await expect(readCandidateLog(root, 'run', 'candidate')).resolves.toBe(
      '€'.repeat(1_999_999) + '\n',
    );
  });

  it('returns an empty log for missing files and invalid ids', async () => {
    await expect(readCandidateLog(root, 'run', 'candidate')).resolves.toBe('');
    await expect(readCandidateLog(root, '../run', 'candidate')).resolves.toBe('');
    await expect(readCandidateLog(root, 'run', null)).resolves.toBe('');
  });

  it('closes the file and returns an empty log if reading fails', async () => {
    appendCandidateLog(root, 'run', 'candidate', 'output');
    const handle = await fs.open(path.join(root, '.parallel', 'logs', 'run', 'candidate.log'), 'r');
    vi.spyOn(fs, 'open').mockResolvedValueOnce(handle);
    vi.spyOn(handle, 'read').mockRejectedValueOnce(new Error('read failed'));
    const close = vi.spyOn(handle, 'close');
    await expect(readCandidateLog(root, 'run', 'candidate')).resolves.toBe('');
    expect(close).toHaveBeenCalledOnce();
  });
});
