import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promisify } from 'util';

vi.mock('child_process', () => {
  const mockExecFile = vi.fn();
  (mockExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: unknown,
    args: unknown,
    opts: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      mockExecFile(file, args, opts, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  return { execFile: mockExecFile };
});

import { execFile } from 'child_process';
import { pickRepoRemotes, resolvePrCheckout } from './pr-checkout.js';

type Callback = (err: Error | null, stdout: string, stderr: string) => void;
const mockExec = execFile as unknown as ReturnType<typeof vi.fn>;

function stub(pr: Record<string, unknown>, fetchedSha: string, remotes = ''): string[][] {
  const calls: string[][] = [];
  mockExec.mockImplementation((file: string, args: string[], _opts: unknown, cb: Callback) => {
    calls.push([file, ...args]);
    if (file === 'gh') return cb(null, JSON.stringify(pr), '');
    if (args[0] === 'rev-parse') return cb(null, `${fetchedSha}\n`, '');
    if (args[0] === 'remote') return cb(null, remotes, '');
    cb(null, '', '');
  });
  return calls;
}

const openPr = {
  url: 'https://github.com/o/r/pull/5',
  state: 'OPEN',
  headRefName: 'feature/x',
  headRefOid: 'abc',
  baseRefName: 'main',
  isCrossRepository: false,
};

beforeEach(() => {
  mockExec.mockReset();
});

describe('resolvePrCheckout', () => {
  it('fetches the PR head ref and returns the verified commit', async () => {
    const calls = stub(openPr, 'abc');
    await expect(resolvePrCheckout('/repo', 5)).resolves.toEqual({
      headSha: 'abc',
      headRefName: 'feature/x',
      baseRefName: 'main',
      isCrossRepository: false,
      url: 'https://github.com/o/r/pull/5',
      remote: 'origin',
    });
    expect(calls).toContainEqual(['git', 'fetch', '--no-tags', 'origin', 'refs/pull/5/head']);
  });

  it('fetches from the remote that points to the PR repo when origin is a fork', async () => {
    const remotes = [
      'origin\tgit@github.com:me/r.git (fetch)',
      'origin\tgit@github.com:me/r.git (push)',
      'upstream\thttps://github.com/o/r.git (fetch)',
      'upstream\thttps://github.com/o/r.git (push)',
    ].join('\n');
    const calls = stub(openPr, 'abc', remotes);
    expect((await resolvePrCheckout('/repo', 5)).remote).toBe('upstream');
    expect(calls).toContainEqual(['git', 'fetch', '--no-tags', 'upstream', 'refs/pull/5/head']);
  });

  it('selects the enterprise remote instead of the same repo on github.com', async () => {
    const remotes = [
      'origin\thttps://github.com/o/r.git (fetch)',
      'enterprise\tgit@code.acme.test:o/r.git (fetch)',
    ].join('\n');
    const calls = stub({ ...openPr, url: 'https://code.acme.test/o/r/pull/5' }, 'abc', remotes);
    expect((await resolvePrCheckout('/repo', 5)).remote).toBe('enterprise');
    expect(calls).toContainEqual(['git', 'fetch', '--no-tags', 'enterprise', 'refs/pull/5/head']);
  });

  it.each([
    'https://code.acme.test:8443/o/r.git',
    'git@CODE.Acme.TEST:o/r.git',
    'ssh://git@CODE.Acme.TEST:2222/o/r.git',
  ])('matches a custom-port enterprise PR to %s', async (remoteUrl) => {
    const remotes = [
      'origin\thttps://code.acme.test/o/r.git (fetch)',
      `upstream\t${remoteUrl} (fetch)`,
    ].join('\n');
    stub({ ...openPr, url: 'https://code.acme.test:8443/o/r/pull/5' }, 'abc', remotes);
    expect((await resolvePrCheckout('/repo', 5)).remote).toBe('upstream');
  });

  it('refuses a fetched commit that is not the PR head', async () => {
    stub(openPr, 'other');
    await expect(resolvePrCheckout('/repo', 5)).rejects.toThrow(/does not match/);
  });

  it('refuses closed PRs before fetching', async () => {
    const calls = stub({ ...openPr, state: 'MERGED' }, 'abc');
    await expect(resolvePrCheckout('/repo', 5)).rejects.toThrow(/not open/);
    expect(calls.some((c) => c[0] === 'git')).toBe(false);
  });

  it('withholds head branch names git would misread', async () => {
    stub({ ...openPr, headRefName: '--upload-pack=x' }, 'abc');
    expect((await resolvePrCheckout('/repo', 5)).headRefName).toBeNull();
  });
});

describe('pickRepoRemotes', () => {
  const ref = { host: 'github.com', owner: 'O', repo: 'r' };

  it('matches https, scp-style and ssh URLs case-insensitively', () => {
    const out = [
      'a\thttps://github.com/o/r (fetch)',
      'b\tgit@github.com:o/R.git (fetch)',
      'c\tssh://git@github.com/o/r.git (fetch)',
      'd\tssh://git@github.com:22/o/r.git (fetch)',
    ].join('\n');
    expect(pickRepoRemotes(out, ref)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('ignores other repos, look-alike hosts and option-like names', () => {
    const out = [
      'fork\thttps://github.com/me/r (fetch)',
      'prefix\thttps://github.com/o/r2 (fetch)',
      'evil\thttps://notgithub.com/o/r (fetch)',
      'path\thttps://evil.com/github.com/o/r (fetch)',
      '-x\thttps://github.com/o/r (fetch)',
    ].join('\n');
    expect(pickRepoRemotes(out, ref)).toEqual([]);
  });
});
