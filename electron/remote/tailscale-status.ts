/**
 * Reads this computer's Tailscale state so Connect Phone can say why the
 * Tailscale option is unavailable and link to Tailscale's own login page.
 * Read-only by design: logging in (`tailscale up`) needs root on Linux and
 * changes system networking, so that stays in Tailscale's own tools.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { TailscaleState } from '../ipc/shared-types.js';

const exec = promisify(execFile);
const STATUS_TIMEOUT_MS = 5_000;

/** PATH first; GUI installs keep the CLI outside PATH on macOS and Windows. */
function tailscaleCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin')
    return ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  if (platform === 'win32') return ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe'];
  return ['tailscale'];
}

/** Maps `tailscale status --json` output to the state Connect Phone explains. */
export function tailscaleStateFromStatus(status: unknown): TailscaleState {
  const s = (typeof status === 'object' && status !== null ? status : {}) as {
    BackendState?: unknown;
    AuthURL?: unknown;
  };
  switch (s.BackendState) {
    case 'Running':
      return { state: 'running' };
    case 'NeedsLogin': {
      // Opened in the user's browser, so only ever an https link.
      const url =
        typeof s.AuthURL === 'string' && s.AuthURL.startsWith('https://') ? s.AuthURL : null;
      return { state: 'needs-login', loginUrl: url };
    }
    case 'NeedsMachineAuth':
      return { state: 'needs-approval' };
    case 'Stopped':
      return { state: 'stopped' };
    default:
      return { state: 'unknown' };
  }
}

type RunStatus = (bin: string) => Promise<string>;

const runStatus: RunStatus = async (bin) =>
  (await exec(bin, ['status', '--json'], { timeout: STATUS_TIMEOUT_MS })).stdout;

/** Stdout of a failed run, since some CLI versions print the status yet exit non-zero. */
function stdoutOf(err: unknown): string {
  const stdout = (err as { stdout?: unknown }).stdout;
  return typeof stdout === 'string' ? stdout.trim() : '';
}

/** Tries each candidate CLI; a missing binary moves on, any other failure means the daemon is down. */
export async function readTailscaleState(
  run: RunStatus = runStatus,
  candidates: string[] = tailscaleCandidates(),
): Promise<TailscaleState> {
  for (const bin of candidates) {
    let stdout: string;
    try {
      stdout = await run(bin);
    } catch (err) {
      if ((err as { code?: unknown }).code === 'ENOENT') continue;
      stdout = stdoutOf(err);
      if (!stdout) return { state: 'not-running' };
    }
    try {
      return tailscaleStateFromStatus(JSON.parse(stdout) as unknown);
    } catch {
      // Older CLIs or odd output: fall back to the plain "Not detected" hint.
      return { state: 'unknown' };
    }
  }
  return { state: 'not-installed' };
}
