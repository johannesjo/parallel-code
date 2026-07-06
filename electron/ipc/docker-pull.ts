import { execFile, execFileSync, spawn as cpSpawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { once } from 'events';

/** Project images are built locally (forge-project:<hash>), never pulled from a registry. */
export const PROJECT_IMAGE_PREFIX = 'forge-project:';

interface EnsureImageDeps {
  /** Resolve true if an image with this tag is already present locally. */
  imagePresent: (image: string) => Promise<boolean>;
  /** Pull the image; resolve with the process exit code (0 = success). */
  pull: (image: string, signal: AbortSignal) => Promise<number>;
  /** Abortable sleep. */
  delay: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Emit a human-friendly status line to the terminal. */
  onStatus: (line: string) => void;
  signal: AbortSignal;
}

interface EnsureImageOptions {
  maxAttempts?: number;
  /** Backoff before retry N (index 0 = wait before 2nd attempt). Last value reused. */
  backoffMs?: number[];
}

export type EnsureImageResult =
  | { ok: true; usedLocal: boolean }
  | { ok: false; reason: 'cancelled' | 'pull-failed' };

/**
 * Ensure a registry image is available locally before `docker run`.
 *
 * Fast-paths when the image is already cached (no network). Otherwise pulls with
 * bounded retries + backoff so a transient Docker Hub blip doesn't hard-fail the
 * task, and falls back to any locally cached copy before giving up.
 */
export async function ensureDockerImageAvailable(
  image: string,
  deps: EnsureImageDeps,
  opts: EnsureImageOptions = {},
): Promise<EnsureImageResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoff = opts.backoffMs ?? [2000, 4000];

  if (deps.signal.aborted) return { ok: false, reason: 'cancelled' };

  // Already cached — `docker run` will use it, no network round-trip needed.
  if (await deps.imagePresent(image)) return { ok: true, usedLocal: true };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (deps.signal.aborted) return { ok: false, reason: 'cancelled' };
    deps.onStatus(
      attempt === 1
        ? `Pulling ${image} … (first run can take a few minutes)`
        : `Retrying pull (attempt ${attempt}/${maxAttempts}) …`,
    );

    const code = await deps.pull(image, deps.signal).catch(() => -1);
    if (deps.signal.aborted) return { ok: false, reason: 'cancelled' };
    if (code === 0) return { ok: true, usedLocal: false };

    if (attempt < maxAttempts) {
      const wait = backoff[Math.min(attempt - 1, backoff.length - 1)];
      deps.onStatus(`Pull failed — retrying in ${Math.round(wait / 1000)}s …`);
      await deps.delay(wait, deps.signal);
    }
  }

  // Retries exhausted — use any locally cached copy rather than fail outright
  // (e.g. a concurrent pull landed it, or an older image is good enough).
  if (await deps.imagePresent(image)) return { ok: true, usedLocal: true };

  return { ok: false, reason: 'pull-failed' };
}

/**
 * Synchronous existence check, used on the spawn fast-path so a cached image
 * still launches without deferring to an async tick. Bounded timeout; treats
 * any failure (incl. a hung daemon) as "not present" so we fall back to a pull.
 */
export function dockerImagePresentSync(image: string): boolean {
  try {
    const out = execFileSync(
      'docker',
      ['image', 'ls', '--filter', `reference=${image}`, '--format', '{{.ID}}'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return !!out.trim();
  } catch {
    return false;
  }
}

/** True if an image with this tag exists locally (existence only — no staleness check). */
export function dockerImagePresentByTag(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    // `docker image ls --filter reference=` works around the containerd store
    // breaking tag-based `docker image inspect`.
    execFile(
      'docker',
      ['image', 'ls', '--filter', `reference=${image}`, '--format', '{{.ID}}'],
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => resolve(!err && !!String(stdout).trim()),
    );
  });
}

/** Stream `docker pull <image>` output to `onData`; resolve with the exit code (-1 on spawn error/abort). */
export function pullDockerImage(
  image: string,
  onData: (text: string) => void,
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve) => {
    const child = cpSpawn('docker', ['pull', image], { signal });
    child.stdout?.on('data', (d: Buffer) => onData(d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => onData(d.toString('utf8')));
    child.on('error', () => resolve(-1)); // includes AbortError when signal fires
    child.on('close', (code) => resolve(code ?? -1));
  });
}

/** Promise that resolves after `ms`, or immediately if the signal aborts. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── Durable fallback: fetch the agent image from a GitHub release ────────────
// When the Docker daemon can't reach a registry, `docker pull` fails for ANY
// registry — a common failure when the daemon runs in a VM (Colima/Lima) whose
// virtual network the host's VPN doesn't route. The host process CAN reach GitHub,
// so we download the image tarball host-side and `docker load` it into the daemon
// over the local socket, which needs no VM egress at all.

export type ReleaseImageArch = 'amd64' | 'arm64';

/** Map a Node `process.arch` to the release-asset arch, or null if unsupported. */
export function hostImageArch(arch: string = process.arch): ReleaseImageArch | null {
  if (arch === 'arm64') return 'arm64';
  if (arch === 'x64') return 'amd64';
  return null;
}

/** Release-asset file name for an arch (matches the CI upload in release.yml). */
export function releaseImageAssetName(arch: ReleaseImageArch): string {
  return `forge-agent-${arch}.tar.gz`;
}

export interface ReleaseImageTarget {
  owner: string;
  repo: string;
  /** App version without a leading 'v' (e.g. "1.11.0"); empty skips the pinned URL. */
  version: string;
  arch: ReleaseImageArch;
}

/** Candidate asset URLs: the version-pinned release first, then the repo's latest. */
export function releaseImageUrls(t: ReleaseImageTarget): { tarball: string; checksum: string }[] {
  const base = `https://github.com/${t.owner}/${t.repo}/releases`;
  const name = releaseImageAssetName(t.arch);
  const urls: { tarball: string; checksum: string }[] = [];
  if (t.version) {
    urls.push({
      tarball: `${base}/download/v${t.version}/${name}`,
      checksum: `${base}/download/v${t.version}/${name}.sha256`,
    });
  }
  urls.push({
    tarball: `${base}/latest/download/${name}`,
    checksum: `${base}/latest/download/${name}.sha256`,
  });
  return urls;
}

/** Parse a `sha256sum`-style "<hex>  filename" line; return the lowercase digest or null. */
export function parseSha256(text: string): string | null {
  const m = text.trim().match(/^([a-f0-9]{64})\b/i);
  return m ? m[1].toLowerCase() : null;
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

type ByteStream = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

async function* streamChunks(body: ByteStream): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function fetchChecksum(
  doFetch: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const res = await doFetch(url, { signal, redirect: 'follow' });
    if (!res.ok) return null;
    return parseSha256(await res.text());
  } catch {
    return null;
  }
}

/** Stream `docker load -i <file>`; resolve with the exit code (-1 on spawn error/abort). */
function dockerLoadFromFile(
  file: string,
  onData: (text: string) => void,
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve) => {
    const child = cpSpawn('docker', ['load', '-i', file], { signal });
    child.stdout?.on('data', (d: Buffer) => onData(d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => onData(d.toString('utf8')));
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
}

export interface DownloadLoadDeps {
  fetchImpl?: typeof fetch;
  dockerLoadFile?: (
    file: string,
    onData: (text: string) => void,
    signal: AbortSignal,
  ) => Promise<number>;
}

/**
 * Download the agent-image tarball host-side and `docker load` it into the daemon.
 * Verifies the published SHA-256 (when present) before trusting the load. Tries the
 * version-pinned release first, then the repo's latest release. Resolves true if the
 * image was loaded successfully.
 */
export async function downloadAndLoadReleaseImage(
  target: ReleaseImageTarget,
  onStatus: (line: string) => void,
  signal: AbortSignal,
  deps: DownloadLoadDeps = {},
): Promise<boolean> {
  const doFetch = deps.fetchImpl ?? fetch;
  const loadFile = deps.dockerLoadFile ?? dockerLoadFromFile;
  const asset = releaseImageAssetName(target.arch);

  for (const { tarball, checksum } of releaseImageUrls(target)) {
    if (signal.aborted) return false;
    const tmp = path.join(
      os.tmpdir(),
      `forge-agent-${target.arch}-${crypto.randomBytes(6).toString('hex')}.tar.gz`,
    );
    try {
      let res: Response;
      try {
        res = await doFetch(tarball, { signal, redirect: 'follow' });
      } catch (err) {
        if (signal.aborted) return false;
        onStatus(`Download error: ${String(err)}`);
        continue;
      }
      if (res.status === 404) continue; // pinned release/asset missing — try the next candidate
      if (!res.ok || !res.body) {
        onStatus(`GitHub returned ${res.status} for ${asset}`);
        continue;
      }

      const total = Number(res.headers.get('content-length')) || 0;
      onStatus(
        `Downloading ${asset}${total ? ` (${humanBytes(total)})` : ''} from GitHub release …`,
      );

      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(tmp);
      let downloaded = 0;
      let lastPct = -1;
      try {
        for await (const chunk of streamChunks(res.body as ByteStream)) {
          if (signal.aborted) throw new Error('aborted');
          const buf = Buffer.from(chunk);
          hash.update(buf);
          downloaded += buf.length;
          if (!out.write(buf)) await once(out, 'drain');
          if (total) {
            const pct = Math.floor((downloaded / total) * 100);
            if (pct >= lastPct + 10) {
              lastPct = pct;
              onStatus(`  ${pct}%  (${humanBytes(downloaded)} / ${humanBytes(total)})`);
            }
          }
        }
        await new Promise<void>((resolve, reject) =>
          out.end((err?: Error | null) => (err ? reject(err) : resolve())),
        );
      } catch (err) {
        out.destroy();
        if (signal.aborted) return false;
        onStatus(`Download interrupted: ${String(err)}`);
        continue;
      }

      // Verify integrity before trusting the tarball (skip only if unpublished).
      const expected = await fetchChecksum(doFetch, checksum, signal);
      if (signal.aborted) return false;
      if (expected && hash.digest('hex') !== expected) {
        onStatus(`Checksum mismatch for ${asset} — refusing to load.`);
        continue;
      }

      onStatus(`Loading ${asset} into Docker (docker load) …`);
      const code = await loadFile(tmp, onStatus, signal);
      if (signal.aborted) return false;
      if (code === 0) {
        onStatus('Loaded agent image from GitHub release.');
        return true;
      }
      onStatus(`docker load failed (exit ${code}).`);
    } finally {
      fs.promises.unlink(tmp).catch(() => {});
    }
  }
  return false;
}

export interface AcquireImageDeps extends EnsureImageDeps {
  /** Download the image from the GitHub release and `docker load` it. True if loaded. */
  downloadRelease?: (signal: AbortSignal) => Promise<boolean>;
  /** Build the bundled Dockerfile locally. True if built. */
  localBuild?: (signal: AbortSignal) => Promise<boolean>;
}

/**
 * Acquire an image with a layered fallback chain:
 *   cached → `docker pull` (retries) → GitHub-release download + `docker load` → local build.
 *
 * The pull runs in the daemon (fails when the daemon's VM has no egress); the release
 * download runs host-side and `docker load`s over the socket, so it survives an islanded
 * VM. Local build is a last resort (it needs VM egress too). Only the default agent image
 * supplies `downloadRelease`/`localBuild`; other images degrade to a plain pull.
 */
export async function acquireAgentImage(
  image: string,
  deps: AcquireImageDeps,
  opts: EnsureImageOptions = {},
): Promise<EnsureImageResult> {
  const pullRes = await ensureDockerImageAvailable(image, deps, opts);
  if (pullRes.ok) return pullRes;
  if (deps.signal.aborted || pullRes.reason === 'cancelled')
    return { ok: false, reason: 'cancelled' };

  if (deps.downloadRelease) {
    deps.onStatus('Registry unreachable — fetching the agent image from GitHub instead …');
    const loaded = await deps.downloadRelease(deps.signal).catch(() => false);
    if (deps.signal.aborted) return { ok: false, reason: 'cancelled' };
    if (loaded && (await deps.imagePresent(image))) return { ok: true, usedLocal: false };
  }

  if (deps.localBuild) {
    deps.onStatus('Building the agent image locally from the bundled Dockerfile …');
    const built = await deps.localBuild(deps.signal).catch(() => false);
    if (deps.signal.aborted) return { ok: false, reason: 'cancelled' };
    if (built && (await deps.imagePresent(image))) return { ok: true, usedLocal: true };
  }

  return { ok: false, reason: 'pull-failed' };
}
