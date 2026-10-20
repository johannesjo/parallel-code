import { execFile } from 'child_process';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { resolveUserShell } from './user-shell.js';

// When launched from a .desktop file (e.g. AppImage), the environment is
// minimal — often just PATH=/usr/bin:/bin. Resolve the user's full
// login-interactive shell environment and merge it into process.env so
// spawned PTYs can find CLI tools (claude, codex, gemini, etc.) and
// inherit other expected variables (SSH_AGENT_LAUNCHER, KUBECONFIG, etc.).
//
// Uses -ilc (interactive + login) to source both .zprofile/.profile AND
// .zshrc/.bashrc, where version managers (nvm, volta, fnm) add to PATH.
// A perl one-liner dumps every env var as null-delimited key=value pairs,
// bounded by sentinel markers to isolate the data from noisy shell init.
//
// Trade-off: -i (interactive) triggers .zshrc side effects (compinit, conda,
// welcome messages). Login-only (-lc) would be quieter but would miss tools
// that are only added to PATH in .bashrc/.zshrc (e.g. nvm). We accept the
// side effects since the sentinel-based parsing discards all other output.
// Another trade-off: inheriting the *full* environment (rather than just PATH)
// can pull in large variables (certificates, tokens, kubeconfig). We set a
// generous maxBuffer and fall back to the original environment on failure.
//
// Skip vars that would alter Electron/Node runtime behavior if a user's shell
// rc sets them — those belong to our process, not the login shell.
const PROTECTED_ENV_KEYS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

const SENTINEL = '__PCODE_ENV__';

/** Merge the sentinel-delimited env dump from the login shell into `env`. */
export function applyLoginShellEnv(output: string, env: NodeJS.ProcessEnv): void {
  const startIdx = output.indexOf(SENTINEL);
  const endIdx = output.lastIndexOf(SENTINEL);
  if (startIdx === -1 || endIdx === -1 || startIdx === endIdx) return;

  const envBlock = output.slice(startIdx + SENTINEL.length, endIdx);
  for (const entry of envBlock.split('\0')) {
    if (!entry) continue;
    const eqIdx = entry.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = entry.slice(0, eqIdx);
    if (PROTECTED_ENV_KEYS.has(key)) continue;
    env[key] = entry.slice(eqIdx + 1);
  }
}

/**
 * Resolve the login shell environment into process.env without blocking the
 * main process (an interactive login shell takes ~0.5–1 s on a typical rc).
 * Never rejects: on failure the inherited environment stays in place.
 */
export function resolveLoginShellEnv(): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve();
  return new Promise((resolve) => {
    execFile(
      resolveUserShell(),
      [
        '-ilc',
        `printf '${SENTINEL}' && perl -e 'print "$_=$ENV{$_}\\0" for keys %ENV' && printf '${SENTINEL}'`,
      ],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) console.warn('[fixEnv] Failed to resolve login shell environment:', err);
        else applyLoginShellEnv(stdout, process.env);
        resolve();
      },
    );
  });
}

/**
 * Hold every `ipcMain.handle` handler registered after this call until `ready`
 * settles. Handlers are what spawn PTYs, git and agent CLIs, and those need the
 * login shell's PATH; gating all of them (deny-by-default) keeps new handlers
 * safe without an allowlist. `ready` must never reject.
 */
export function gateIpcHandlersOn(ipcMain: IpcMain, ready: Promise<void>): void {
  type HandleListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handleProxy = ipcMain as unknown as {
    handle: (channel: string, listener: HandleListener) => void;
  };
  const original = handleProxy.handle.bind(ipcMain);
  let settled = false;
  void ready.then(() => {
    settled = true;
  });
  handleProxy.handle = (channel, listener) => {
    original(channel, (event, ...args) =>
      settled ? listener(event, ...args) : ready.then(() => listener(event, ...args)),
    );
  };
}
