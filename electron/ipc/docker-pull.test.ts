/**
 * Unit tests for the Docker image pre-pull resilience orchestrator.
 * Pure logic — Docker is fully faked, no network/subprocess/timers.
 */

import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireAgentImage,
  downloadAndLoadReleaseImage,
  ensureDockerImageAvailable,
  hostImageArch,
  parseSha256,
  releaseImageAssetName,
  releaseImageUrls,
} from './docker-pull.js';

const IMAGE = 'thunderockforge/forge-agent:latest';

/** Build a deps object with sensible fakes; override per test. */
function makeDeps(over: { present?: boolean[]; pullCodes?: number[]; signal?: AbortSignal }) {
  const present = [...(over.present ?? [])];
  const pullCodes = [...(over.pullCodes ?? [])];
  const status: string[] = [];
  const pull = vi.fn(async () => (pullCodes.length ? (pullCodes.shift() as number) : -1));
  const delay = vi.fn(async () => {});
  const imagePresent = vi.fn(async () => (present.length ? (present.shift() as boolean) : false));
  return {
    deps: {
      imagePresent,
      pull,
      delay,
      onStatus: (l: string) => status.push(l),
      signal: over.signal ?? new AbortController().signal,
    },
    status,
    pull,
    delay,
    imagePresent,
  };
}

describe('ensureDockerImageAvailable', () => {
  it('skips the pull entirely when the image is already cached locally', async () => {
    const { deps, pull } = makeDeps({ present: [true] });
    const res = await ensureDockerImageAvailable(IMAGE, deps);
    expect(res).toEqual({ ok: true, usedLocal: true });
    expect(pull).not.toHaveBeenCalled();
  });

  it('pulls once and succeeds when the image is missing', async () => {
    const { deps, pull } = makeDeps({ present: [false], pullCodes: [0] });
    const res = await ensureDockerImageAvailable(IMAGE, deps);
    expect(res).toEqual({ ok: true, usedLocal: false });
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('retries with backoff and succeeds on a later attempt', async () => {
    const { deps, pull, delay, status } = makeDeps({
      present: [false],
      pullCodes: [1, 0], // fail, then succeed
    });
    const res = await ensureDockerImageAvailable(IMAGE, deps, { maxAttempts: 3 });
    expect(res).toEqual({ ok: true, usedLocal: false });
    expect(pull).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
    expect(status.some((s) => /retry/i.test(s))).toBe(true);
  });

  it('gives up after maxAttempts when pulls keep failing and nothing is cached', async () => {
    const { deps, pull } = makeDeps({
      present: [false, false], // initial check + final fallback check
      pullCodes: [1, 1, 1],
    });
    const res = await ensureDockerImageAvailable(IMAGE, deps, { maxAttempts: 3 });
    expect(res).toEqual({ ok: false, reason: 'pull-failed' });
    expect(pull).toHaveBeenCalledTimes(3);
  });

  it('falls back to a locally cached copy when pulls fail but the image is present', async () => {
    const { deps } = makeDeps({
      present: [false, true], // missing up front, but present on the final fallback check
      pullCodes: [1, 1, 1],
    });
    const res = await ensureDockerImageAvailable(IMAGE, deps, { maxAttempts: 3 });
    expect(res).toEqual({ ok: true, usedLocal: true });
  });

  it('returns cancelled without pulling when aborted before start', async () => {
    const ac = new AbortController();
    ac.abort();
    const { deps, pull } = makeDeps({ present: [false], signal: ac.signal });
    const res = await ensureDockerImageAvailable(IMAGE, deps);
    expect(res).toEqual({ ok: false, reason: 'cancelled' });
    expect(pull).not.toHaveBeenCalled();
  });

  it('returns cancelled when aborted during a pull', async () => {
    const ac = new AbortController();
    const { deps } = makeDeps({ present: [false], pullCodes: [-1], signal: ac.signal });
    // Abort as soon as the pull is attempted.
    deps.pull = vi.fn(async () => {
      ac.abort();
      return -1;
    });
    const res = await ensureDockerImageAvailable(IMAGE, deps, { maxAttempts: 3 });
    expect(res).toEqual({ ok: false, reason: 'cancelled' });
  });
});

/** Deps for acquireAgentImage; `present` feeds sequential imagePresent() answers. */
function makeAcquireDeps(over: {
  present?: boolean[];
  pullCodes?: number[];
  downloadRelease?: (signal: AbortSignal) => Promise<boolean>;
  localBuild?: (signal: AbortSignal) => Promise<boolean>;
  signal?: AbortSignal;
}) {
  const present = [...(over.present ?? [])];
  const pullCodes = [...(over.pullCodes ?? [])];
  const status: string[] = [];
  const deps = {
    imagePresent: vi.fn(async () => (present.length ? (present.shift() as boolean) : false)),
    pull: vi.fn(async () => (pullCodes.length ? (pullCodes.shift() as number) : -1)),
    delay: vi.fn(async () => {}),
    onStatus: (l: string) => status.push(l),
    signal: over.signal ?? new AbortController().signal,
    downloadRelease: over.downloadRelease,
    localBuild: over.localBuild,
  };
  return { deps, status };
}

describe('acquireAgentImage', () => {
  it('returns the pull result and never touches fallbacks when the pull succeeds', async () => {
    const downloadRelease = vi.fn(async () => true);
    const localBuild = vi.fn(async () => true);
    const { deps } = makeAcquireDeps({
      present: [false],
      pullCodes: [0],
      downloadRelease,
      localBuild,
    });
    const res = await acquireAgentImage(IMAGE, deps);
    expect(res).toEqual({ ok: true, usedLocal: false });
    expect(downloadRelease).not.toHaveBeenCalled();
    expect(localBuild).not.toHaveBeenCalled();
  });

  it('downloads from the release when the pull fails, and reports a non-local success', async () => {
    const downloadRelease = vi.fn(async () => true);
    const localBuild = vi.fn(async () => true);
    const { deps } = makeAcquireDeps({
      present: [false, false, true], // initial miss, pull-fallback miss, present after download
      pullCodes: [1],
      downloadRelease,
      localBuild,
    });
    const res = await acquireAgentImage(IMAGE, deps, { maxAttempts: 1 });
    expect(res).toEqual({ ok: true, usedLocal: false });
    expect(downloadRelease).toHaveBeenCalledTimes(1);
    expect(localBuild).not.toHaveBeenCalled();
  });

  it('falls back to a local build when both the pull and the release download fail', async () => {
    const downloadRelease = vi.fn(async () => false);
    const localBuild = vi.fn(async () => true);
    const { deps } = makeAcquireDeps({
      present: [false, false, true], // initial miss, pull-fallback miss, present after build
      pullCodes: [1],
      downloadRelease,
      localBuild,
    });
    const res = await acquireAgentImage(IMAGE, deps, { maxAttempts: 1 });
    expect(res).toEqual({ ok: true, usedLocal: true });
    expect(downloadRelease).toHaveBeenCalledTimes(1);
    expect(localBuild).toHaveBeenCalledTimes(1);
  });

  it('returns pull-failed when every rung fails', async () => {
    const { deps } = makeAcquireDeps({
      present: [false, false],
      pullCodes: [1],
      downloadRelease: vi.fn(async () => false),
      localBuild: vi.fn(async () => false),
    });
    const res = await acquireAgentImage(IMAGE, deps, { maxAttempts: 1 });
    expect(res).toEqual({ ok: false, reason: 'pull-failed' });
  });

  it('degrades to a plain pull (pull-failed) when no fallbacks are supplied', async () => {
    const { deps } = makeAcquireDeps({ present: [false, false], pullCodes: [1] });
    const res = await acquireAgentImage(IMAGE, deps, { maxAttempts: 1 });
    expect(res).toEqual({ ok: false, reason: 'pull-failed' });
  });

  it('returns cancelled without running fallbacks when aborted up front', async () => {
    const ac = new AbortController();
    ac.abort();
    const downloadRelease = vi.fn(async () => true);
    const { deps } = makeAcquireDeps({ present: [false], signal: ac.signal, downloadRelease });
    const res = await acquireAgentImage(IMAGE, deps);
    expect(res).toEqual({ ok: false, reason: 'cancelled' });
    expect(downloadRelease).not.toHaveBeenCalled();
  });
});

describe('release image helpers', () => {
  it('maps Node process.arch to a release arch', () => {
    expect(hostImageArch('arm64')).toBe('arm64');
    expect(hostImageArch('x64')).toBe('amd64');
    expect(hostImageArch('ia32')).toBeNull();
  });

  it('names assets per arch', () => {
    expect(releaseImageAssetName('amd64')).toBe('forge-agent-amd64.tar.gz');
    expect(releaseImageAssetName('arm64')).toBe('forge-agent-arm64.tar.gz');
  });

  it('yields the pinned URL first, then latest', () => {
    const urls = releaseImageUrls({
      owner: 'thunderock',
      repo: 'forge',
      version: '1.2.3',
      arch: 'arm64',
    });
    expect(urls).toHaveLength(2);
    expect(urls[0].tarball).toContain('/releases/download/v1.2.3/forge-agent-arm64.tar.gz');
    expect(urls[0].checksum).toBe(`${urls[0].tarball}.sha256`);
    expect(urls[1].tarball).toContain('/releases/latest/download/forge-agent-arm64.tar.gz');
  });

  it('yields only the latest URL when no version is known', () => {
    const urls = releaseImageUrls({ owner: 'o', repo: 'r', version: '', arch: 'amd64' });
    expect(urls).toHaveLength(1);
    expect(urls[0].tarball).toContain('/releases/latest/download/');
  });

  it('parses a sha256sum line', () => {
    const hex = 'a'.repeat(64);
    expect(parseSha256(`${hex}  forge-agent-amd64.tar.gz`)).toBe(hex);
    expect(parseSha256('not-a-hash')).toBeNull();
  });
});

describe('downloadAndLoadReleaseImage', () => {
  const payload = new TextEncoder().encode('fake-image-tarball-bytes');
  const digest = crypto.createHash('sha256').update(Buffer.from(payload)).digest('hex');

  function bodyOf(bytes: Uint8Array) {
    return (async function* () {
      yield bytes;
    })();
  }
  function resp(opts: {
    status?: number;
    bytes?: Uint8Array;
    text?: string;
    len?: number;
  }): Response {
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (h: string) =>
          h.toLowerCase() === 'content-length' && opts.len ? String(opts.len) : null,
      },
      text: async () => opts.text ?? '',
      body: opts.bytes ? bodyOf(opts.bytes) : null,
    } as unknown as Response;
  }
  const target = { owner: 'thunderock', repo: 'forge', version: '1.2.3', arch: 'amd64' as const };

  it('downloads, verifies the checksum, and docker-loads the image', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('.sha256')
        ? resp({ text: `${digest}  forge-agent-amd64.tar.gz` })
        : resp({ bytes: payload, len: payload.length }),
    );
    const dockerLoadFile = vi.fn(async () => 0);
    const ok = await downloadAndLoadReleaseImage(target, () => {}, new AbortController().signal, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dockerLoadFile,
    });
    expect(ok).toBe(true);
    expect(dockerLoadFile).toHaveBeenCalledTimes(1);
  });

  it('skips a 404 pinned release and succeeds from the latest release', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/download/v1.2.3/')) return resp({ status: 404 });
      if (url.endsWith('.sha256')) return resp({ status: 404 }); // latest has no checksum
      return resp({ bytes: payload, len: payload.length });
    });
    const dockerLoadFile = vi.fn(async () => 0);
    const ok = await downloadAndLoadReleaseImage(target, () => {}, new AbortController().signal, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dockerLoadFile,
    });
    expect(ok).toBe(true);
    expect(dockerLoadFile).toHaveBeenCalledTimes(1);
  });

  it('refuses to load on a checksum mismatch', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('.sha256')
        ? resp({ text: `${'0'.repeat(64)}  forge-agent-amd64.tar.gz` })
        : resp({ bytes: payload, len: payload.length }),
    );
    const dockerLoadFile = vi.fn(async () => 0);
    const ok = await downloadAndLoadReleaseImage(target, () => {}, new AbortController().signal, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      dockerLoadFile,
    });
    expect(ok).toBe(false);
    expect(dockerLoadFile).not.toHaveBeenCalled();
  });
});
